// token-sync · dsh 侧采集（homebase#109 / self-dsh-plugins#202）
//
// 数据来源两处，各取所长：
//   1. 投影缓存 `~/.dsh/storages/session_projcache/sessions/<id>.json` —
//      `rows.usagePanel.val` 里的 `byDay` 已经是「按天 × 模型」的四桶聚合，
//      由 DSH 框架增量折叠，口径与 UI 完全一致（不重新解析事件流）。
//      ⚠️ 必须同时遍历 `epochs[]` 与 `current`：压缩会把已折叠的段推进 epochs，
//      只读 current 会漏掉约 35% 的历史（本机实测：current 437 条、epochs 240 条）。
//   2. 会话文件首帧 `session.v4.jsonl.zstd` — 只为拿 header 的 `parentSession`，
//      用来填 `root_session`（zstd 首帧即 header，Node 的 zstdDecompressSync 正好只解首帧）。
//
// provider：投影缓存不含 request/header 的路由信息，统一记 "dsh"（表示「DSH 内的调用」），
// 避免与 opencode-go / codebuddy 这类外部执行方混在同一聚合里。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 建 sessionId → 会话文件路径的索引（只为读 header）。 */
function indexSessionHeaders(sessionsRoot) {
  const byId = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== 'session.v4.jsonl.zstd') continue;
      try {
        // 首帧就是 header；zstdDecompressSync 只解第一帧，正好够用。
        const header = JSON.parse(zlib.zstdDecompressSync(fs.readFileSync(full)).toString('utf8'));
        if (header && typeof header.id === 'string') byId.set(header.id, { header, file: full });
      } catch {
        // 坏文件跳过：采集不能因为一个会话不可读就整体失败。
      }
    }
  };
  walk(sessionsRoot);
  return byId;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * @param {{ home?: string, days?: string[] | null }} opts
 *   `days` 为 null 表示全部日期；否则只取这些日期。
 * @returns {Promise<{rows: Array<object>, errors: string[], stats: object}>}
 */
export async function collectDsh(opts = {}) {
  const home = opts.home ?? path.join(process.env.HOME ?? '', '.dsh');
  const projDir = path.join(home, 'storages', 'session_projcache', 'sessions');
  const sessionsRoot = path.join(home, 'sessions');
  const wanted = opts.days ? new Set(opts.days) : null;
  const errors = [];
  const rows = [];

  const headers = indexSessionHeaders(sessionsRoot);
  let files = [];
  try {
    files = fs.readdirSync(projDir).filter((f) => f.endsWith('.json'));
  } catch (error) {
    errors.push(`dsh: projcache 不可读 ${projDir}: ${String(error?.message ?? error)}`);
    return { rows, errors, stats: { sessions: 0, files: 0 } };
  }

  for (const file of files) {
    const sessionId = file.replace(/\.json$/, '');
    const root = readJson(path.join(projDir, file));
    const rowsNode = root?.record?.rows;
    const panel = rowsNode?.usagePanel?.val;
    if (!panel) continue;
    // 合并 epochs（压缩前的历史段）与 current（当前段）。
    const segments = [];
    if (Array.isArray(panel.epochs)) segments.push(...panel.epochs);
    if (panel.current) segments.push(panel.current);
    const dayModels = new Map(); // day -> Map(model -> buckets)
    for (const segment of segments) {
      const byDay = segment?.byDay;
      if (!byDay || typeof byDay !== 'object') continue;
      for (const [day, models] of Object.entries(byDay)) {
        if (!models || typeof models !== 'object') continue;
        const bucket = dayModels.get(day) ?? new Map();
        for (const [model, cells] of Object.entries(models)) {
          const prev = bucket.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
          const c = cells && typeof cells === 'object' ? cells : {};
          bucket.set(model, {
            input: prev.input + num(c.input),
            output: prev.output + num(c.output),
            cacheRead: prev.cacheRead + num(c.cacheRead),
            cacheWrite: prev.cacheWrite + num(c.cacheWrite),
            calls: prev.calls + num(c.calls),
          });
        }
        dayModels.set(day, bucket);
      }
    }
    if (!dayModels.size) continue;

    const header = headers.get(sessionId)?.header;
    const parent = typeof header?.parentSession === 'string' ? header.parentSession : null;
    const rootSession = parent ?? sessionId;

    for (const [day, modelMap] of dayModels) {
      if (wanted && !wanted.has(day)) continue;
      for (const [model, b] of modelMap) {
        const input = num(b.input);
        const output = num(b.output);
        const cacheRead = num(b.cacheRead);
        const cacheWrite = num(b.cacheWrite);
        const total = input + output + cacheRead + cacheWrite;
        if (total === 0) continue;
        rows.push({
          usage_date: day,
          source: 'dsh',
          provider: 'dsh',
          model,
          session_id: sessionId,
          root_session: rootSession,
          calls: num(b.calls),
          input_tokens: input,
          output_tokens: output,
          reasoning_tokens: 0,
          cache_read: cacheRead,
          cache_write: cacheWrite,
          total_tokens: total,
          first_at: num(header?.createdAt),
          last_at: num(header?.createdAt),
        });
      }
    }
  }

  return { rows, errors, stats: { sessions: files.length, files: files.length } };
}
