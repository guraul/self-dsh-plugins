#!/usr/bin/env node
/**
 * audit-subagents.mjs 的测试（node --test scripts/pipeline/audit-subagents.test.mjs）
 *
 * 覆盖：多帧 zstd 解码、两类 fixture 的退出码与输出、mtime 时间窗、日报格式、--self-test。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { decodeZstdFrames } from './audit-subagents.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audit-subagents.mjs');

function buildSession({ id, preset = 'product-relay', provider = 'product-subagents:opencode', tools = [], turnEnded = true, origin = 'subagent' }) {
  const events = [
    {
      type: 'session',
      version: 4,
      id,
      createdAt: 1792241938925,
      cwd: '/tmp/fixture',
      origin,
      delegationDepth: 1,
      agentPreset: preset,
    },
  ];
  if (provider) {
    events.push({
      type: 'subagent/descriptor',
      seq: 1,
      time: 1792241938949,
      data: { version: 3, mode: 'continuable', provider, label: 'fixture' },
    });
  }
  events.push({ type: 'turn/start', seq: 2, time: 1792241938949, data: { turn: 1 } });
  let seq = 3;
  for (const name of tools) {
    events.push({ type: 'tool/call', seq, time: 1792241939000, data: { turn: 1, step: 1, callId: `call_${seq}`, name, arguments: '{}' } });
    seq += 1;
  }
  if (turnEnded) events.push({ type: 'turn/end', seq, time: 1792241940000, data: { turn: 1, reason: { kind: 'completed' } } });
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

/** 按行切成 3 段分别压缩：模拟 DSH 的多帧追加写法（Node 内置直接解只拿得到首帧）。 */
function writeSession(root, workspace, id, text, frames = 3) {
  const dir = path.join(root, workspace, id);
  fs.mkdirSync(dir, { recursive: true });
  const step = Math.ceil(text.length / frames);
  const chunks = [];
  for (let i = 0; i < text.length; i += step) chunks.push(text.slice(i, i + step));
  const packed = Buffer.concat(chunks.map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8'))));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, packed);
  return file;
}

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-subagents-'));
}

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

test('多帧 zstd：逐帧解码后拼回完整 JSONL', () => {
  const text = buildSession({ id: 'multi', tools: ['product_submit'] }).repeat(3);
  const chunks = [text.slice(0, 30), text.slice(30, 90), text.slice(90)];
  const packed = Buffer.concat(chunks.map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8'))));

  assert.equal(zlib.zstdDecompressSync(packed).toString('utf8'), chunks[0], 'Node 内置只解首帧');
  const decoded = decodeZstdFrames(packed);
  assert.equal(decoded.text, text);
  assert.equal(decoded.frames, 3);
});

test('违规 fixture：exit 1 + 摘要与 A/C 明细', () => {
  const root = tempDir();
  const out = path.join(root, 'out');
  writeSession(root, 'ws', 'bad-1', buildSession({ id: 'bad-1', preset: 'standard', tools: ['send_message'] }));
  writeSession(root, 'ws', 'ok-1', buildSession({ id: 'ok-1', tools: ['product_submit'] }));

  const { code, stdout, stderr } = run(['--hours', '0', '--sessions-dir', root, '--out-dir', out]);

  assert.equal(code, 1);
  assert.equal(stdout, 'audited 2 sessions, 1 violations (A=1 B=0 C=1)\n');
  assert.match(stderr, /bad-1 \[AC\]/);
  assert.match(stderr, /A: preset 漂移/);
  assert.match(stderr, /C: 未走产品路径/);

  const report = JSON.parse(fs.readFileSync(path.join(out, `${todayLocal()}.json`), 'utf8'));
  assert.equal(report.totals.violating, 1);
  assert.deepEqual(report.sessions.find((s) => s.id === 'bad-1').violations, ['A', 'C']);
});

test('全绿 fixture：exit 0、stdout 仅一行、stderr 为空', () => {
  const root = tempDir();
  const out = path.join(root, 'out');
  writeSession(root, 'ws', 'ok-1', buildSession({ id: 'ok-1', tools: ['product_submit'] }));
  writeSession(root, 'ws', 'ok-2', buildSession({ id: 'ok-2', tools: ['product_submit', 'product_delegate'] }));

  const { code, stdout, stderr } = run(['--hours', '0', '--sessions-dir', root, '--out-dir', out]);

  assert.equal(code, 0);
  assert.equal(stdout, 'audited 2 sessions, 0 violations (A=0 B=0 C=0)\n');
  assert.equal(stderr, '');
});

test('非 product 会话不计入判定，但计入 audited', () => {
  const root = tempDir();
  writeSession(root, 'ws', 'main', buildSession({ id: 'main', origin: 'user', preset: 'standard', provider: '', tools: ['bash', 'read'] }));
  writeSession(root, 'ws', 'other', buildSession({ id: 'other', preset: 'standard', provider: 'opencode', tools: ['bash'] }));

  const { code, stdout } = run(['--hours', '0', '--sessions-dir', root, '--out-dir', path.join(root, 'out')]);

  assert.equal(code, 0);
  assert.equal(stdout, 'audited 2 sessions, 0 violations (A=0 B=0 C=0)\n');
});

test('mtime 时间窗：--hours 排除旧会话，--hours 0 不限', () => {
  const root = tempDir();
  const file = writeSession(root, 'ws', 'old', buildSession({ id: 'old', preset: 'standard', tools: ['bash'] }));
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(file, old, old);

  const recent = run(['--hours', '24', '--sessions-dir', root, '--out-dir', path.join(root, 'out')]);
  assert.equal(recent.code, 0);
  assert.equal(recent.stdout, 'audited 0 sessions, 0 violations (A=0 B=0 C=0)\n');

  const all = run(['--hours', '0', '--sessions-dir', root, '--out-dir', path.join(root, 'out')]);
  assert.equal(all.code, 1);
  assert.equal(all.stdout, 'audited 1 sessions, 1 violations (A=1 B=1 C=1)\n');
});

test('日报：每个会话一行，且是合法 JSON', () => {
  const root = tempDir();
  const out = path.join(root, 'out');
  writeSession(root, 'ws', 'ok-1', buildSession({ id: 'ok-1', tools: ['product_submit'] }));
  writeSession(root, 'ws', 'bad-1', buildSession({ id: 'bad-1', preset: 'standard', tools: ['send_message'] }));

  run(['--hours', '0', '--sessions-dir', root, '--out-dir', out]);
  const file = path.join(out, `${todayLocal()}.json`);
  const text = fs.readFileSync(file, 'utf8');
  const sessionLines = text.split('\n').filter((line) => /^\s{4}\{"id"/.test(line));

  assert.equal(sessionLines.length, 2);
  assert.equal(JSON.parse(text).sessions.length, 2);
});

test('--self-test 全通过', () => {
  const { code, stdout } = run(['--self-test']);
  assert.equal(code, 0);
  assert.match(stdout, /self-test: 12 passed/);
});

test('坏参数：exit 2', () => {
  assert.equal(run(['--hours', 'abc']).code, 2);
  assert.equal(run(['--nope']).code, 2);
});
