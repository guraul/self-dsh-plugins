// token-sync 单测（self-dsh-plugins#202）
// 只测纯函数与固定 fixture；不读真实用户数据、不发网络请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enumerateDays, targetDays } from './collect.mjs';
import { batchRows, parseEnvFile, MAX_BATCH_ROWS } from './upload.mjs';
import { shanghaiDay } from './sources/codebuddy.mjs';
import { collectCodebuddy } from './sources/codebuddy.mjs';

test('targetDays: --date 优先，否则最近 N 天且不含今天', () => {
  const now = Date.parse('2026-11-01T12:00:00+08:00');
  assert.deepEqual(targetDays({ date: '2026-10-30', days: 3 }, now), ['2026-10-30']);
  assert.deepEqual(targetDays({ date: null, days: 2 }, now), ['2026-10-31', '2026-10-30']);
  assert.deepEqual(targetDays({ date: null, days: 1 }, now), ['2026-10-31']);
});

test('shanghaiDay: 按北京时区切日（UTC 15:59 → 次日 23:59 仍属当天）', () => {
  // 2026-10-29T15:59Z = 北京 2026-10-29 23:59
  assert.equal(shanghaiDay(Date.parse('2026-10-29T15:59:00Z')), '2026-10-29');
  // 2026-10-29T16:00Z = 北京 2026-10-30 00:00
  assert.equal(shanghaiDay(Date.parse('2026-10-29T16:00:00Z')), '2026-10-30');
});

test('batchRows: 按 (source, usage_date) 分组且每批不超过上限', () => {
  const rows = [];
  for (let i = 0; i < MAX_BATCH_ROWS + 10; i += 1) {
    rows.push({ source: 'dsh', usage_date: '2026-10-31', total_tokens: 1 });
  }
  rows.push({ source: 'codebuddy', usage_date: '2026-10-31', total_tokens: 1 });

  const batches = batchRows(rows);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((b) => b.source), ['dsh', 'dsh', 'codebuddy']);
  assert.equal(batches[0].rows.length, MAX_BATCH_ROWS);
  assert.equal(batches[1].rows.length, 10);
  assert.equal(batches[2].rows.length, 1);
});

test('batchRows: 同一次运行里两天的数据被拆成两批，各自带自己的日期', () => {
  const rows = [
    { source: 'dsh', usage_date: '2026-10-30', total_tokens: 1 },
    { source: 'dsh', usage_date: '2026-10-31', total_tokens: 1 },
    { source: 'dsh', usage_date: '2026-10-30', total_tokens: 1 },
    { source: 'codebuddy', usage_date: '2026-10-30', total_tokens: 1 },
  ];
  const batches = batchRows(rows);
  assert.equal(batches.length, 3);
  const labels = batches.map((b) => `${b.source}@${b.usage_date}:${b.rows.length}`).sort();
  assert.deepEqual(labels, ['codebuddy@2026-10-30:1', 'dsh@2026-10-30:2', 'dsh@2026-10-31:1']);
  for (const batch of batches) {
    for (const row of batch.rows) assert.equal(row.usage_date, batch.usage_date);
  }
});

test('parseEnvFile: 忽略注释与空行，剥引号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-sync-'));
  const file = path.join(dir, 'env');
  fs.writeFileSync(file, '# comment\n\nHOMEBASE_URL=https://example.test\nHOMEBASE_CA="/tmp/ca.pem"\n');
  const env = parseEnvFile(file);
  assert.equal(env.HOMEBASE_URL, 'https://example.test');
  assert.equal(env.HOMEBASE_CA, '/tmp/ca.pem');
  assert.deepEqual(parseEnvFile(path.join(dir, 'missing')), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('codebuddy: OpenAI 语义 —— input 扣掉缓存，total 含 reasoning', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-sync-cb-'));
  const traceDir = path.join(dir, '1234');
  fs.mkdirSync(traceDir, { recursive: true });
  const completion = [
    {
      id: 'cmpl-1',
      model: 'deepseek-v4.1-flash',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 900,
        prompt_tokens_details: { cached_tokens: 900 },
        completion_tokens_details: { reasoning_tokens: 7 },
      },
    },
  ];
  const lines = [
    JSON.stringify({ type: 'trace_start', trace: { traceId: 'tr-1', startedAt: '2026-10-30T04:00:00.000Z' } }),
    JSON.stringify({ type: 'span_end', span: { toolOutput: JSON.stringify(completion) } }),
    // 同 id 重复出现应被去重
    JSON.stringify({ type: 'span_end', span: { toolOutput: JSON.stringify(completion) } }),
  ];
  fs.writeFileSync(path.join(traceDir, 'trace_x.jsonl'), lines.join('\n') + '\n');

  const { rows, errors } = await collectCodebuddy({ tracesRoot: dir, days: ['2026-10-30'] });
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.input_tokens, 100);
  assert.equal(row.cache_read, 900);
  assert.equal(row.output_tokens, 50);
  assert.equal(row.reasoning_tokens, 7);
  assert.equal(row.total_tokens, 100 + 50 + 7 + 900);
  assert.equal(row.session_id, 'tr-1');
  assert.equal(row.source, 'codebuddy');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('codebuddy: 同一 trace 的多次调用合并成一行（否则服务端 UPSERT 会互相覆盖）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-sync-agg-'));
  const traceDir = path.join(dir, '5678');
  fs.mkdirSync(traceDir, { recursive: true });
  const mk = (id, prompt, out) => ({
    id,
    model: 'deepseek-v4.1-flash',
    usage: {
      prompt_tokens: prompt,
      completion_tokens: out,
      prompt_cache_hit_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  });
  const lines = [
    JSON.stringify({ type: 'trace_start', trace: { traceId: 'tr-agg', startedAt: '2026-10-30T04:00:00.000Z' } }),
    JSON.stringify({ type: 'span_end', span: { toolOutput: JSON.stringify([mk('c1', 100, 10)]) } }),
    JSON.stringify({ type: 'span_end', span: { toolOutput: JSON.stringify([mk('c2', 200, 20)]) } }),
  ];
  fs.writeFileSync(path.join(traceDir, 'trace_y.jsonl'), lines.join('\n') + '\n');

  const { rows } = await collectCodebuddy({ tracesRoot: dir, days: ['2026-10-30'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 'tr-agg');
  assert.equal(rows[0].calls, 2);
  assert.equal(rows[0].input_tokens, 300);
  assert.equal(rows[0].output_tokens, 30);
  assert.equal(rows[0].total_tokens, 330);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enumerateDays: 闭区间逐日展开', () => {
  assert.deepEqual(enumerateDays('2026-10-30', '2026-11-01'), ['2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepEqual(enumerateDays('2026-10-30', '2026-10-30'), ['2026-10-30']);
  // 跨月边界
  assert.deepEqual(enumerateDays('2026-10-31', '2026-11-01'), ['2026-10-31', '2026-11-01']);
  assert.throws(() => enumerateDays('2026-01-01', '2026-12-31', 10), /日期范围过大/);
});

test('targetDays: --date > --from/--to > --all > --days', () => {
  const now = Date.parse('2026-11-02T12:00:00+08:00');
  assert.deepEqual(targetDays({ date: '2026-10-30', from: '2026-10-01', to: '2026-10-05' }, now), ['2026-10-30']);
  assert.deepEqual(targetDays({ from: '2026-10-30', to: '2026-10-31' }, now), ['2026-10-30', '2026-10-31']);
  assert.deepEqual(targetDays({ all: true, allFrom: '2026-10-30', to: '2026-10-31' }, now), ['2026-10-30', '2026-10-31']);
  assert.deepEqual(targetDays({ days: 2 }, now), ['2026-11-01', '2026-10-31']);
  // 只给 from 时末端默认到昨天
  assert.deepEqual(targetDays({ from: '2026-10-31' }, now), ['2026-10-31', '2026-11-01']);
  assert.throws(() => targetDays({ from: '2026-11-02', to: '2026-10-30' }, now), /晚于/);
  assert.throws(() => targetDays({ all: true }, now), /最早日期/);
});
