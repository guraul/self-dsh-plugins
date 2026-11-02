#!/usr/bin/env node
/**
 * dsh-subagents 的命令行入口：prepare / record / check / review / log。
 *
 * 判定与合并分离是这里的硬约束：CLI 只产出记录，不执行合并。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ContractError, makeNonce } from './contract.js'
import { buildReviewPrompt, prepareRequest } from './request.js'
import { renderCard } from './card.js'
import { ghCommands, parseRemoteUrl, publishPlan } from './publish.js'
import { renderComment, safeInline } from './comment.js'
import { runProvider } from './bridge-cli.js'
import { getRole, loadRoles } from './roles.js'
import { recordViaPackage } from './record-bridge.js'
import {
  bumpCircuit,
  findByTrace,
  isExpired,
  mainWorktreeRoot,
  readCircuit,
  readRecord,
  recordFile,
  reviewsDir,
  traceId,
  writeSkipAudit,
} from './record.js'

const USAGE = `用法:
  dsh-subagents prepare --pr <号> [--out <文件>] [--root <仓库根>]
  dsh-subagents prompt  --request <文件> [--out <文件>] [--role <角色>]  # 渲染审核提示词
  dsh-subagents recheck --request <新请求> --previous <上一轮记录> [--out <文件>]
                                                        # 渲染「同一会话复审」的任务书
  dsh-subagents adjudicate --record <文件> --decision <merge|abandon> --by <人> --reason <文本>
                                                        # 给 ESCALATE 的判定留下人为处置
  dsh-subagents record  --request <文件> --response <文件> [--findings <文件>] [--provider <名>] [--model <名>]
                        [--round <1..3>] [--form <名>] [--duration-ms <毫秒>] [--json] [--root <仓库根>]
  dsh-subagents check   --pr <号> --record <文件> [--head-sha <sha>] [--root <仓库根>]
  dsh-subagents gate    --pr <号> [--record <文件>] [--head-sha <sha>] [--root <仓库根>]
                        [--no-review --reason <说明>]   # 跨仓共用闸门（合并脚本调用）
  dsh-subagents review  --pr <号> --form <b> --model <名> [--provider <名>] [--root <仓库根>]
  dsh-subagents log     --trace <traceId> [--root <仓库根>]
  dsh-subagents card    --input <文件> [--out <文件>]     # 任务卡（纯文本）
  dsh-subagents comment --record <文件> --round <n> [--out <文件>]  # PR comment（纯文本）
  dsh-subagents publish --record <文件> --round <n> [--repo <owner/name>] [--dry-run]
                                                        # 发评论 + 按判定提交 review 状态
  dsh-subagents roles   [--roles-dir <目录>]

退出码: 0 通过（判定 APPROVE）/ 1 拒绝（记录已落盘但判定不是 APPROVE，含 REJECT/ESCALATE）/ 2 参数或环境错误`

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
    model: flags.model,
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

/**
 * 复审任务书：把「上一轮为什么拒绝 + 这轮改了什么」交给同一个 reviewer 会话，
 * 避免整轮重开（省一半成本）。任务书里**不写轮次**——reviewer 不该知道第几轮。
 */
function renderRecheckTask({ request, previous }) {
  const lines = []
  lines.push('上一轮你审过这个 PR，判定为 REJECT。这一轮作者做了修改，请重新审核。')
  lines.push('')
  if (previous.findings?.length > 0) {
    lines.push('你上一轮指出的问题（逐条确认是否已解决，未解决的继续列）：')
    for (const item of previous.findings) {
      lines.push(`- [${item.severity}] ${item.file}:${item.line ?? '-'} ${item.message}`)
    }
    lines.push('')
  }
  lines.push('这一轮的完整材料如下（新的随机标记，必须原样回显）：')
  lines.push('')
  lines.push(buildReviewPrompt({ request, role: getRole('reviewer') }))
  return `${lines.join('\n')}\n`
}

/**
 * ESCALATE 的处置留档：不覆盖原判定，只追加 adjudication。
 * 没有这一步，「这条为什么最后放行了」事后无从回答。
 */
function cmdAdjudicate(flags) {
  if (!flags.record) throw fail('E_BUDGET', '缺少 --record')
  const decision = flags.decision
  if (decision !== 'merge' && decision !== 'abandon') {
    throw fail('E_BUDGET', `--decision 只能是 merge 或 abandon，收到 ${decision ?? '(空)'}`)
  }
  if (typeof flags.by !== 'string' || flags.by.length === 0) {
    throw fail('E_BUDGET', '--by 需要一个值（谁做的决定）')
  }
  if (typeof flags.reason !== 'string' || flags.reason.length === 0) {
    throw fail('E_BUDGET', '--reason 需要一个值（为什么这么决定）')
  }

  const record = readRecord(flags.record)
  if (record.verdict !== 'ESCALATE') {
    throw fail('E_BUDGET', `记录判定是 ${record.verdict}，只有 ESCALATE 需要人为处置`)
  }
  if (record.adjudication) {
    throw fail('E_BUDGET', `该记录已被 ${record.adjudication.by} 处置过（${record.adjudication.decision}），不覆盖`)
  }

  record.adjudication = {
    decision,
    by: String(flags.by),
    reason: String(flags.reason),
    at: new Date().toISOString(),
  }
  // 原子写：记录里是审计证据，写到一半断电不能把它毁掉
  const tmpFile = `${flags.record}.${process.pid}.tmp`
  writeFileSync(tmpFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tmpFile, flags.record)

  const lines = [
    '## 人工处置',
    '',
    `- **判定**：${record.verdict}（${record.errorCode ?? '无错误码'}）→ **${decision === 'merge' ? '放行合并' : '放弃'}**`,
    `- **由**：${safeInline(record.adjudication.by)}`,
    `- **理由**：${safeInline(record.adjudication.reason)}`,
    `- **时间**：${record.adjudication.at}`,
    '',
    '原判定保持不变；这条只记录人为什么推翻了它。',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

function cmdRecheck(flags) {
  if (!flags.request || !flags.previous) throw fail('E_BUDGET', '缺少 --request 或 --previous')
  const request = JSON.parse(readFileSync(flags.request, 'utf8')).request
  const previous = readRecord(flags.previous)
  // 传错记录会渲染出「上一轮判了 REJECT」的假任务书，这三条必须先过
  if (previous.verdict !== 'REJECT') {
    throw fail('E_BUDGET', `--previous 的判定是 ${previous.verdict}，只有 REJECT 才需要复审`)
  }
  if (Number(previous.pr) !== Number(request.pr)) {
    throw fail('E_BUDGET', `--previous 属于 PR #${previous.pr}，与 --request 的 PR #${request.pr} 不符`)
  }
  if (previous.head_sha === request.head_sha) {
    throw fail('E_BUDGET', '新请求的 head 与上一轮相同——没有新提交就不该复审')
  }
  const text = renderRecheckTask({ request, previous })
  if (flags.out) {
    writeFileSync(flags.out, text, 'utf8')
    process.stdout.write(`已写入 ${flags.out}\n`)
    return 0
  }
  process.stdout.write(text)
  return 0
}

function cmdPrompt(flags) {
  if (!flags.request) throw fail('E_BUDGET', '缺少 --request')
  const request = JSON.parse(readFileSync(flags.request, 'utf8')).request
  const text = buildReviewPrompt({ request, role: getRole(flags.role || 'reviewer') })
  if (flags.out) {
    writeFileSync(flags.out, text, 'utf8')
    process.stdout.write(`已写入 ${flags.out}\n`)
    return 0
  }
  process.stdout.write(text)
  return 0
}

/**
 * 记录落盘统一交给共享 pipeline 包：判定提取、findings 兜底、高风险策略与
 * policyVersion 都在包内决定，插件端只保留对外参数。
 */
function cmdRecord(flags) {
  if (!flags.request || !flags.response) throw fail('E_BUDGET', '缺少 --request 或 --response')
  if (typeof flags.request !== 'string' || typeof flags.response !== 'string') {
    throw fail('E_BUDGET', '--request 与 --response 需要文件路径')
  }
  if (flags.findings !== undefined && typeof flags.findings !== 'string') {
    throw fail('E_PARSE', '--findings 需要一个文件路径')
  }

  // round 由控制面计数（reviewer 自己不该知道第几轮）；越界直接拒绝
  // 裸 --round（不带值）会被 parseArgv 置为 true，Number(true)===1 会静默放行
  if (flags.round !== undefined && typeof flags.round !== 'string') {
    throw fail('E_BUDGET', '--round 需要一个值（1..3）')
  }
  const round = Number(flags.round ?? 1)
  if (!Number.isInteger(round) || round < 1 || round > 3) {
    throw fail('E_BUDGET', `--round 必须是 1..3 的整数，收到 ${flags.round}`)
  }

  const outcome = recordViaPackage({
    requestFile: flags.request,
    responseFile: flags.response,
    findingsFile: typeof flags.findings === 'string' ? flags.findings : undefined,
    provider: typeof flags.provider === 'string' ? flags.provider : undefined,
    model: typeof flags.model === 'string' ? flags.model : undefined,
    round,
    root: root(flags),
    json: Boolean(flags.json),
    form: typeof flags.form === 'string' ? flags.form : undefined,
    durationMs: Number(flags['duration-ms'] || 0),
  })
  // 对外契约：0 通过 / 1 拒绝 / 2 参数或环境错误。包的成功退出码只说明「写完了」，
  // 判定必须由插件读回来翻译，否则 REJECT 会被脚本当成放行。
  if (outcome.status !== 0) return outcome.status
  return outcome.record.verdict === 'APPROVE' ? 0 : 1
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
/** 闸门判定：不过就抛 exitCode=1 的错误。check 与 gate 共用。 */
function assertGate(flags) {
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
  return record
}

function cmdCheck(flags) {
  const record = assertGate(flags)
  emit(`审核闸门通过: ${record.verdict} @ ${record.head_sha} (${record.traceId})`, flags)
  return 0
}

/**
 * 跨仓共用的审核闸门：合并脚本只要调它，不必复制判定逻辑。
 * `--no-review` 时写跳过审计并放行（留痕由本命令负责，不靠调用方）。
 */
function cmdGate(flags) {
  const pr = Number(flags.pr)
  if (!Number.isInteger(pr) || pr <= 0) throw fail('E_BUDGET', '缺少 --pr')
  const dir = root(flags)

  if (flags['no-review']) {
    const file = writeSkipAudit(reviewsDir(dir), {
      pr,
      headSha: flags['head-sha'] ?? null,
      reason: flags.reason || '未说明',
    })
    process.stderr.write(`⚠️  审核闸门已跳过（--no-review）：${file}\n`)
    return 0
  }

  const record = assertGate(flags)
  emit(`✓ 审核闸门通过: ${record.verdict} @ ${record.head_sha} (${record.traceId})`, flags)
  return 0
}

function cmdReview(flags) {
  if (!flags.pr) throw fail('E_BUDGET', '缺少 --pr')
  if ((flags.form || 'b') !== 'b') {
    throw fail(
      'E_UNAVAILABLE',
      'CLI 只支持 --form b：形态 A 需要会话内的父 agent，请由控制面用 subagent 工具发起',
    )
  }
  // round 由控制面计数（reviewer 自己不该知道第几轮）；越界直接拒绝
  // 裸 --round（不带值）会被 parseArgv 置为 true，Number(true)===1 会静默放行
  if (flags.round !== undefined && typeof flags.round !== 'string') {
    throw fail('E_BUDGET', '--round 需要一个值（1..3）')
  }
  const round = Number(flags.round ?? 1)
  if (!Number.isInteger(round) || round < 1 || round > 3) {
    throw fail('E_BUDGET', `--round 必须是 1..3 的整数，收到 ${flags.round}`)
  }

  const dir = reviewsDir(root(flags))
  const circuit = readCircuit(dir)
  if (circuit.tripped) {
    throw fail('E_UNAVAILABLE', `熔断中：今天已连续失败 ${circuit.consecutiveFailures} 次，回退人工`)
  }

  const provider = flags.provider || 'opencode'
  const role = getRole(flags.role || 'reviewer')
  const { request } = prepareRequest({
    pr: flags.pr,
    cwd: root(flags),
    nonce: makeNonce(),
  })
  const prompt = buildReviewPrompt({ request, role })
  let meta = {
    form: 'cli',
    provider,
    model: flags.model || request.model || 'unknown',
    durationMs: 0,
  }
  let text = ''
  try {
    const run = runProvider({
      provider,
      model: flags.model,
      prompt,
      timeoutMs: request.budget.timeoutMs,
      cwd: root(flags),
    })
    meta = run.meta
    text = run.text
  } catch (error) {
    if (typeof error.durationMs === 'number') meta.durationMs = error.durationMs
    process.stderr.write(`review: 审核调用失败: ${error.message}\n`)
  }

  // 记录仍由共享包组装：把请求与响应落到临时文件，包读完即删。
  const trace = traceId()
  const requestFile = join(tmpdir(), `review-${trace}.json`)
  const responseFile = join(tmpdir(), `review-${trace}.txt`)
  writeFileSync(requestFile, `${JSON.stringify({ request }, null, 2)}\n`, 'utf8')
  writeFileSync(responseFile, text, 'utf8')

  let outcome
  try {
    outcome = recordViaPackage({
      requestFile,
      responseFile,
      provider: meta.provider,
      model: meta.model,
      round,
      root: root(flags),
      json: Boolean(flags.json),
      form: meta.form,
      durationMs: meta.durationMs,
    })
  } finally {
    rmSync(requestFile, { force: true })
    rmSync(responseFile, { force: true })
  }

  if (outcome.status !== 0) {
    // 调用失败或响应无法落记录，同样计入熔断，避免无限重试。
    bumpCircuit(dir)
    return outcome.status
  }

  const file = recordFile(dir, request.pr, request.head_sha)
  const record = readRecord(file)
  if (record.verdict !== 'APPROVE') bumpCircuit(dir)
  if (!flags.json) {
    emit(`判定 ${record.verdict}（${record.errorCode ?? '无错误码'}）→ ${file}`, flags)
  }
  return record.verdict === 'APPROVE' ? 0 : 1
}

function cmdCard(flags) {
  if (!flags.input) throw fail('E_BUDGET', '缺少 --input')
  const text = renderCard(JSON.parse(readFileSync(flags.input, 'utf8')))
  if (flags.out) {
    writeFileSync(flags.out, text, 'utf8')
    process.stdout.write(`已写入 ${flags.out}\n`)
    return 0
  }
  process.stdout.write(text)
  return 0
}

function cmdComment(flags) {
  if (!flags.record) throw fail('E_BUDGET', '缺少 --record')
  const round = Number(flags.round ?? 1)
  const text = renderComment({ result: readRecord(flags.record), round })
  if (flags.out) {
    writeFileSync(flags.out, text, 'utf8')
    process.stdout.write(`已写入 ${flags.out}\n`)
    return 0
  }
  process.stdout.write(text)
  return 0
}

/** 先用本地 git remote 解析仓库，避免任何网络调用。 */
function repoFromGit(cwd) {
  const out = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', cwd })
  if (out.status !== 0) return null
  return parseRemoteUrl(out.stdout)
}

function cmdPublish(flags) {
  if (!flags.record) throw fail('E_BUDGET', '缺少 --record')
  const round = Number(flags.round ?? 1)
  const record = readRecord(flags.record)
  if (!Number.isInteger(record.pr) || record.pr <= 0) {
    throw fail('E_BUDGET', `记录里的 pr 不是正整数：${record.pr}（无法确定要发布到哪个 PR）`)
  }
  const plan = publishPlan({ record, round })

  // --dry-run 必须零网络：仓库只从 --repo 或本地 git remote 取，绝不调用 gh。
  let repo = flags.repo || repoFromGit(root(flags))
  if (!repo && !flags['dry-run']) {
    const out = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      encoding: 'utf8',
    })
    if (out.status !== 0) throw fail('E_UNAVAILABLE', '无法确定仓库（用 --repo 指定）')
    repo = String(out.stdout).trim()
  }
  if (!repo) throw fail('E_UNAVAILABLE', '--dry-run 需要 --repo，或在仓库内从 git remote origin 能解析出仓库')

  const commands = ghCommands({ plan, pr: record.pr, repo })
  if (flags['dry-run']) {
    process.stdout.write(`${JSON.stringify({ repo, pr: record.pr, commands }, null, 2)}\n`)
    return 0
  }

  for (const command of commands) {
    const out = spawnSync('gh', command.args, {
      encoding: 'utf8',
      input: command.stdin ?? undefined,
    })
    if (out.status !== 0) {
      const detail = (out.stderr || '').trim().split('\n').slice(-2).join(' ')
      throw fail('E_UNAVAILABLE', `gh ${command.args.slice(0, 2).join(' ')} 失败: ${detail}`)
    }
  }
  process.stdout.write(`已发布 ${commands.length} 个动作（${plan.action}）到 PR #${record.pr}\n`)
  return 0
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
  prompt: cmdPrompt,
  recheck: cmdRecheck,
  adjudicate: cmdAdjudicate,
  record: cmdRecord,
  check: cmdCheck,
  gate: cmdGate,
  review: cmdReview,
  log: cmdLog,
  card: cmdCard,
  comment: cmdComment,
  publish: cmdPublish,
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
