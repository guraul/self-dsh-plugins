#!/usr/bin/env node
/**
 * dsh-subagents 的命令行入口：prepare / record / check / review / log。
 *
 * 判定与合并分离是这里的硬约束：CLI 只产出记录，不执行合并。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ContractError,
  highRiskHit,
  makeNonce,
  nonceInDiff,
  parseVerdict,
  validateResult,
} from './contract.js'
import { buildReviewPrompt, prepareRequest } from './request.js'
import { runProvider } from './bridge-cli.js'
import { getRole, loadRoles } from './roles.js'
import {
  bumpCircuit,
  findByTrace,
  isExpired,
  mainWorktreeRoot,
  readCircuit,
  readRecord,
  reviewsDir,
  traceId,
  writeRecord,
} from './record.js'

const USAGE = `用法:
  dsh-subagents prepare --pr <号> [--out <文件>] [--root <仓库根>]
  dsh-subagents record  --request <文件> --response <文件> [--provider <名>] [--model <名>] [--root <仓库根>]
  dsh-subagents check   --pr <号> --record <文件> [--head-sha <sha>] [--root <仓库根>]
  dsh-subagents review  --pr <号> --form <b> --model <名> [--provider <名>] [--root <仓库根>]
  dsh-subagents log     --trace <traceId> [--root <仓库根>]
  dsh-subagents roles   [--roles-dir <目录>]

退出码: 0 通过 / 1 拒绝（闸门或判定不是 APPROVE）/ 2 参数或环境错误`

function parseArgv(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=')
      if (inline !== undefined) {
        flags[key] = inline
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[i + 1]
        i += 1
      } else {
        flags[key] = true
      }
    } else {
      rest.push(arg)
    }
  }
  return { flags, rest }
}

function fail(code, message) {
  const error = new ContractError(code, message)
  error.exitCode = 2
  return error
}

function root(flags) {
  if (flags.root) return resolve(flags.root)
  return mainWorktreeRoot(process.cwd())
}

function emit(value, flags) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  if (typeof value === 'string') process.stdout.write(`${value}\n`)
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function cmdPrepare(flags) {
  if (!flags.pr) throw fail('E_BUDGET', '缺少 --pr')
  const { request, stats } = prepareRequest({
    pr: flags.pr,
    cwd: root(flags),
    maxChars: flags['max-chars'] ? Number(flags['max-chars']) : undefined,
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    nonce: flags.nonce,
  })
  const payload = { request, stats }
  if (flags.out) {
    writeFileSync(flags.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    emit(`已写入 ${flags.out}`, flags)
    return 0
  }
  emit(payload, { ...flags, json: true })
  return 0
}

function cmdRecord(flags) {
  if (!flags.request || !flags.response) throw fail('E_BUDGET', '缺少 --request 或 --response')
  const request = JSON.parse(readFileSync(flags.request, 'utf8')).request
  const raw = readFileSync(flags.response, 'utf8')
  const meta = {
    form: flags.form || 'cli',
    provider: flags.provider || 'unknown',
    model: flags.model || 'unknown',
    durationMs: Number(flags['duration-ms'] || 0),
  }

  let parsed
  try {
    if (nonceInDiff(request.diff, request.nonce)) {
      throw new ContractError('E_PARSE', 'diff 内出现随机标记，判定行可能来自被审内容')
    }
    parsed = parseVerdict(raw, { nonce: request.nonce, headSha: request.head_sha })
  } catch (error) {
    parsed = { verdict: 'ESCALATE', errorCode: error.code ?? 'E_PARSE', message: error.message }
  }

  const policy = highRiskHit({
    files: request.files,
    addedLines: Number(flags['added-lines'] || 0),
    diff: request.diff,
  })

  const result = {
    verdict: policy.hit ? 'ESCALATE' : parsed.verdict,
    head_sha: request.head_sha,
    nonce: request.nonce,
    findings: [],
    evidence: policy.hit ? policy.reasons : (parsed.message ? [parsed.message] : []),
    form: meta.form,
    model: meta.model,
    durationMs: meta.durationMs,
    traceId: traceId(),
    errorCode: policy.hit ? 'E_POLICY' : (parsed.errorCode ?? null),
  }
  const checked = validateResult(result)
  if (!checked.ok) throw new ContractError('E_PARSE', `结果不合 schema: ${checked.errors.join('; ')}`)

  const record = {
    schemaVersion: 1,
    pr: request.pr,
    ...result,
    request: {
      issue: request.issue?.number ?? null,
      filesHash: `sha256:${request.files.join(',')}`,
      diffChars: String(request.diff ?? '').length,
      maxChars: request.budget?.maxChars ?? null,
    },
    policy,
    createdAt: new Date().toISOString(),
  }
  const dir = reviewsDir(root(flags))
  const file = writeRecord(dir, record)

  if (result.verdict !== 'APPROVE') bumpCircuit(dir)
  emit(flags.json ? record : `判定 ${result.verdict}（${result.errorCode ?? '无错误码'}）→ ${file}`, flags)
  return result.verdict === 'APPROVE' ? 0 : 1
}

function currentHeadSha(flags) {
  if (flags['head-sha']) return flags['head-sha']
  const out = spawnSync('gh', ['pr', 'view', String(flags.pr), '--json', 'headRefOid'], {
    encoding: 'utf8',
    cwd: root(flags),
  })
  if (out.status !== 0) throw fail('E_UNAVAILABLE', '取 PR head 失败（受限沙盒下 gh 会报令牌无效，请用完整权限）')
  return JSON.parse(out.stdout).headRefOid
}

/** merge-pr.sh 的闸门：任一项不过即拒绝，文案首行统一带 `审核闸门:`。 */
function cmdCheck(flags) {
  if (!flags.record) throw fail('E_BUDGET', '缺少 --record')
  const gate = (message) => {
    const error = new Error(`审核闸门: ${message}`)
    error.exitCode = 1
    return error
  }
  if (!existsSync(flags.record)) throw gate(`找不到审核记录 ${flags.record}（用 --no-review 显式跳过）`)

  let record
  try {
    record = readRecord(flags.record)
  } catch (error) {
    throw gate(`审核记录无法解析: ${error.message}`)
  }
  if (record.verdict !== 'APPROVE') {
    throw gate(`判定为 ${record.verdict}（${record.errorCode ?? '无错误码'}），拒绝合并`)
  }
  const headSha = currentHeadSha(flags)
  if (record.head_sha !== headSha) {
    throw gate(`判定针对 ${record.head_sha}，PR 当前 head 为 ${headSha}，判定已作废`)
  }
  if (isExpired(record)) {
    throw gate(`审核记录已过期（${record.createdAt}），需重新审核`)
  }
  if (record.policy?.hit) {
    throw gate(`命中高风险路径 ${record.policy.reasons.join('; ')}，必须人工放行`)
  }
  emit(`审核闸门通过: ${record.verdict} @ ${record.head_sha} (${record.traceId})`, flags)
  return 0
}

function cmdReview(flags) {
  if (!flags.pr) throw fail('E_BUDGET', '缺少 --pr')
  if ((flags.form || 'b') !== 'b') {
    throw fail('E_UNAVAILABLE', '一期只实现 --form b（形态 A 的 HTTP 通道在 PR4）')
  }
  const dir = reviewsDir(root(flags))
  const circuit = readCircuit(dir)
  if (circuit.tripped) {
    throw fail('E_UNAVAILABLE', `熔断中：今天已连续失败 ${circuit.consecutiveFailures} 次，回退人工`)
  }

  const role = getRole(flags.role || 'reviewer')
  const { request } = prepareRequest({
    pr: flags.pr,
    cwd: root(flags),
    nonce: makeNonce(),
  })
  const prompt = buildReviewPrompt({ request, role })
  let meta = {
    form: 'cli',
    provider: flags.provider || 'opencode',
    model: flags.model || 'unknown',
    durationMs: 0,
  }
  let parsed
  try {
    const run = runProvider({
      provider: flags.provider || 'opencode',
      model: flags.model,
      prompt,
      timeoutMs: request.budget.timeoutMs,
      cwd: root(flags),
    })
    meta = run.meta
    if (nonceInDiff(request.diff, request.nonce)) {
      throw new ContractError('E_PARSE', 'diff 内出现随机标记')
    }
    parsed = parseVerdict(run.text, { nonce: request.nonce, headSha: request.head_sha })
  } catch (error) {
    parsed = { verdict: 'ESCALATE', errorCode: error.code ?? 'E_UNAVAILABLE', message: error.message }
    if (typeof error.durationMs === 'number') meta.durationMs = error.durationMs
  }

  const policy = highRiskHit({ files: request.files, diff: request.diff })
  const result = {
    verdict: policy.hit ? 'ESCALATE' : parsed.verdict,
    head_sha: request.head_sha,
    nonce: request.nonce,
    findings: [],
    evidence: policy.hit ? policy.reasons : (parsed.message ? [parsed.message] : []),
    form: meta.form,
    model: meta.model,
    durationMs: meta.durationMs,
    traceId: traceId(),
    errorCode: policy.hit ? 'E_POLICY' : (parsed.errorCode ?? null),
  }
  const checked = validateResult(result)
  if (!checked.ok) throw new ContractError('E_PARSE', `结果不合 schema: ${checked.errors.join('; ')}`)

  const record = {
    schemaVersion: 1,
    pr: request.pr,
    ...result,
    request: { issue: request.issue.number, diffChars: request.diff.length, maxChars: request.budget.maxChars },
    policy,
    createdAt: new Date().toISOString(),
  }

  const file = writeRecord(dir, record)
  if (record.verdict !== 'APPROVE') bumpCircuit(dir)
  emit(flags.json ? record : `判定 ${record.verdict}（${record.errorCode ?? '无错误码'}）→ ${file}`, flags)
  return record.verdict === 'APPROVE' ? 0 : 1
}

function cmdLog(flags) {
  if (!flags.trace) throw fail('E_BUDGET', '缺少 --trace')
  const hits = findByTrace(reviewsDir(root(flags)), flags.trace)
  if (hits.length === 0) {
    emit(`没有 traceId 为 ${flags.trace} 的记录`, flags)
    return 1
  }
  for (const record of hits) {
    emit(
      `${record.traceId} ${record.verdict} ${record.form}/${record.model} ${record.durationMs}ms pr#${record.pr} @${record.head_sha}`,
      flags,
    )
  }
  return 0
}

function cmdRoles(flags) {
  const { roles, skipped } = loadRoles(flags['roles-dir'])
  for (const role of roles.values()) {
    emit(`${role.id}\t${role.permissionMode}\t${role.outputContract}\t${role.description}`, flags)
  }
  if (skipped.length > 0) process.stderr.write(`跳过的坏角色文件: ${skipped.join(', ')}\n`)
  return 0
}

const COMMANDS = {
  prepare: cmdPrepare,
  record: cmdRecord,
  check: cmdCheck,
  review: cmdReview,
  log: cmdLog,
  roles: cmdRoles,
}

function main(argv) {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return command ? 0 : 2
  }
  const handler = COMMANDS[command]
  if (!handler) {
    process.stderr.write(`未知子命令: ${command}\n${USAGE}\n`)
    return 2
  }
  const { flags } = parseArgv(rest)
  try {
    return handler(flags)
  } catch (error) {
    const prefix = error.exitCode === 1 ? '' : '错误: '
    process.stderr.write(`${prefix}${error.message}\n`)
    return error.exitCode ?? 2
  }
}

process.exitCode = main(process.argv.slice(2))
