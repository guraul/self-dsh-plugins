import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bumpCircuit,
  findByTrace,
  isExpired,
  localDate,
  readCircuit,
  readRecord,
  recordFile,
  reviewsDir,
  traceId,
  writeRecord,
  writeSkipAudit,
} from '../lib/record.js'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-subagents-'))
}

const SHA = 'c'.repeat(40)

test('traceId 格式符合 schema', () => {
  assert.match(traceId(new Date('2026-10-31T12:15:00Z')), /^20261031T121500Z-[0-9a-f]{8}$/)
})

test('writeRecord 与 readRecord 往返', () => {
  const dir = reviewsDir(tmp())
  const record = { pr: 7, head_sha: SHA, verdict: 'APPROVE', traceId: 'x', createdAt: new Date().toISOString() }
  const file = writeRecord(dir, record)
  assert.equal(file, recordFile(dir, 7, SHA))
  assert.deepEqual(readRecord(file), record)
})

test('isExpired 按 30 分钟判定', () => {
  const now = Date.parse('2026-10-31T12:00:00Z')
  assert.equal(isExpired({ createdAt: '2026-10-31T11:45:00Z' }, now), false)
  assert.equal(isExpired({ createdAt: '2026-10-31T11:29:00Z' }, now), true)
  assert.equal(isExpired({}), true)
})

test('熔断连续 3 次触发，之后保持 tripped', () => {
  const dir = reviewsDir(tmp())
  const day = new Date('2026-10-31T10:00:00Z')
  assert.equal(readCircuit(dir, day).tripped, false)
  bumpCircuit(dir, day)
  bumpCircuit(dir, day)
  assert.equal(readCircuit(dir, day).tripped, false)
  const tripped = bumpCircuit(dir, day)
  assert.equal(tripped.tripped, true)
  assert.equal(readCircuit(dir, day).consecutiveFailures, 3)
})

test('熔断跨天清零', () => {
  const dir = reviewsDir(tmp())
  const day1 = new Date('2026-10-31T10:00:00Z')
  bumpCircuit(dir, day1)
  bumpCircuit(dir, day1)
  bumpCircuit(dir, day1)
  assert.equal(readCircuit(dir, day1).tripped, true)
  const day2 = new Date('2026-11-01T10:00:00Z')
  assert.deepEqual(readCircuit(dir, day2), {
    date: localDate(day2),
    consecutiveFailures: 0,
    tripped: false,
  })
})

test('writeSkipAudit 落一条可读记录', () => {
  const dir = reviewsDir(tmp())
  const file = writeSkipAudit(dir, { pr: 9, headSha: SHA, reason: '用户口头同意', now: new Date('2026-10-31T12:00:00Z') })
  assert.equal(existsSync(file), true)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(stored.pr, 9)
  assert.equal(stored.head_sha, SHA)
  assert.equal(stored.reason, '用户口头同意')
})

test('findByTrace 扫目录命中且跳过坏文件', () => {
  const dir = reviewsDir(tmp())
  writeRecord(dir, { pr: 1, head_sha: SHA, traceId: 'T-1', createdAt: new Date().toISOString() })
  writeRecord(dir, { pr: 2, head_sha: 'd'.repeat(40), traceId: 'T-2', createdAt: new Date().toISOString() })
  assert.equal(findByTrace(dir, 'T-1').length, 1)
  assert.equal(findByTrace(dir, 'T-1')[0].pr, 1)
  assert.deepEqual(findByTrace(dir, 'missing'), [])
})
