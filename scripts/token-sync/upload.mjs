// token-sync · 上传（homebase#109 / self-dsh-plugins#202）
//
// 分批 POST 到 homebase 的 `/api/internal/token-usage/ingest`。
// 用 node:https 而非 fetch：自签证书需要显式 `ca`，fetch 没有这个入口。
//
// 幂等由服务端保证（同主键覆盖），所以「重试整批」是安全的；
// 已成功的批次不会因为后面的批次失败而重发。
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

export const MAX_BATCH_ROWS = 500;

/** 把 rows 按 (source, usage_date) 分组、每批 ≤ limit。
 *
 * 必须带日期分组：`--days 2` 会把两天的行放进同一次运行，
 * 若只按 source 分组，整批只能有一个 usage_date 标签，台账就会错
 * （实测：dsh 70 行被记成单日）。行本身各自带日期，但台账要按天可查。
 */
export function batchRows(rows, limit = MAX_BATCH_ROWS) {
  const batches = [];
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.source}\u0000${row.usage_date}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += limit) {
      batches.push({ source: list[0].source, usage_date: list[0].usage_date, rows: list.slice(i, i + limit) });
    }
  }
  return batches;
}

function post(baseUrl, ca, token, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL('/api/internal/token-usage/ingest', baseUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body));
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        'x-internal-token': token,
      },
      timeout: timeoutMs,
      ...(isHttps && ca ? { ca } : {}),
    };
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{rows: object[], config: {url: string, token: string, ca?: string|null},
 *          retries?: number[], onBatch?: (info: object) => void}} args
 */
export async function uploadRows({ rows, config, retries = [30000, 120000, 300000], onBatch }) {
  const batches = batchRows(rows);
  const results = [];

  for (const batch of batches) {
    const usageDate = batch.usage_date ?? 'unknown';
    const batchId = `dsh-token-sync-${usageDate}-${batch.source}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const body = { batch_id: batchId, usage_date: usageDate, source: batch.source, rows: batch.rows };

    let lastError = null;
    let done = false;
    for (let attempt = 0; attempt <= retries.length; attempt += 1) {
      try {
        const res = await post(config.url, config.ca ?? null, config.token, body);
        if (res.status >= 200 && res.status < 300) {
          results.push({ batch_id: batchId, source: batch.source, usage_date: usageDate, status: res.status, body: res.text });
          onBatch?.({ batchId, source: batch.source, usageDate, rows: batch.rows.length, status: 'ok' });
          done = true;
          break;
        }
        lastError = new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
        // 4xx 是契约错误（鉴权/参数），重试没意义。
        if (res.status >= 400 && res.status < 500) break;
      } catch (error) {
        lastError = error;
      }
      if (attempt < retries.length) await sleep(retries[attempt]);
    }

    if (!done) {
      onBatch?.({ batchId, source: batch.source, usageDate, rows: batch.rows.length, status: 'failed', error: String(lastError?.message ?? lastError) });
      results.push({ batch_id: batchId, source: batch.source, usage_date: usageDate, status: 'failed', error: String(lastError?.message ?? lastError) });
    }
  }

  const failed = results.filter((r) => r.status === 'failed');
  return { results, failed };
}

/** 读取 KEY=VALUE 形式的 env 文件（忽略注释与空行）。 */
export function parseEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
