import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareRequest } from '../lib/request.js'
import {
  aggregateShardRecords,
  collectShardRecords,
  parseShardRecordName,
  parseShardSpec,
  pickShard,
  shardRecordName,
  splitDiffByFile,
  writeAggregateRecord,
} from '../lib/shard.js'
import { resolvePipelineCli } from '../lib/record-bridge.js'

const CLI = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
const SHA = 'd'.repeat(40)
const NONCE = 'SHARD2345678'
const PR = 251

function fileSection(path, addedLines) {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,3 @@',
    '-old',
    ...Array.from({ length: addedLines }, (_, n) => `+line${n}`),
    ' ctx',
  ].join('\n')
}

/** 5 个文件、行数各不相同：用来验证均衡切分与完备性。 */
const FILES = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']
const DIFF = `${FILES.map((path, i) => fileSection(path, i + 1)).join('\n')}\n`

function tmp(prefix = 'dsh-subagents-shard-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function reviewsDirOf(root) {
  const dir = join(root, '.dsh-web', 'reviews')
  mkdirSync(dir, { recursive: true })
  return dir
}

function fakeBin(dir, name, script) {
  const file = join(dir, name)
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  return file
}

function prepareSandbox(t) {
  const dir = tmp('dsh-subagents-shard-prep-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const meta = {
    number: PR,
    title: 't',
    body: 'Closes #251',
    headRefOid: SHA,
    baseRefName: 'main',
    files: FILES.map((path) => ({ path })),
    additions: 10,
    deletions: 5,
  }
  const gh = fakeBin(
    dir,
    'gh',
    [
      '#!/bin/bash',
      'if [[ "$1" == "pr" && "$2" == "view" ]]; then',
      `  printf '%s' '${JSON.stringify(meta)}'`,
      '  exit 0',
      'fi',
      'if [[ "$1" == "issue" && "$2" == "view" ]]; then',
      `  printf '%s' '{"number":251,"title":"分片审核","body":"任务书"}'`,
      'fi',
      '',
    ].join('\n'),
  )
  const git = fakeBin(dir, 'git', `#!/bin/bash\ncat <<'SHARD_DIFF'\n${DIFF}SHARD_DIFF\n`)
  return { dir, gh, git }
}

function shardRecord({ index, total, verdict = 'APPROVE', round = 1, findings = [], evidence = [], errorCode }) {
  const record = {
    schemaVersion: 1,
    policyVersion: '0.1.0',
    pr: PR,
    round,
    verdict,
    head_sha: SHA,
    nonce: NONCE,
    findings,
    evidence,
    form: 'cli',
    provider: 'stub',
    model: 'stub/model',
    policy: { hit: false, reasons: [] },
    createdAt: new Date().toISOString(),
    shard: { index, total },
  }
  if (errorCode !== undefined) record.errorCode = errorCode
  return record
}

function writeShard(dir, options) {
  const record = shardRecord(options)
  const file = join(dir, shardRecordName(PR, SHA, options))
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  return file
}

test('parseShardSpec 只接受 i/n，越界与含糊写法都报错', () => {
  assert.deepEqual(parseShardSpec('2/3'), { index: 2, total: 3 })
  assert.deepEqual(parseShardSpec(' 1 / 2 '), { index: 1, total: 2 })
  for (const bad of ['0/3', '4/3', '2/0', '2', 'a/b', '2/3/4', true, undefined]) {
    assert.throws(() => parseShardSpec(bad), /--shard/, `${String(bad)} 应被拒绝`)
  }
})

test('分片覆盖完备：每个文件恰好落在一片，不重不漏', () => {
  const sections = splitDiffByFile(DIFF)
  assert.equal(sections.length, FILES.length, '每个文件一段')
  assert.deepEqual(sections.map((section) => section.path), FILES)

  for (const total of [1, 2, 3, 5]) {
    const seen = new Map()
    for (let index = 1; index <= total; index += 1) {
      const picked = pickShard(sections, { index, total })
      assert.equal(new Set(picked.files).size, picked.files.length, `第 ${index}/${total} 片内部不能重复`)
      for (const path of picked.files) seen.set(path, (seen.get(path) ?? 0) + 1)
    }
    assert.deepEqual(FILES.filter((path) => !seen.has(path)), [], `n=${total} 时不应漏文件`)
    assert.equal(seen.size, FILES.length)
    for (const [path, count] of seen) assert.equal(count, 1, `${path} 只能出现在一片里`)
  }

  // 均衡：最大片与最小片的行数差不该离谱（5 个文件切 3 片）
  const weights = [1, 2, 3].map((index) => pickShard(sections, { index, total: 3 }).text.split('\n').length)
  assert.ok(Math.max(...weights) - Math.min(...weights) <= 8, `分片行数应大致均衡：${weights}`)
})

test('--shard 2/3 的 request：diff 只含该片、files 只含该片、同一 head_sha、独立 nonce', (t) => {
  const { dir, gh, git } = prepareSandbox(t)
  const requests = [1, 2, 3].map(
    (index) => prepareRequest({ pr: PR, cwd: dir, ghBin: gh, gitBin: git, shard: { index, total: 3 } }).request,
  )
  const second = requests[1]

  assert.deepEqual(second.shard, { index: 2, total: 3, files: second.files })
  assert.ok(second.files.length > 0)
  assert.ok(second.files.length < FILES.length, '第 2 片不该包含全部文件')

  // 围栏内只能出现该片的文件段落
  const inner = second.diff.split('\n').slice(1, -1).join('\n')
  const paths = splitDiffByFile(inner).map((section) => section.path)
  assert.deepEqual(paths, second.files, 'diff 段落必须与 files 一致')

  // 同一提交、不同 nonce
  assert.deepEqual(requests.map((request) => request.head_sha), [SHA, SHA, SHA])
  assert.equal(new Set(requests.map((request) => request.nonce)).size, 3, '每片必须有自己的 nonce')
})

test('record 把请求里的 shard 写进记录，并且不留下能被闸门读到的规范文件名', (t) => {
  const { dir, gh, git } = prepareSandbox(t)
  const root = tmp('dsh-subagents-shard-root-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const reviews = reviewsDirOf(root)

  const { request } = prepareRequest({ pr: PR, cwd: dir, ghBin: gh, gitBin: git, shard: { index: 2, total: 3 } })
  const requestFile = join(root, 'req.json')
  const responseFile = join(root, 'res.txt')
  writeFileSync(requestFile, `${JSON.stringify({ request }, null, 2)}\n`)
  writeFileSync(responseFile, `${request.nonce} VERDICT: APPROVE SHA: ${SHA}\n`)

  // 桩包：模拟共享包「写规范文件 + stdout 输出记录 JSON」
  const home = tmp('dsh-pipeline-stub-')
  mkdirSync(join(home, 'bin'), { recursive: true })
  const canonical = join(reviews, `${PR}-${SHA}.json`)
  writeFileSync(
    join(home, 'bin', 'cli.mjs'),
    ['#!/bin/sh', 'printf \'%s\' "$DSH_STUB_RECORD" > "$DSH_STUB_TARGET"', 'printf \'%s\' "$DSH_STUB_RECORD"', ''].join(
      '\n',
    ),
    { mode: 0o755 },
  )

  const out = spawnSync(
    process.execPath,
    [CLI, 'record', '--request', requestFile, '--response', responseFile, '--root', root],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_PIPELINE_HOME: home,
        DSH_STUB_RECORD: JSON.stringify(shardRecord({ index: 2, total: 3 })),
        DSH_STUB_TARGET: canonical,
      },
    },
  )
  assert.equal(out.status, 0, `stderr: ${out.stderr}`)

  const shardFile = join(reviews, shardRecordName(PR, SHA, { index: 2, total: 3 }))
  assert.ok(existsSync(shardFile), `应写出分片记录：${shardFile}`)
  const written = JSON.parse(readFileSync(shardFile, 'utf8'))
  assert.deepEqual(written.shard, { index: 2, total: 3 })
  assert.equal(written.verdict, 'APPROVE')
  assert.equal(existsSync(canonical), false, '规范文件名必须删掉，否则一片就能过闸门')
  assert.match(out.stdout, /已写入分片审核记录/)
})

test('合成四情形：全 APPROVE / 有 REJECT / 有 ESCALATE / 缺片报错', (t) => {
  const all = (verdicts) =>
    aggregateShardRecords({
      total: 3,
      entries: verdicts.map((verdict, i) => ({
        index: i + 1,
        total: 3,
        record: shardRecord({ index: i + 1, total: 3, verdict }),
      })),
    })

  assert.equal(all(['APPROVE', 'APPROVE', 'APPROVE']).verdict, 'APPROVE')
  assert.equal(all(['APPROVE', 'REJECT', 'APPROVE']).verdict, 'REJECT')
  assert.equal(all(['APPROVE', 'ESCALATE', 'APPROVE']).verdict, 'ESCALATE')
  assert.equal(all(['ESCALATE', 'REJECT', 'APPROVE']).verdict, 'REJECT', 'REJECT 优先于 ESCALATE')

  // 缺片：CLI 必须退出 2，消息点名缺第几片
  const root = tmp('dsh-subagents-shard-missing-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = reviewsDirOf(root)
  writeShard(dir, { index: 1, total: 3 })
  writeShard(dir, { index: 3, total: 3 })

  const out = spawnSync(
    process.execPath,
    [CLI, 'record', '--aggregate', '--pr', String(PR), '--head-sha', SHA, '--root', root],
    { encoding: 'utf8' },
  )
  assert.equal(out.status, 2)
  assert.match(out.stderr, /缺第 2 片/)
  assert.equal(existsSync(join(dir, `${PR}-${SHA}.json`)), false, '缺片时不得写出合成记录')
})

test('findings / evidence 拼接带片号前缀，且按片号排序', () => {
  const record = aggregateShardRecords({
    total: 3,
    entries: [
      {
        index: 2,
        total: 3,
        record: shardRecord({
          index: 2,
          total: 3,
          findings: [{ severity: 'major', file: 'b.js', line: 3, message: '第二片的问题' }],
          evidence: ['第二片的证据'],
        }),
      },
      {
        index: 1,
        total: 3,
        record: shardRecord({
          index: 1,
          total: 3,
          findings: [{ severity: 'nit', file: 'a.js', line: 1, message: '第一片的问题' }],
          evidence: ['第一片的证据'],
        }),
      },
      {
        index: 3,
        total: 3,
        record: shardRecord({
          index: 3,
          total: 3,
          findings: [{ severity: 'minor', file: 'c.js', line: 9, message: '第三片的问题' }],
          evidence: ['第三片的证据'],
        }),
      },
    ],
  })

  assert.deepEqual(
    record.findings.map((finding) => finding.message),
    ['[1/3] 第一片的问题', '[2/3] 第二片的问题', '[3/3] 第三片的问题'],
  )
  assert.deepEqual(record.evidence, ['[1/3] 第一片的证据', '[2/3] 第二片的证据', '[3/3] 第三片的证据'])
  assert.equal(record.findings[0].file, 'a.js', '片号只加到 message，不改其他字段')
})

test('合成记录不含 shard、round 沿用各片、能过共享包的 validateRecord', async (t) => {
  const { cli } = resolvePipelineCli({ root: process.cwd() })
  if (cli === null) {
    t.skip('没有共享 pipeline 包，跳过 validateRecord 检查')
    return
  }
  const { validateRecord } = await import(new URL('../lib/record.mjs', new URL(`file://${cli}`)))

  const root = tmp('dsh-subagents-shard-agg-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = reviewsDirOf(root)
  for (const index of [1, 2, 3]) writeShard(dir, { index, total: 3, round: 2 })

  const collected = collectShardRecords(dir, PR, SHA)
  assert.deepEqual(collected.missing, [])
  const record = aggregateShardRecords(collected)
  const file = writeAggregateRecord(dir, record)
  const stored = JSON.parse(readFileSync(file, 'utf8'))

  assert.equal('shard' in stored, false, '合成记录代表整份变更，不能带 shard')
  assert.equal(stored.round, 2, 'round 沿用各片')
  const result = validateRecord(stored)
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true, `合成记录必须过 validateRecord: ${result.errors.join('; ')}`)

  // 轮次不一致必须报错，不能挑一个
  writeShard(dir, { index: 2, total: 3, round: 1 })
  assert.throws(() => aggregateShardRecords(collectShardRecords(dir, PR, SHA)), /轮次不一致/)
})

test('record --aggregate 写出闸门读的规范记录，缺片时绝不写', (t) => {
  const root = tmp('dsh-subagents-shard-cli-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = reviewsDirOf(root)
  for (const index of [1, 2, 3]) {
    writeShard(dir, {
      index,
      total: 3,
      verdict: index === 2 ? 'ESCALATE' : 'APPROVE',
      findings: [{ severity: 'minor', file: `${index}.js`, line: 1, message: '待确认' }],
    })
  }

  const out = spawnSync(
    process.execPath,
    [CLI, 'record', '--aggregate', '--pr', String(PR), '--head-sha', SHA, '--root', root],
    { encoding: 'utf8' },
  )
  assert.equal(out.status, 1, 'ESCALATE 不是 APPROVE，退出码 1')
  assert.match(out.stdout, /已写入合成审核记录/)

  const canonical = join(dir, `${PR}-${SHA}.json`)
  assert.ok(existsSync(canonical), '合成记录必须落到闸门读的规范文件名')
  const stored = JSON.parse(readFileSync(canonical, 'utf8'))
  assert.equal(stored.verdict, 'ESCALATE')
  assert.equal('shard' in stored, false)
  assert.deepEqual(
    stored.findings.map((finding) => finding.message),
    ['[1/3] 待确认', '[2/3] 待确认', '[3/3] 待确认'],
  )
})

test('分片文件名可解析，且不会与规范记录混淆', () => {
  const name = shardRecordName(PR, SHA, { index: 3, total: 4 })
  assert.deepEqual(parseShardRecordName(name), { pr: PR, headSha: SHA, index: 3, total: 4 })
  assert.equal(parseShardRecordName(`${PR}-${SHA}.json`), null)
})
