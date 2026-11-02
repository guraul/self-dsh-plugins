#!/usr/bin/env node
// token-sync · 入口（homebase#109 / self-dsh-plugins#202）
//
// 每天 12:00 由 LaunchAgent 调用：采集 dsh / codebuddy / opencode 三方用量，
// 归一化成 homebase `token_usage_daily` 的行，分批上传。
//
// 用法：
//   node collect.mjs --dry-run                 # 只统计，不写
//   node collect.mjs --date 2026-10-30         # 只采这一天
//   node collect.mjs --days 2                  # 采最近 2 天（默认）
//   node collect.mjs --include-backups         # opencode 合并备份库
//
// 配置：~/.dsh/token-sync.env（600）或环境变量
//   HOMEBASE_URL=https://106.13.181.13
//   HOMEBASE_CA=/Users/you/.dsh/certs/homebase-selfsigned.crt
//   HOMEBASE_INTERNAL_TOKEN=<64 位>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDsh, earliestDshDay } from './sources/dsh.mjs';
import { collectCodebuddy, shanghaiDay } from './sources/codebuddy.mjs';
import { collectOpencode, earliestOpencodeDay } from './sources/opencode.mjs';
import { parseEnvFile, uploadRows } from './upload.mjs';

const DEFAULT_ENV_FILE = path.join(process.env.HOME ?? '', '.dsh', 'token-sync.env');

function parseArgs(argv) {
  const out = { dryRun: false, date: null, days: 2, from: null, to: null, all: false, includeBackups: false, envFile: DEFAULT_ENV_FILE, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--include-backups') out.includeBackups = true;
    else if (arg === '--verbose') out.verbose = true;
    else if (arg === '--date') out.date = argv[++i] ?? null;
    else if (arg === '--days') out.days = Number(argv[++i] ?? 2);
    else if (arg === '--from') out.from = argv[++i] ?? null;
    else if (arg === '--to') out.to = argv[++i] ?? null;
    else if (arg === '--all') out.all = true;
    else if (arg === '--env-file') out.envFile = argv[++i] ?? DEFAULT_ENV_FILE;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node collect.mjs [--dry-run] [--date YYYY-MM-DD] [--days N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--all] [--include-backups]');
      process.exit(0);
    }
  }
  return out;
}

/** 从 from 到 to（闭区间）逐日展开；非法顺序或超长直接抛错。 */
export function enumerateDays(from, to, limit = 4000) {
  const out = [];
  let cursor = from;
  while (cursor <= to) {
    out.push(cursor);
    if (out.length > limit) throw new Error(`日期范围过大（>${limit} 天）：${from}..${to}`);
    const next = new Date(cursor + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
  return out;
}

/**
 * 目标日期集合。优先级：--date > --from/--to > --all > --days。
 * --all 由调用方解析出 from（各源最早可用日），这里只做范围展开。
 */
export function targetDays({ date, days, from, to, all, allFrom }, now = Date.now()) {
  if (date) return [date];
  if (all) {
    const start = allFrom;
    if (!start) throw new Error('--all 需要先探测最早日期');
    const end = to ?? shanghaiDay(now - 86400000);
    return enumerateDays(start, end);
  }
  if (from || to) {
    const end = to ?? shanghaiDay(now - 86400000);
    const start = from ?? end;
    if (start > end) throw new Error(`--from(${start}) 晚于 --to(${end})`);
    return enumerateDays(start, end);
  }
  const out = [];
  for (let i = 1; i <= Math.max(1, days); i += 1) out.push(shanghaiDay(now - i * 86400000));
  return out;
}

function summarize(rows) {
  const bySource = new Map();
  for (const row of rows) {
    const cur = bySource.get(row.source) ?? { rows: 0, total: 0, models: new Set() };
    cur.rows += 1;
    cur.total += row.total_tokens ?? 0;
    cur.models.add(row.model);
    bySource.set(row.source, cur);
  }
  return [...bySource.entries()].map(([source, v]) => ({
    source,
    rows: v.rows,
    models: v.models.size,
    total_tokens: v.total,
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = parseEnvFile(args.envFile);
  const config = {
    url: process.env.HOMEBASE_URL ?? envFile.HOMEBASE_URL ?? '',
    token: process.env.HOMEBASE_INTERNAL_TOKEN ?? envFile.HOMEBASE_INTERNAL_TOKEN ?? '',
    ca: process.env.HOMEBASE_CA ?? envFile.HOMEBASE_CA ?? null,
  };
  // --all：以 opencode 最早可用日为起点（它历史最全），末端为昨天。
  let allFrom = null;
  if (args.all) {
    // 取各源最早日期的最小值：dsh 历史最长，opencode 次之，codebuddy 只留 7 天。
    const [dshEarliest, opencodeEarliest] = await Promise.all([earliestDshDay(), earliestOpencodeDay()]);
    const candidates = [dshEarliest, opencodeEarliest].filter(Boolean);
    if (!candidates.length) {
      console.error('[token-sync] --all: 找不到任何源的最早日期');
      return 2;
    }
    allFrom = candidates.sort()[0];
    console.log(
      `[token-sync] --all 起点: ${allFrom}（dsh=${dshEarliest ?? '-'}, opencode=${opencodeEarliest ?? '-'}，取最早）`,
    );
  }
  const days = targetDays({ ...args, allFrom });

  const span = days.length > 1 ? `${days[0]} .. ${days[days.length - 1]}（${days.length} 天）` : days[0];
  console.log(`[token-sync] 目标日期: ${span}${args.dryRun ? '（dry-run）' : ''}`);

  const [dsh, codebuddy, opencode] = await Promise.all([
    collectDsh({ days }),
    collectCodebuddy({ days }),
    collectOpencode({ days, includeBackups: args.includeBackups }),
  ]);

  const all = [...dsh.rows, ...codebuddy.rows, ...opencode.rows];
  const errors = [...dsh.errors, ...codebuddy.errors, ...opencode.errors];

  console.log('[token-sync] 采集结果:');
  for (const item of summarize(all)) {
    console.log(`  ${item.source.padEnd(10)} rows=${String(item.rows).padStart(5)} models=${String(item.models).padStart(3)} total=${item.total_tokens}`);
  }
  if (errors.length) {
    console.log(`[token-sync] 警告 ${errors.length} 条:`);
    for (const e of errors.slice(0, 10)) console.log('  - ' + e);
  }

  if (args.dryRun) {
    if (args.verbose) {
      for (const row of all.slice(0, 20)) console.log('  sample', JSON.stringify(row));
    }
    console.log('[token-sync] dry-run 结束（未写入）');
    return 0;
  }

  if (!config.url || !config.token) {
    console.error('[token-sync] 缺少 HOMEBASE_URL / HOMEBASE_INTERNAL_TOKEN（见 ~/.dsh/token-sync.env）');
    return 2;
  }
  if (config.ca && !fs.existsSync(config.ca)) {
    console.error(`[token-sync] HOMEBASE_CA 不存在: ${config.ca}`);
    return 2;
  }
  if (!all.length) {
    console.log('[token-sync] 没有可写入的行');
    return 0;
  }

  const { failed } = await uploadRows({
    rows: all,
    config: { ...config, ca: config.ca ? fs.readFileSync(config.ca, 'utf8') : null },
    onBatch: (info) => {
      const label = info.status === 'ok' ? '✓' : '✗';
      console.log(`  ${label} ${info.source} ${info.usageDate} rows=${info.rows}${info.error ? ' ' + info.error : ''}`);
    },
  });

  if (failed.length) {
    console.error(`[token-sync] ${failed.length} 批失败`);
    return 1;
  }
  console.log(`[token-sync] 完成：${all.length} 行已写入`);
  return 0;
}

// 只在直接执行时跑 main；被测试 import 时不触发。
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('[token-sync] 未捕获错误:', error);
      process.exit(1);
    });
}
