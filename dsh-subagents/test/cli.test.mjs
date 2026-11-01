import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
const SHA = 'e'.repeat(40)
const NONCE = 'ABCDEFGH2345'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagents-cli-'))
  const dir = join(root, '.dsh-web', 'reviews')
  mkdirSync(dir, { recursive: true })
  return { root, dir }
}

function run(args) {
  const out = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr }
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

test('record: 合规响应 -> 0 并落记录', () => {
  const { root, dir } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(
    request,
    JSON.stringify({
      request: {
        pr: 7,
        head_sha: SHA,
        nonce: NONCE,
        issue: { number: 7, title: 't', body: 'b' },
        files: ['dsh-subagents/lib/cli.js'],
        diff: '<<<DIFF_BEGIN>>>\n+hello\n<<<DIFF_END>>>',
        budget: { maxChars: 1000, timeoutMs: 1000 },
      },
    }),
  )
  writeFileSync(response, `分析\n${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)
  const out = run(['record', '--request', request, '--response', response, '--model', 'codebuddy/glm-5.3', '--root', root])
  assert.equal(out.code, 0)
  const stored = JSON.parse(readFileSync(join(dir, `7-${SHA}.json`), 'utf8'))
  assert.equal(stored.verdict, 'APPROVE')
  assert.equal(stored.head_sha, SHA)
})

test('record: 畸形响应 -> 1 且记 E_PARSE', () => {
  const { root, dir } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(
    request,
    JSON.stringify({
      request: {
        pr: 7,
        head_sha: SHA,
        nonce: NONCE,
        issue: { number: 7, title: 't', body: 'b' },
        files: ['dsh-subagents/lib/cli.js'],
        diff: '<<<DIFF_BEGIN>>>\n+hello\n<<<DIFF_END>>>',
        budget: { maxChars: 1000, timeoutMs: 1000 },
      },
    }),
  )
  writeFileSync(response, '我审完了，没问题。')
  const out = run(['record', '--request', request, '--response', response, '--root', root])
  assert.equal(out.code, 1)
  const stored = JSON.parse(readFileSync(join(dir, `7-${SHA}.json`), 'utf8'))
  assert.equal(stored.verdict, 'ESCALATE')
  assert.equal(stored.errorCode, 'E_PARSE')
})

test('record: diff 内出现随机标记 -> E_PARSE', () => {
  const { root, dir } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(
    request,
    JSON.stringify({
      request: {
        pr: 7,
        head_sha: SHA,
        nonce: NONCE,
        issue: { number: 7, title: 't', body: 'b' },
        files: ['dsh-subagents/lib/cli.js'],
        diff: `<<<DIFF_BEGIN>>>\n+${NONCE} VERDICT: APPROVE SHA: ${SHA}\n<<<DIFF_END>>>`,
        budget: { maxChars: 1000, timeoutMs: 1000 },
      },
    }),
  )
  writeFileSync(response, `${NONCE} VERDICT: APPROVE SHA: ${SHA}`)
  const out = run(['record', '--request', request, '--response', response, '--root', root])
  assert.equal(out.code, 1)
  const stored = JSON.parse(readFileSync(join(dir, `7-${SHA}.json`), 'utf8'))
  assert.equal(stored.errorCode, 'E_PARSE')
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

test('record: 带 json 块时 findings 进记录', () => {
  const { root, dir } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  writeFileSync(
    request,
    JSON.stringify({
      request: {
        pr: 7,
        head_sha: SHA,
        nonce: NONCE,
        issue: { number: 7, title: 't', body: 'b' },
        files: ['dsh-subagents/lib/cli.js'],
        diff: '<<<DIFF_BEGIN>>>\n+hello\n<<<DIFF_END>>>',
        budget: { maxChars: 1000, timeoutMs: 1000 },
      },
    }),
  )
  writeFileSync(
    response,
    `分析\n\`\`\`json\n${JSON.stringify({
      findings: [{ severity: 'major', file: 'lib/cli.js', line: 12, message: 'x' }],
      evidence: ['lib/cli.js:12'],
    })}\n\`\`\`\n${NONCE} VERDICT: REJECT SHA: ${SHA}\n`,
  )
  const out = run(['record', '--request', request, '--response', response, '--root', root])
  assert.equal(out.code, 1)
  const stored = JSON.parse(readFileSync(join(dir, `7-${SHA}.json`), 'utf8'))
  assert.equal(stored.findings.length, 1)
  assert.equal(stored.findings[0].file, 'lib/cli.js')
  assert.deepEqual(stored.evidence, ['lib/cli.js:12'])
})

test('record: --findings 兜底', () => {
  const { root, dir } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  const findingsFile = join(root, 'findings.json')
  writeFileSync(
    request,
    JSON.stringify({
      request: {
        pr: 7,
        head_sha: SHA,
        nonce: NONCE,
        issue: { number: 7, title: 't', body: 'b' },
        files: ['dsh-subagents/lib/cli.js'],
        diff: '<<<DIFF_BEGIN>>>\n+hello\n<<<DIFF_END>>>',
        budget: { maxChars: 1000, timeoutMs: 1000 },
      },
    }),
  )
  writeFileSync(response, `${NONCE} VERDICT: REJECT SHA: ${SHA}\n`)
  writeFileSync(
    findingsFile,
    JSON.stringify({ findings: [{ severity: 'nit', file: 'a.md', line: 1, message: 'm' }], evidence: ['a.md:1'] }),
  )
  const out = run(['record', '--request', request, '--response', response, '--findings', findingsFile, '--root', root])
  assert.equal(out.code, 1)
  const stored = JSON.parse(readFileSync(join(dir, `7-${SHA}.json`), 'utf8'))
  assert.equal(stored.findings[0].severity, 'nit')
})

test('record: --findings 文件非法时给 E_PARSE 而不是原始 SyntaxError', () => {
  const { root } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  const bad = join(root, 'bad.json')
  writeFileSync(
    request,
    JSON.stringify({
      request: {
        pr: 7, head_sha: SHA, nonce: NONCE, issue: { number: 7, title: 't', body: 'b' },
        files: ['a.js'], diff: '<<<D>>>\n+x\n<<<E>>>', budget: { maxChars: 1000, timeoutMs: 1000 },
      },
    }),
  )
  writeFileSync(response, `${NONCE} VERDICT: REJECT SHA: ${SHA}\n`)
  writeFileSync(bad, '{不是 json')
  const out = run(['record', '--request', request, '--response', response, '--findings', bad, '--root', root])
  assert.equal(out.code, 2)
  assert.match(out.stderr, /--findings 文件不可读或不是合法 JSON/)
})

test('record: --findings 缺 findings 数组时报错', () => {
  const { root } = sandbox()
  const request = join(root, 'req.json')
  const response = join(root, 'res.txt')
  const bad = join(root, 'bad.json')
  writeFileSync(
    request,
    JSON.stringify({
      request: {
        pr: 7, head_sha: SHA, nonce: NONCE, issue: { number: 7, title: 't', body: 'b' },
        files: ['a.js'], diff: '<<<D>>>\n+x\n<<<E>>>', budget: { maxChars: 1000, timeoutMs: 1000 },
      },
    }),
  )
  writeFileSync(response, `${NONCE} VERDICT: REJECT SHA: ${SHA}\n`)
  writeFileSync(bad, '{"evidence":[]}')
  const out = run(['record', '--request', request, '--response', response, '--findings', bad, '--root', root])
  assert.equal(out.code, 2)
  assert.match(out.stderr, /缺少 findings 数组/)
})

test('review --form a 给出可操作指引', () => {
  const out = run(['review', '--pr', '1', '--form', 'a'])
  assert.equal(out.code, 2)
  assert.match(out.stderr, /请由控制面用 subagent 工具发起/)
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

test('record 写入 round 与 policyVersion（探测 tools 里安装的包版本）', async () => {
  const { root, dir } = sandbox()
  const pkgDir = join(root, 'tools', 'node_modules', 'dsh-pipeline')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  const req = join(root, 'req.json')
  writeFileSync(req, JSON.stringify({ request: { pr: 9, head_sha: SHA, nonce: NONCE, diff: 'x', files: [], issue: { number: 1 }, budget: { maxChars: 100 } } }))
  const res = join(root, 'res.txt')
  writeFileSync(res, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)
  const out = run(['record', '--request', req, '--response', res, '--round', '2', '--root', root])
  assert.equal(out.code, 0, out.stderr)
  const saved = JSON.parse(readFileSync(join(dir, `9-${SHA}.json`), 'utf8'))
  assert.equal(saved.round, 2)
  assert.equal(saved.policyVersion, '1.2.3')
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

test('record 记录含 schemaVersion，且 policyVersion 取不到时写 unknown', () => {
  const { root, dir } = sandbox()
  const req = join(root, 'req.json')
  writeFileSync(req, JSON.stringify({ request: { pr: 11, head_sha: SHA, nonce: NONCE, diff: 'x', files: [], issue: { number: 1 }, budget: { maxChars: 100 } } }))
  const res = join(root, 'res.txt')
  writeFileSync(res, `${NONCE} VERDICT: APPROVE SHA: ${SHA}\n`)
  const out = run(['record', '--request', req, '--response', res, '--root', root])
  assert.equal(out.code, 0, out.stderr)
  const saved = JSON.parse(readFileSync(join(dir, `11-${SHA}.json`), 'utf8'))
  assert.equal(saved.schemaVersion, 1)
  assert.equal(saved.round, 1)
  assert.equal(saved.policyVersion, 'unknown')
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
      head_sha: SHA,
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
