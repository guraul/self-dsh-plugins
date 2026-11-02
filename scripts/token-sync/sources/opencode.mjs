// token-sync · opencode 侧采集（homebase#109 / self-dsh-plugins#202）
//
// 数据来源：`~/.local/share/opencode/opencode.db` 的 `message` 表。
// 用 Node 内置 `node:sqlite`（readOnly），不引入 native 依赖。
//
// 缓存语义（与 codebuddy 相反）：`tokens.input` 已是非缓存输入，
// `tokens.cache.read/write` 单独给，直接映射即可 —— 不要再去减。
//
// 历史：现库只保留 2026-10-29 起；更早的在 `~/backups/opencode-sessions-*/opencode.db`。
// 本脚本默认只读现库；`--include-backups` 时合并备份库（同主键后者覆盖前者）。
import fs from 'node:fs';
import path from 'node:path';

const SHANGHAI_OFFSET_SECONDS = 8 * 3600;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 候选库：现库 + （可选）备份库。 */
export function listOpencodeDbs(home = process.env.HOME ?? '', includeBackups = false) {
  const out = [];
  const live = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (fs.existsSync(live)) out.push(live);
  if (includeBackups) {
    const backups = path.join(home, 'backups');
    let dirs = [];
    try {
      dirs = fs.readdirSync(backups).filter((d) => d.startsWith('opencode-sessions-'));
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      const db = path.join(backups, dir, 'opencode.db');
      if (fs.existsSync(db)) out.push(db);
    }
  }
  return out;
}

// v2 现库（opencode ≥ 2）：assistant 消息在 session_message，usage 在 data.tokens。
const SQL_V2 = `
  SELECT
    date(json_extract(data, '$.time.created') / 1000, 'unixepoch', '+${SHANGHAI_OFFSET_SECONDS} seconds') AS usage_date,
    session_id,
    json_extract(data, '$.model.id')         AS model,
    json_extract(data, '$.model.providerID') AS provider,
    COUNT(*)                                                AS calls,
    COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)           AS input_tokens,
    COALESCE(SUM(json_extract(data, '$.tokens.output')), 0)          AS output_tokens,
    COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0)       AS reasoning_tokens,
    COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0)      AS cache_read,
    COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0)     AS cache_write,
    MIN(json_extract(data, '$.time.created')) AS first_at,
    MAX(json_extract(data, '$.time.created')) AS last_at
  FROM session_message
  WHERE type = 'assistant'
    AND json_extract(data, '$.error') IS NULL
    AND json_extract(data, '$.tokens') IS NOT NULL
  GROUP BY usage_date, session_id, model, provider
`;

// 旧库（opencode v1，备份目录里那种）：message 表，data 内含 role/modelID/tokens。
const SQL_V1 = `
  SELECT
    date(time_created / 1000, 'unixepoch', '+${SHANGHAI_OFFSET_SECONDS} seconds') AS usage_date,
    session_id,
    json_extract(data, '$.modelID')    AS model,
    json_extract(data, '$.providerID') AS provider,
    COUNT(*)                                            AS calls,
    COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)          AS input_tokens,
    COALESCE(SUM(json_extract(data, '$.tokens.output')), 0)         AS output_tokens,
    COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0)      AS reasoning_tokens,
    COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0)     AS cache_read,
    COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0)    AS cache_write,
    MIN(time_created) AS first_at,
    MAX(time_created) AS last_at
  FROM message
  WHERE json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.error') IS NULL
  GROUP BY usage_date, session_id, model, provider
`;

/**
 * @param {{ home?: string, includeBackups?: boolean, days?: string[] | null }} opts
 */
export async function collectOpencode(opts = {}) {
  const home = opts.home ?? process.env.HOME ?? '';
  const days = opts.days ? new Set(opts.days) : null;
  const errors = [];
  const rows = [];
  const dbs = listOpencodeDbs(home, opts.includeBackups === true);

  if (!dbs.length) {
    return { rows, errors: ['opencode: 未找到 opencode.db'], stats: { dbs: 0, rows: 0 } };
  }

  const { DatabaseSync } = await import('node:sqlite');
  const merged = new Map();

  for (const dbPath of dbs) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const hasV2 = db
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='session_message'")
        .get();
      const sql = hasV2 ? SQL_V2 : SQL_V1;
      const result = db.prepare(sql).all();
      for (const r of result) {
        if (!r.usage_date) continue;
        if (days && !days.has(r.usage_date)) continue;
        const model = r.model ?? 'unknown';
        const provider = r.provider ?? 'unknown';
        const key = [r.usage_date, r.session_id, model, provider].join('\u0000');
        const prev = merged.get(key);
        const total =
          num(r.input_tokens) + num(r.output_tokens) + num(r.reasoning_tokens) + num(r.cache_read) + num(r.cache_write);
        if (prev) {
          // 备份库可能覆盖现库同一天：取较大值（幂等重放，不累加）。
          if (total > prev.total_tokens) {
            prev.calls = num(r.calls);
            prev.input_tokens = num(r.input_tokens);
            prev.output_tokens = num(r.output_tokens);
            prev.reasoning_tokens = num(r.reasoning_tokens);
            prev.cache_read = num(r.cache_read);
            prev.cache_write = num(r.cache_write);
            prev.total_tokens = total;
            prev.first_at = num(r.first_at);
            prev.last_at = num(r.last_at);
          }
        } else {
          merged.set(key, {
            usage_date: r.usage_date,
            source: 'opencode',
            provider,
            model,
            session_id: r.session_id ?? 'unknown',
            root_session: null,
            calls: num(r.calls),
            input_tokens: num(r.input_tokens),
            output_tokens: num(r.output_tokens),
            reasoning_tokens: num(r.reasoning_tokens),
            cache_read: num(r.cache_read),
            cache_write: num(r.cache_write),
            total_tokens: total,
            first_at: num(r.first_at),
            last_at: num(r.last_at),
          });
        }
      }
    } catch (error) {
      errors.push(`opencode: ${path.basename(path.dirname(dbPath))}/${path.basename(dbPath)}: ${String(error?.message ?? error)}`);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  return { rows: [...merged.values()], errors, stats: { dbs: dbs.length, rows: merged.size } };
}

/** 最早一天（用于 --all 的起点）。库不存在或无数据时返回 null。 */
export async function earliestOpencodeDay(home = process.env.HOME ?? '') {
  const dbs = listOpencodeDbs(home, false);
  if (!dbs.length) return null;
  const { DatabaseSync } = await import('node:sqlite');
  let earliest = null;
  for (const dbPath of dbs) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const hasV2 = db
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='session_message'")
        .get();
      const sql = hasV2
        ? `SELECT MIN(date(json_extract(data,'$.time.created') / 1000, 'unixepoch', '+${SHANGHAI_OFFSET_SECONDS} seconds')) AS d
             FROM session_message WHERE type='assistant'`
        : `SELECT MIN(date(time_created / 1000, 'unixepoch', '+${SHANGHAI_OFFSET_SECONDS} seconds')) AS d FROM message`;
      const row = db.prepare(sql).get();
      if (row?.d && (!earliest || row.d < earliest)) earliest = row.d;
    } catch {
      // 单个库读不了就跳过
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return earliest;
}
