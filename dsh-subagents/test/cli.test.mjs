import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const SHA = 'e'.repeat(40)
const NONCE = 'ABCDEFGH2345'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagents-cli-'))
  const dir = join(root, '.dsh-web', 'reviews')
  mkdirSync(dir, { recursive: true })
  return { root, dir }
}

function run(args, env = {}) {
  const out = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr }
}

/**
 * 假共享包：shell 脚本把 argv 逐行写到文件，按环境变量决定退出码与输出。
 * 位置按 DSH_PIPELINE_HOME 解析，因此不用在测试里碰真实 tools/node_modules。
 */
function stubPackage({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pipeline-stub-'))
  mkdirSync(join(home, 'bin'), { recursive: true })
  const argvFile = join(home, 'argv.txt')
  const script = [
    '#!/bin/sh',
    ': > "$DSH_STUB_ARGV"',
    'for a in "$@"; do printf \'%s\\n\' "$a" >> "$DSH_STUB_ARGV"; done',
    'printf \'%s\' "$DSH_STUB_STDOUT"',
    'printf \'%s\' "$DSH_STUB_STDERR" >&2',
    'exit "${DSH_STUB_EXIT:-0}"',
    '',
  ].join('\n')
  writeFileSync(join(home, 'bin', 'cli.mjs'), script, { mode: 0o755 })
  return {
    home,
    argvFile,
    env: {
      DSH_PIPELINE_HOME: home,
      DSH_STUB_ARGV: argvFile,
      DSH_STUB_STDOUT: stdout,
      DSH_STUB_STDERR: stderr,
      DSH_STUB_EXIT: String(exitCode),
    },
  }
}

function stubArgv(file) {
  return readFileSync(file, 'utf8').trim().split('\n')
}

/**
 * 包在 `--json` 下的 stdout：一行完整记录。插件靠它把判定翻译成对外退出码，
 * 所以桩包必须按真包的形状输出，而不是中文提示。
 */
function jsonRecord(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    policyVersion: '0.1.0',
    pr: 7,
    round: 2,
    verdict: 'APPROVE',
    head_sha: SHA,
    nonce: NONCE,
    findings: [],
    evidence: [],
    form: 'cli',
    provider: 'codebuddy',
    model: 'codebuddy/glm-5.3',
    durationMs: 1200,
    policy: { hit: false, reasons: [] },
    createdAt: new Date().toISOString(),
    ...overrides,
  })
}

function writeRecord(dir, overrides = {}) {
  const record = {
    schemaVersion: 1,
    verdict: 'APPROVE',
    head_sha: SHA,
    nonce: NONCE,
    findings: [],
    evidence: [],
    form: 'cli',
    model: 'codebuddy/glm-5.3',
    durationMs: 1000,
    traceId: '20261031T121500Z-abcdef01',
    errorCode: null,
    policy: { hit: false, reasons: [] },
    createdAt: new Date().toISOString(),
    ...overrides,
  }
  const file = join(dir, `${record.pr ?? 7}-${record.head_sha}.json`)
  writeFileSync(file, JSON.stringify(record))
  return file
}

test('check: APPROVE 且 sha 一致、未过期 -> 0', () => {
  const { root, dir } = sandbox()
  const file = writeRecord(dir, { pr: 7 })
  const out = run(['check', '--pr', '7', '--record', file, '--head-sha', SHA, '--root', root])
  assert.equal(out.code, 0)
  assert.match(out.stdout, /审核闸门通过/)
})

test('check: 判定非 APPROVE -> 1 且首行带审核闸门', () => {
  const { root, dir } = sandbox()
  const file = writeRecord(dir, { pr: 7, verdict: 'ESCALATE', errorCode: 'E_POLICY' })
  const out = run(['check', '--pr', '7', '--record', file, '--head-sha', SHA, '--root', root])
  assert.equal(out.code, 1)
  assert.match(out.stderr.split('\n')[0], /^审核闸门: 判定为 ESCALATE/)
})

test('check: sha 不符 -> 1', () => {
  const { root, dir } = sandbox()
  const file = writeRecord(dir, { pr: 7 })
  const out = run(['check', '--pr', '7', '--record', file, '--head-sha', 'f'.repeat(40), '--root', root])
  assert.equal(out.code, 1)
  assert.match(out.stderr, /判定已作废/)
})

test('check: 记录过期 -> 1', () => {
  const { root, dir } = sandbox()
  const file = writeRecord(dir, { pr: 7, createdAt: '2026-10-31T00:00:00Z' })
  const out = run(['check', '--pr', '7', '--record', file, '--head-sha', SHA, '--root', root])
  assert.equal(out.code, 1)
  assert.match(out.stderr, /已过期/)
})

test('check: 命中高风险 -> 1', () => {
  const { root, dir } = sandbox()
  const file = writeRecord(dir, { pr: 7, policy: { hit: true, reasons: ['.github/workflows/ci.yml: 改 CI 本身'] } })
  const out = run(['check', '--pr', '7', '--record', file, '--head-sha', SHA, '--root', root])
  assert.equal(out.code, 1)
  assert.match(out.stderr, /高风险路径/)
})

test('check: 记录不存在 -> 1 且提示 --no-review', () => {
  const { root } = sandbox()
  const out = run(['check', '--pr', '7', '--record', join(root, 'nope.json'), '--head-sha', SHA, '--root', root])
  assert.equal(out.code, 1)
  assert.match(out.stderr, /找不到审核记录.*--no-review/)
})

test('record: 参数完整映射到共享包 CLI', () => {
  const { root } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  const findings = join(root, 'findings.json')
  writeFileSync(request, JSON.stringify({ request: { pr: 7, head_sha: SHA, nonce: NONCE } }))
  writeFileSync(response, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)
  writeFileSync(findings, '{"findings":[]}')

  const stub = stubPackage({ stdout: `${jsonRecord()}\n` })
  const out = run(
    [
      'record', '--request', request, '--response', response, '--findings', findings,
      '--provider', 'codebuddy', '--model', 'codebuddy/glm-5.3', '--round', '2',
      '--form', 'cli', '--duration-ms', '1200', '--json', '--policy-version', '9.9.9',
      '--root', root,
    ],
    stub.env,
  )

  assert.equal(out.code, 0, out.stderr)
  assert.equal(JSON.parse(out.stdout).verdict, 'APPROVE', '--json 时插件透出记录本体')
  assert.deepEqual(stubArgv(stub.argvFile), [
    'record',
    '--request', request,
    '--response', response,
    '--findings', findings,
    '--provider', 'codebuddy',
    '--model', 'codebuddy/glm-5.3',
    '--round', '2',
    '--root', root,
    '--duration-ms', '1200',
    '--form', 'cli',
    '--json',
  ], '插件只做参数映射；--policy-version 已删除，不得透传')
})

test('record: 包的退出码与 stderr 原样透传', () => {
  const { root } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(request, JSON.stringify({ request: { pr: 7, head_sha: SHA, nonce: NONCE } }))
  writeFileSync(response, '我审完了，没问题。')

  const stub = stubPackage({ exitCode: 2, stderr: 'record: 无法从响应中解析出唯一且带正确标记的判定行\n' })
  const out = run(['record', '--request', request, '--response', response, '--root', root], stub.env)
  assert.equal(out.code, 2)
  assert.match(out.stderr, /无法从响应中解析出唯一且带正确标记的判定行/)
})

/**
 * 对外契约（README）是 0 通过 / 1 拒绝 / 2 参数或环境错误：
 * 包落盘成功即 0，插件必须把判定读回来翻译，否则脚本会把 REJECT 当放行。
 */
test('record: 判定决定插件退出码（APPROVE→0，REJECT/ESCALATE→1）', () => {
  const { root } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(request, JSON.stringify({ request: { pr: 7, head_sha: SHA, nonce: NONCE } }))
  writeFileSync(response, `${NONCE} VERDICT: REJECT SHA: ${SHA}\n`)

  for (const [verdict, expected] of [['APPROVE', 0], ['REJECT', 1], ['ESCALATE', 1]]) {
    const stub = stubPackage({ stdout: `${jsonRecord({ verdict })}\n` })
    const out = run(['record', '--request', request, '--response', response, '--root', root], stub.env)
    assert.equal(out.code, expected, `${verdict} 应退出 ${expected}，实际 ${out.code}：${out.stderr}`)
  }
})

test('record: 包始终以 --json 调起，成功时输出落盘路径', () => {
  const { root } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(request, JSON.stringify({ request: { pr: 7, head_sha: SHA, nonce: NONCE } }))
  writeFileSync(response, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)

  const stub = stubPackage({ stdout: `${jsonRecord()}\n` })
  const out = run(['record', '--request', request, '--response', response, '--root', root], stub.env)
  assert.equal(out.code, 0, out.stderr)
  assert.ok(stubArgv(stub.argvFile).includes('--json'), '必须带 --json 才能读回判定')
  assert.match(out.stdout, /已写入审核记录: .*7-.+\.json/)
})

test('record: 包输出不是合法记录时退出 2，不猜判定', () => {
  const { root } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(request, JSON.stringify({ request: { pr: 7, head_sha: SHA, nonce: NONCE } }))
  writeFileSync(response, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)

  const stub = stubPackage({ stdout: '已写入审核记录: /tmp/x.json\n' })
  const out = run(['record', '--request', request, '--response', response, '--root', root], stub.env)
  assert.equal(out.code, 2)
  assert.match(out.stderr, /--json 输出不是合法记录/)
  assert.match(out.stderr, /记录可能已落盘.*\.dsh-web\/reviews/, '包成功但输出坏了，记录可能已经写了')
})

/**
 * 熔断恢复：旧实现在「记录落盘但判定不是 APPROVE」时 bump，
 * 重构后这条丢了——连续失败会永远不触发回人工。
 */
test('record: 判定非 APPROVE 时累加熔断计数（APPROVE 不加）', () => {
  const { root, dir } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(request, JSON.stringify({ request: { pr: 7, head_sha: SHA, nonce: NONCE } }))
  writeFileSync(response, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)
  const circuit = join(dir, 'circuit.json')

  const approve = run(
    ['record', '--request', request, '--response', response, '--root', root],
    stubPackage({ stdout: `${jsonRecord({ verdict: 'APPROVE' })}\n` }).env,
  )
  assert.equal(approve.code, 0, approve.stderr)
  assert.equal(existsSync(circuit), false, 'APPROVE 不该计入熔断')

  for (const [i, verdict] of ['REJECT', 'ESCALATE'].entries()) {
    const out = run(
      ['record', '--request', request, '--response', response, '--root', root],
      stubPackage({ stdout: `${jsonRecord({ verdict })}\n` }).env,
    )
    assert.equal(out.code, 1, out.stderr)
    const stored = JSON.parse(readFileSync(circuit, 'utf8'))
    assert.equal(stored.consecutiveFailures, i + 1, `${verdict} 应累加一次`)
  }
})

test('record: --duration-ms 非数字或裸 flag 按 0 记录并告警', () => {
  const { root } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(request, JSON.stringify({ request: { pr: 7, head_sha: SHA, nonce: NONCE } }))
  writeFileSync(response, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)

  for (const arg of [['--duration-ms', 'abc'], ['--duration-ms']]) {
    const stub = stubPackage({ stdout: `${jsonRecord()}\n` })
    const out = run(['record', '--request', request, '--response', response, ...arg, '--root', root], stub.env)
    assert.equal(out.code, 0, out.stderr)
    const argv = stubArgv(stub.argvFile)
    const index = argv.indexOf('--duration-ms')
    assert.equal(argv[index + 1], '0', `${arg.join(' ')} 必须传 0，不能传 NaN 或 1`)
    assert.match(out.stderr, /--duration-ms 需要非负数字.*按 0 记录/)
    assert.doesNotMatch(out.stderr, /NaN/, '别把 NaN 写进记录')
  }

  const stub = stubPackage({ stdout: `${jsonRecord()}\n` })
  run(['record', '--request', request, '--response', response, '--duration-ms', '1200', '--root', root], stub.env)
  const argv = stubArgv(stub.argvFile)
  assert.equal(argv[argv.indexOf('--duration-ms') + 1], '1200', '合法值原样透传')
})

test('record: 共享包不存在时退出 2 并给中文提示', () => {
  const { root } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(request, JSON.stringify({ request: { pr: 7, head_sha: SHA, nonce: NONCE } }))
  writeFileSync(response, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)

  // 桥会从插件自身位置向上找包，所以这里必须跑隔离副本：直接在仓里跑会命中
  // 开发机 / CI 上已装的 tools/node_modules，测不到「都没有」这条路径。
  const isolated = mkdtempSync(join(tmpdir(), 'dsh-subagents-isolated-'))
  const plugin = join(isolated, 'dsh-subagents')
  cpSync(PLUGIN_DIR, plugin, { recursive: true, filter: (src) => !src.includes('node_modules') })
  const out = spawnSync(
    process.execPath,
    [join(plugin, 'lib', 'cli.js'), 'record', '--request', request, '--response', response, '--root', root],
    { encoding: 'utf8', env: { ...process.env, DSH_PIPELINE_HOME: join(root, 'missing-pipeline') } },
  )
  assert.equal(out.status, 2)
  assert.match(out.stderr, /找不到共享 pipeline 包/)
  assert.match(out.stderr, /DSH_PIPELINE_HOME/)
  assert.match(out.stderr, /已尝试/, '错误信息要列出试过的路径')
})

test('roles 列出两个内置角色', () => {
  const out = run(['roles'])
  assert.equal(out.code, 0)
  assert.match(out.stdout, /^reviewer\treadonly\treview-result/m)
  assert.match(out.stdout, /^executor\tfull\ttext/m, 'executor 必须能改能跑（full），否则 CLI 非交互模式会拒绝执行')
})

test('未知子命令 -> 2', () => {
  assert.equal(run(['nope']).code, 2)
})

test('review --form a 给出可操作指引', () => {
  const out = run(['review', '--pr', '1', '--form', 'a'])
  assert.equal(out.code, 2)
  assert.match(out.stderr, /请由控制面用 subagent 工具发起/)
})

/**
 * 临时文件里有完整 diff 与审核原文：不能裸写在共享 /tmp 里。
 * 这里用 gh / provider 桩跑完整 review 路径，检查落点与清理。
 */
test('review: 请求与响应落独占临时目录，用完整目录删除', () => {
  const { root, dir } = sandbox()
  const bin = mkdtempSync(join(tmpdir(), 'dsh-review-bin-'))
  const meta = JSON.stringify({
    number: 7,
    title: 't',
    body: '',
    headRefOid: SHA,
    baseRefName: 'main',
    files: [],
    additions: 0,
    deletions: 0,
  })
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf \'%s\' "$STUB_GH_META"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then printf \'%s\' "diff --git a/a b/a"; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  writeFileSync(join(bin, 'reviewer'), '#!/bin/sh\nprintf \'%s\' "$STUB_REVIEW_TEXT"\n', { mode: 0o755 })
  // 记录预先摆好：cmdReview 成功后会按 PR + head 读回判定
  writeRecord(dir, { pr: 7, verdict: 'APPROVE' })

  const stub = stubPackage({ stdout: `${jsonRecord()}\n` })
  const out = run(
    ['review', '--pr', '7', '--form', 'b', '--model', 'stub/model', '--provider', 'opencode', '--root', root],
    {
      ...stub.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_GH_META: meta,
      STUB_REVIEW_TEXT: '分析若干，结论见下。',
      DSH_SUBAGENTS_OPENCODE_BIN: join(bin, 'reviewer'),
    },
  )
  assert.equal(out.code, 0, out.stderr)

  const argv = stubArgv(stub.argvFile)
  const requestFile = argv[argv.indexOf('--request') + 1]
  const responseFile = argv[argv.indexOf('--response') + 1]
  assert.match(requestFile, /dsh-review-.+review-\d{8}T\d{6}Z-[a-z0-9]{8}\.json$/, '落 mkdtemp 目录')
  assert.equal(dirname(requestFile), dirname(responseFile), '请求与响应同目录')
  assert.equal(existsSync(dirname(requestFile)), false, '用完必须整目录删掉（含 0700 目录本身）')
  assert.equal(existsSync(requestFile), false)
  assert.equal(existsSync(responseFile), false)
})

test('gate: 记录合格且 head 一致时放行', () => {
  const { root, dir } = sandbox()
  writeRecord(dir)
  const out = run(['gate', '--pr', '7', '--root', root, '--head-sha', SHA, '--record', join(dir, '7-' + SHA + '.json')])
  assert.equal(out.code, 0)
  assert.match(out.stdout, /审核闸门通过/)
})

test('gate: 没有记录时拒绝（fail-closed）', () => {
  const { root } = sandbox()
  const out = run(['gate', '--pr', '7', '--root', root, '--head-sha', SHA, '--record', join(root, 'nope.json')])
  assert.equal(out.code, 1)
  assert.match(out.stderr, /审核闸门: 找不到审核记录/)
})

test('gate: 判定不是 APPROVE 时拒绝', () => {
  const { root, dir } = sandbox()
  writeRecord(dir, { verdict: 'REJECT' })
  const out = run(['gate', '--pr', '7', '--root', root, '--head-sha', SHA, '--record', join(dir, '7-' + SHA + '.json')])
  assert.equal(out.code, 1)
  assert.match(out.stderr, /判定为 REJECT/)
})

test('gate: --no-review 放行并写跳过审计', () => {
  const { root } = sandbox()
  const out = run(['gate', '--pr', '7', '--root', root, '--no-review', '--reason', '用户同意'])
  assert.equal(out.code, 0)
  assert.match(out.stderr, /审核闸门已跳过/)
  const files = readdirSync(join(root, '.dsh-web', 'reviews', 'skips'))
  assert.equal(files.length, 1)
  const audit = JSON.parse(readFileSync(join(root, '.dsh-web', 'reviews', 'skips', files[0]), 'utf8'))
  assert.equal(audit.pr, 7)
  assert.equal(audit.reason, '用户同意')
})

test('gate: 命中高风险路径时拒绝', () => {
  const { root, dir } = sandbox()
  writeRecord(dir, { policy: { hit: true, reasons: ['scripts/pipeline/x'] } })
  const out = run(['gate', '--pr', '7', '--root', root, '--head-sha', SHA, '--record', join(dir, '7-' + SHA + '.json')])
  assert.equal(out.code, 1)
  assert.match(out.stderr, /必须人工放行/)
})

test('record 的 --round 越界时拒绝', () => {
  const { root } = sandbox()
  const req = join(root, 'req.json')
  writeFileSync(req, JSON.stringify({ request: { pr: 9, head_sha: SHA, nonce: NONCE, diff: 'x', files: [], issue: { number: 1 }, budget: { maxChars: 100 } } }))
  const res = join(root, 'res.txt')
  writeFileSync(res, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)
  const out = run(['record', '--request', req, '--response', res, '--round', '4', '--root', root])
  assert.equal(out.code, 2)
  assert.match(out.stderr, /--round 必须是 1\.\.3/)
})

test('record 的 --round 不带值时报错，不静默当 1', () => {
  const { root } = sandbox()
  const req = join(root, 'req.json')
  writeFileSync(req, JSON.stringify({ request: { pr: 12, head_sha: SHA, nonce: NONCE, diff: 'x', files: [], issue: { number: 1 }, budget: { maxChars: 100 } } }))
  const res = join(root, 'res.txt')
  writeFileSync(res, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)
  const out = run(['record', '--request', req, '--response', res, '--round', '--root', root])
  assert.equal(out.code, 2)
  assert.match(out.stderr, /--round 需要一个值/)
})

test('recheck：任务书含上轮问题与新标记，且不提轮次', () => {
  const { root, dir } = sandbox()
  const prev = join(dir, `9-${SHA}.json`)
  writeFileSync(
    prev,
    JSON.stringify({
      schemaVersion: 1,
      policyVersion: '0.1.0',
      round: 1,
      pr: 9,
      verdict: 'REJECT',
      head_sha: 'f'.repeat(40), // 上一轮的提交，必须与新请求不同
      findings: [{ severity: 'major', file: 'lib/a.js', line: 3, message: '缺校验' }],
      evidence: [],
      createdAt: new Date().toISOString(),
    }),
  )
  const req = join(root, 'req.json')
  writeFileSync(req, JSON.stringify({ request: { pr: 9, head_sha: SHA, nonce: NONCE, diff: 'x', files: [], issue: { body: 'b' }, budget: { maxChars: 100 } } }))
  const out = run(['recheck', '--request', req, '--previous', prev])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /上一轮你审过这个 PR，判定为 REJECT/)
  assert.match(out.stdout, /\[major\] lib\/a\.js:3 缺校验/)
  assert.match(out.stdout, new RegExp(NONCE))
  assert.doesNotMatch(out.stdout, /第\s*2\s*轮/, 'reviewer 不该知道轮次')
})

test('recheck：传错记录时拒绝（非 REJECT / PR 不符 / head 未变）', () => {
  const { root, dir } = sandbox()
  const req = join(root, 'req.json')
  writeFileSync(req, JSON.stringify({ request: { pr: 9, head_sha: SHA, nonce: NONCE, diff: 'x', files: [], issue: { body: 'b' }, budget: { maxChars: 100 } } }))
  const other = '1'.repeat(40)
  const mk = (over) => {
    const file = join(dir, `p-${Object.keys(over).join('')}-${Math.random().toString(36).slice(2, 6)}.json`)
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, policyVersion: '0.1.0', round: 1, pr: 9, verdict: 'REJECT', head_sha: other, findings: [], evidence: [], createdAt: new Date().toISOString(), ...over }))
    return file
  }
  assert.match(run(['recheck', '--request', req, '--previous', mk({ verdict: 'APPROVE', pr: 9 })]).stderr, /只有 REJECT/)
  assert.match(run(['recheck', '--request', req, '--previous', mk({ pr: 8 })]).stderr, /不符/)
  assert.match(run(['recheck', '--request', req, '--previous', mk({ head_sha: SHA })]).stderr, /没有新提交/)
})

test('adjudicate：给 ESCALATE 留处置，不覆盖原判定', () => {
  const { dir } = sandbox()
  const file = join(dir, `7-${SHA}.json`)
  writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, policyVersion: '0.1.0', round: 1, pr: 7, verdict: 'ESCALATE', head_sha: SHA, findings: [], evidence: [], createdAt: new Date().toISOString(), errorCode: 'E_POLICY' }),
  )
  const out = run(['adjudicate', '--record', file, '--decision', 'merge', '--by', 'guraul', '--reason', '改的是流程文档，已人工看过'])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /人工处置/)
  assert.match(out.stdout, /放行合并/)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.verdict, 'ESCALATE', '原判定不能被覆盖')
  assert.equal(saved.adjudication.decision, 'merge')
  assert.equal(saved.adjudication.by, 'guraul')
})

test('adjudicate：非 ESCALATE / 重复处置 / 缺参数都拒绝', () => {
  const { dir } = sandbox()
  const ok = join(dir, `8-${SHA}.json`)
  writeFileSync(ok, JSON.stringify({ schemaVersion: 1, policyVersion: '0.1.0', round: 1, pr: 8, verdict: 'APPROVE', head_sha: SHA, findings: [], evidence: [], createdAt: new Date().toISOString() }))
  assert.match(run(['adjudicate', '--record', ok, '--decision', 'merge', '--by', 'x', '--reason', 'y']).stderr, /只有 ESCALATE/)

  const esc = join(dir, `9-${SHA}.json`)
  writeFileSync(esc, JSON.stringify({ schemaVersion: 1, policyVersion: '0.1.0', round: 1, pr: 9, verdict: 'ESCALATE', head_sha: SHA, findings: [], evidence: [], createdAt: new Date().toISOString() }))
  assert.equal(run(['adjudicate', '--record', esc, '--decision', 'merge', '--by', 'x', '--reason', 'y']).code, 0)
  assert.match(run(['adjudicate', '--record', esc, '--decision', 'abandon', '--by', 'z', '--reason', 'w']).stderr, /已被 .* 处置过/)
  assert.match(run(['adjudicate', '--record', esc, '--decision', 'nope', '--by', 'x', '--reason', 'y']).stderr, /只能是 merge 或 abandon/)
})
