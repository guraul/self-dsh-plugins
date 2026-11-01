// token-sync · codebuddy 侧采集（homebase#109 / self-dsh-plugins#202）
//
// 数据来源：`~/.codebuddy/traces/<pid>/trace_*.jsonl` —— 每次 LLM 调用的完整记录。
// ⚠️ 只保留 `codebuddy.telemetry.retentionDays`（默认 7 天），
//    所以必须每天采；漏一天就永久缺失（projects/*.jsonl 只有约 1/3 带 usage，不能当完整源）。
//
// 缓存语义（关键，见 self-dsh-plugins#127）：OpenAI 风格 —— `prompt_tokens` 已包含缓存命中，
// 因此 input = prompt_cache_miss_tokens、cache_read = prompt_cache_hit_tokens，绝不能把
// inputTokens 直接当非缓存输入（会把 input 放大 ~80 倍）。
import fs from 'node:fs';
import path from 'node:path';

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 本地日期（Asia/Shanghai）→ YYYY-MM-DD */
export function shanghaiDay(epochMs) {
  const d = new Date(epochMs + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function listTraceFiles(root) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const full = path.join(root, dir.name);
    let files = [];
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) out.push(path.join(full, f));
  }
  return out;
}

/**
 * @param {{ tracesRoot?: string, days?: string[] | null }} opts
 * @returns {Promise<{rows: Array<object>, errors: string[], stats: object}>}
 */
export async function collectCodebuddy(opts = {}) {
  const root = opts.tracesRoot ?? path.join(process.env.HOME ?? '', '.codebuddy', 'traces');
  const wanted = opts.days ? new Set(opts.days) : null;
  const errors = [];
  const rows = [];
  const seen = new Set(); // completion id 去重：同一响应可能被多处引用
  const files = listTraceFiles(root);
  let calls = 0;

  for (const file of files) {
    let traceId = null;
    let startedAt = null;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      errors.push(`codebuddy: 读取失败 ${filenameOf(file)}: ${String(error?.message ?? error)}`);
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type === 'trace_start' && event.trace) {
        traceId = typeof event.trace.traceId === 'string' ? event.trace.traceId : traceId;
        const started = event.trace.startedAt;
        if (typeof started === 'string') {
          const ms = Date.parse(started);
          if (Number.isFinite(ms)) startedAt = ms;
        }
        continue;
      }
      const output = event?.span?.toolOutput;
      if (typeof output !== 'string' || !output.includes('prompt_tokens')) continue;
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const usage = item.usage;
        if (!usage || typeof usage !== 'object' || !usage.prompt_tokens) continue;
        const completionId = typeof item.id === 'string' ? item.id : null;
        if (completionId) {
          if (seen.has(completionId)) continue;
          seen.add(completionId);
        }
        const day = startedAt ? shanghaiDay(startedAt) : null;
        if (!day) continue;
        if (wanted && !wanted.has(day)) continue;

        const promptTokens = num(usage.prompt_tokens);
        const details = usage.prompt_tokens_details ?? {};
        // 缓存命中只有一处口径：先取 prompt_cache_hit_tokens，回退 details.cached_tokens。
        // input 必须用同一个值去减，否则 total 会与「prompt + completion」对不上。
        const cacheRead = num(usage.prompt_cache_hit_tokens) || num(details.cached_tokens);
        const input = Math.max(0, promptTokens - cacheRead);
        const outputTok = num(usage.completion_tokens);
        const completionDetails = usage.completion_tokens_details ?? {};
        const reasoning = num(completionDetails.reasoning_tokens);

        rows.push({
          usage_date: day,
          source: 'codebuddy',
          provider: 'codebuddy',
          model: typeof item.model === 'string' && item.model ? item.model : 'unknown',
          session_id: traceId ?? filenameOf(file),
          root_session: null,
          calls: 1,
          input_tokens: input,
          output_tokens: outputTok,
          reasoning_tokens: reasoning,
          cache_read: cacheRead,
          cache_write: 0,
          total_tokens: input + outputTok + reasoning + cacheRead,
          first_at: startedAt ?? 0,
          last_at: startedAt ?? 0,
        });
        calls += 1;
      }
    }
  }

  return { rows, errors, stats: { files: files.length, calls } };
}

function filenameOf(file) {
  return path.basename(path.dirname(file)) + '/' + path.basename(file);
}
