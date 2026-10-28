#!/usr/bin/env node
/**
 * audit-subagents.mjs — 定时审计 product 子代理会话日志（issue #10）
 *
 * 扫 `${DSH_HOME:-~/.dsh}/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，
 * 默认只看最近 24h（按 mtime）。纯确定性判定、只读、不触发任何模型调用。
 *
 * 判定规则（详见 docs/pipeline/README.md「audit-subagents.sh」一节）：
 *   A  preset 漂移：product 子代理会话的 `agentPreset !== 'product-relay'`
 *   B  本地自执行：`tool/call` 出现 bash/read/write/edit/glob/grep
 *   C  未走产品路径：`product_submit` 调用 0 次，且 turn 已结束（有 `turn/end`）
 *
 * 用法：
 *   node scripts/pipeline/audit-subagents.mjs [--hours 24] [--json]
 *                                            [--sessions-dir DIR] [--out-dir DIR]
 *   node scripts/pipeline/audit-subagents.mjs --self-test
 *
 * 退出码：0 无违规；1 有违规；2 参数 / IO 致命错误。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const PRODUCT_PRESET = 'product-relay';
export const PRODUCT_TOOL_PREFIX = 'product_';
export const PRODUCT_PROVIDER_PREFIX = 'product-subagents:';
export const LOCAL_TOOLS = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep']);

export const RULES = {
  A: 'preset 漂移（agentPreset 不是 product-relay）',
  B: '本地自执行（调用了 bash/read/write/edit/glob/grep）',
  C: '未走产品路径（0 次 product_submit 且 turn 已结束）',
};

const SESSION_FILE = 'session.v4.jsonl.zstd';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 多帧 zstd 解码。
 *
 * 为什么不能直接 `zstdDecompressSync(buf)`：DSH 的会话日志是**逐条追加的多帧 zstd**，
 * Node 内置解码器只解第一帧；本机 `zstd` CLI 又会报 `incorrect library version`。
 * 故按 magic `28 b5 2f fd` 找所有候选偏移，逐个解；解不出的（伪偏移 / 截断帧）跳过。
 */
export function decodeZstdFrames(buf) {
  const parts = [];
  let offsets = 0;
  let failures = 0;
  let cursor = 0;
  while (cursor < buf.length) {
    const start = buf.indexOf(ZSTD_MAGIC, cursor);
    if (start === -1) break;
    offsets += 1;
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(start));
      if (out.length > 0) parts.push(out);
    } catch {
      failures += 1;
    }
    cursor = start + ZSTD_MAGIC.length;
  }
  return {
    text: Buffer.concat(parts).toString('utf8'),
    frames: parts.length,
    offsets,
    failures,
  };
}

/**
 * 解析一个会话的完整 JSONL 文本，抽出判定需要的字段。
 * 坏行（半写入 / 解压残片）只计数，不中断。
 */
export function parseSessionText(text) {
  const result = {
    id: '',
    cwd: '',
    origin: '',
    preset: null,
    provider: '',
    tools: [],
    productSubmit: 0,
    turnEnded: false,
    badLines: 0,
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      result.badLines += 1;
      continue;
    }
    if (!ev || typeof ev.type !== 'string') {
      result.badLines += 1;
      continue;
    }
    if (ev.type === 'session' && !result.id) {
      result.id = typeof ev.id === 'string' ? ev.id : '';
      result.cwd = typeof ev.cwd === 'string' ? ev.cwd : '';
      result.origin = typeof ev.origin === 'string' ? ev.origin : '';
      result.preset = typeof ev.agentPreset === 'string' ? ev.agentPreset : null;
      continue;
    }
    if (ev.type === 'subagent/descriptor' && ev.data && !result.provider) {
      result.provider = typeof ev.data.provider === 'string' ? ev.data.provider : '';
      continue;
    }
    if (ev.type === 'tool/call' && ev.data && typeof ev.data.name === 'string') {
      result.tools.push(ev.data.name);
      if (ev.data.name === 'product_submit') result.productSubmit += 1;
      continue;
    }
    if (ev.type === 'turn/end') result.turnEnded = true;
  }

  return result;
}

/**
 * 判定一个已解析会话。非 product 子代理返回 product=false、violations 为空。
 */
export function evaluateSession(session) {
  const isProductSubagent =
    session.origin === 'subagent' &&
    (session.provider.startsWith(PRODUCT_PROVIDER_PREFIX) ||
      session.preset === PRODUCT_PRESET ||
      session.tools.some((name) => name.startsWith(PRODUCT_TOOL_PREFIX)));

  if (!isProductSubagent) {
    return { ...session, product: false, violations: [] };
  }

  const violations = [];
  if (session.preset !== PRODUCT_PRESET) violations.push('A');

  const localCalls = session.tools.filter((name) => LOCAL_TOOLS.has(name));
  if (localCalls.length > 0) violations.push('B');

  if (session.productSubmit === 0 && session.turnEnded) violations.push('C');

  return { ...session, product: true, localCalls, violations };
}

export function summarize(sessions, options = {}) {
  const byRule = { A: 0, B: 0, C: 0 };
  let violating = 0;
  for (const s of sessions) {
    if (s.violations.length > 0) violating += 1;
    for (const rule of s.violations) byRule[rule] += 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    hours: options.hours ?? 24,
    sessionsDir: options.sessionsDir ?? '',
    totals: {
      scanned: options.scanned ?? sessions.length,
      productSubagents: sessions.length,
      violating,
      byRule,
      unreadable: options.unreadable ?? 0,
    },
    sessions,
  };
}

/** 会话目录 → 一行判定记录（写进日报的 sessions 数组）。 */
function toRecord(session, filePath, mtimeMs) {
  return {
    id: session.id || path.basename(path.dirname(filePath)),
    workspace: path.basename(path.dirname(path.dirname(filePath))),
    mtime: new Date(mtimeMs).toISOString(),
    preset: session.preset,
    origin: session.origin,
    provider: session.provider,
    tools: session.tools,
    productSubmit: session.productSubmit,
    turnEnded: session.turnEnded,
    violations: session.violations,
    status: session.violations.length > 0 ? 'violation' : 'ok',
  };
}

/** 逐文件扫描（不递归到无关层级：固定 `* / * / session.v4.jsonl.zstd`）。 */
export function scanSessions(options = {}) {
  const hours = options.hours ?? 24;
  const sessionsDir = options.sessionsDir ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
  const cutoff = hours > 0 ? Date.now() - hours * 3600 * 1000 : 0;

  const sessions = [];
  let scanned = 0;
  let unreadable = 0;
  const errors = [];

  let workspaces;
  try {
    workspaces = fs.readdirSync(sessionsDir);
  } catch (error) {
    const wrapped = new Error(`无法读取会话目录 ${sessionsDir}: ${error.message}`);
    wrapped.code = 'ESESSIONS';
    throw wrapped;
  }

  for (const workspace of workspaces) {
    const workspaceDir = path.join(sessionsDir, workspace);
    let entries;
    try {
      entries = fs.readdirSync(workspaceDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(workspaceDir, entry, SESSION_FILE);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.mtimeMs < cutoff) continue;
      scanned += 1;

      let text;
      try {
        text = decodeZstdFrames(fs.readFileSync(file)).text;
      } catch (error) {
        unreadable += 1;
        errors.push({ file, message: error.message });
        continue;
      }
      if (!text) {
        unreadable += 1;
        errors.push({ file, message: '解压结果为空' });
        continue;
      }

      const session = evaluateSession(parseSessionText(text));
      if (session.product) sessions.push(toRecord(session, file, stat.mtimeMs));
    }
  }

  sessions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const report = summarize(sessions, { hours, sessionsDir, scanned, unreadable });
  return { report, errors };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 写日报：sessions 数组每个会话一行（合法 JSON，同时便于 grep）。 */
export function renderReport(report) {
  const lines = ['{'];
  lines.push(`  "generatedAt": ${JSON.stringify(report.generatedAt)},`);
  lines.push(`  "hours": ${report.hours},`);
  lines.push(`  "sessionsDir": ${JSON.stringify(report.sessionsDir)},`);
  lines.push('  "totals": {');
  const totals = report.totals;
  lines.push(`    "scanned": ${totals.scanned},`);
  lines.push(`    "productSubagents": ${totals.productSubagents},`);
  lines.push(`    "violating": ${totals.violating},`);
  lines.push(`    "byRule": ${JSON.stringify(totals.byRule)},`);
  lines.push(`    "unreadable": ${totals.unreadable}`);
  lines.push('  },');
  lines.push('  "sessions": [');
  report.sessions.forEach((session, index) => {
    lines.push(`    ${JSON.stringify(session)}${index === report.sessions.length - 1 ? '' : ','}`);
  });
  lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export function summaryLine(report) {
  const { scanned, violating, byRule, unreadable } = report.totals;
  let line = `audited ${scanned} sessions, ${violating} violations (A=${byRule.A} B=${byRule.B} C=${byRule.C})`;
  if (unreadable > 0) line += `, ${unreadable} unreadable`;
  return line;
}

function writeDailyReport(report, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${localDate()}.json`);
  fs.writeFileSync(file, renderReport(report));
  return file;
}

function parseArgs(argv) {
  const options = {
    hours: 24,
    json: false,
    selfTest: false,
    sessionsDir: undefined,
    outDir: path.join(REPO_ROOT, '.dsh-web', 'audit'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--hours') {
      const value = argv[i + 1];
      i += 1;
      if (!/^\d+$/.test(value ?? '')) throw new Error(`--hours 需要非负整数，收到: ${value ?? '(空)'}`);
      options.hours = Number(value);
    } else if (arg.startsWith('--hours=')) {
      const value = arg.slice('--hours='.length);
      if (!/^\d+$/.test(value)) throw new Error(`--hours 需要非负整数，收到: ${value}`);
      options.hours = Number(value);
    } else if (arg === '--sessions-dir') {
      options.sessionsDir = argv[i + 1];
      i += 1;
      if (!options.sessionsDir) throw new Error('--sessions-dir 需要一个目录');
    } else if (arg === '--out-dir') {
      options.outDir = argv[i + 1];
      i += 1;
      if (!options.outDir) throw new Error('--out-dir 需要一个目录');
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

const HELP = `用法: node scripts/pipeline/audit-subagents.mjs [选项]

  --hours <N>         只扫最近 N 小时的会话（默认 24；0 = 不限）
  --json              把完整报告打到 stdout（仍会写日报）
  --sessions-dir DIR  覆盖会话根目录（默认 $DSH_HOME/sessions）
  --out-dir DIR       覆盖日报目录（默认 <repo>/.dsh-web/audit）
  --self-test         跑内置 fixture 与断言，不读真实会话
  -h, --help          本帮助

退出码: 0 无违规 / 1 有违规 / 2 参数或 IO 错误
`;

/* ------------------------------------------------------------------ */
/* --self-test                                                         */
/* ------------------------------------------------------------------ */

function makeSession({ id, origin = 'subagent', preset = PRODUCT_PRESET, provider = 'product-subagents:opencode', tools = [], turnEnded = true }) {
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
  if (preset === PRODUCT_PRESET) {
    events.push({ type: 'agent-preset/selected', seq: 1, time: 1792241938949, data: { agentPreset: preset } });
  }
  if (provider) {
    events.push({
      type: 'subagent/descriptor',
      seq: 2,
      time: 1792241938949,
      data: { version: 3, mode: 'continuable', provider, label: 'fixture' },
    });
  }
  events.push({ type: 'turn/start', seq: 3, time: 1792241938949, data: { turn: 1 } });
  let seq = 4;
  for (const name of tools) {
    events.push({ type: 'tool/call', seq, time: 1792241939000, data: { turn: 1, step: 1, callId: `call_${seq}`, name, arguments: '{}' } });
    seq += 1;
  }
  if (turnEnded) events.push({ type: 'turn/end', seq, time: 1792241940000, data: { turn: 1, reason: { kind: 'completed' } } });
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

const SELF_TEST_CASES = [
  {
    name: '合规：product-relay + 仅 product_submit',
    session: makeSession({ id: 'ok-1', tools: ['product_submit'] }),
    expect: [],
  },
  {
    name: '违规 A+C：preset 退化成 standard，只调 send_message',
    session: makeSession({ id: 'bad-1', preset: 'standard', tools: ['send_message'] }),
    expect: ['A', 'C'],
  },
  {
    name: '违规 B：product-relay 但本地执行 bash',
    session: makeSession({ id: 'bad-2', tools: ['product_submit', 'bash'] }),
    expect: ['B'],
  },
  {
    name: '违规 C：preset 正确但没有 product_submit',
    session: makeSession({ id: 'bad-3', tools: [] }),
    expect: ['C'],
  },
  {
    name: '进行中会话不判 C：没有 turn/end',
    session: makeSession({ id: 'wip-1', tools: [], turnEnded: false }),
    expect: [],
  },
  {
    name: '非 product 子代理（无 product 特征）不判',
    session: makeSession({ id: 'skip-1', preset: 'standard', provider: 'opencode', tools: ['bash', 'read'] }),
    expect: [],
  },
  {
    name: '主会话（origin 非 subagent）不判',
    session: makeSession({ id: 'skip-2', origin: 'user', preset: 'standard', provider: '', tools: ['bash'] }),
    expect: [],
  },
  {
    name: '只有 product_* 工具、preset standard：仍算 product 并判 A',
    session: makeSession({ id: 'bad-4', preset: 'standard', provider: '', tools: ['product_submit'] }),
    expect: ['A'],
  },
];

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: 期望 ${e}，实际 ${a}`);
}

function runSelfTest() {
  let failed = 0;
  const check = (name, fn) => {
    try {
      fn();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}\n       ${error.message}`);
    }
  };

  console.log('self-test: 判定规则');

  for (const testCase of SELF_TEST_CASES) {
    check(testCase.name, () => {
      const session = evaluateSession(parseSessionText(testCase.session));
      assertEqual(session.violations, testCase.expect, 'violations');
    });
  }

  check('多帧 zstd：3 帧全文可还原（Node 内置只解首帧）', () => {
    const text = SELF_TEST_CASES.map((c) => c.session).join('');
    const chunks = [text.slice(0, 40), text.slice(40, 120), text.slice(120)];
    const frames = chunks.map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')));
    const packed = Buffer.concat(frames);
    const decoded = decodeZstdFrames(packed);
    assertEqual(decoded.text, text, 'text');
    assertEqual(decoded.frames, 3, 'frames');
  });

  check('伪 magic 偏移：解不出则跳过，不影响真实帧', () => {
    const text = makeSession({ id: 'fake-magic', tools: ['product_submit'] });
    const first = zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
    const polluted = Buffer.concat([ZSTD_MAGIC, Buffer.from([0xde, 0xad, 0xbe, 0xef]), first]);
    const decoded = decodeZstdFrames(polluted);
    assertEqual(decoded.text.includes('"fake-magic"'), true, '包含真实内容');
  });

  check('汇总：违规计数与按规则分解', () => {
    const sessions = SELF_TEST_CASES.map((c) => evaluateSession(parseSessionText(c.session))).filter((s) => s.product);
    const report = summarize(sessions, { hours: 24, scanned: 8, unreadable: 0 });
    assertEqual(report.totals.violating, 4, 'violating');
    assertEqual(report.totals.byRule, { A: 2, B: 1, C: 2 }, 'byRule');
    assertEqual(report.totals.productSubagents, 6, 'productSubagents');
  });

  check('输出：摘要行格式稳定', () => {
    const line = summaryLine({
      totals: { scanned: 3, violating: 1, byRule: { A: 1, B: 0, C: 1 }, unreadable: 0 },
    });
    assertEqual(line, 'audited 3 sessions, 1 violations (A=1 B=0 C=1)', 'summary');
  });

  const total = SELF_TEST_CASES.length + 4;
  if (failed > 0) {
    console.error(`self-test: ${failed}/${total} failed`);
    return 1;
  }
  console.log(`self-test: ${total} passed`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`audit-subagents: ${error.message}`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.selfTest) return runSelfTest();

  let result;
  try {
    result = scanSessions(options);
  } catch (error) {
    console.error(`audit-subagents: ${error.message}`);
    return 2;
  }

  const { report, errors } = result;
  let reportFile = '';
  try {
    reportFile = writeDailyReport(report, options.outDir);
  } catch (error) {
    console.error(`audit-subagents: 写日报失败 ${options.outDir}: ${error.message}`);
    return 2;
  }

  if (options.json) {
    process.stdout.write(renderReport(report));
  } else {
    console.log(summaryLine(report));
  }

  if (report.totals.violating > 0) {
    const offenders = report.sessions.filter((s) => s.violations.length > 0);
    console.error(`audit-subagents: ${offenders.length} 个 product 子代理会话违规（日报 ${reportFile}）`);
    for (const session of offenders) {
      console.error(`  - ${session.id} [${session.violations.join('')}] preset=${session.preset} tools=${session.tools.join(',') || '(none)'}`);
      for (const rule of session.violations) console.error(`      ${rule}: ${RULES[rule]}`);
    }
  }
  for (const error of errors) console.error(`audit-subagents: 跳过不可读会话 ${error.file}: ${error.message}`);

  return report.totals.violating > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
