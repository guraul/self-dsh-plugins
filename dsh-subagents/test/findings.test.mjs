import test from 'node:test'
import assert from 'node:assert/strict'
import { extractFindings, normalizeEvidence, normalizeFinding } from '../lib/findings.js'

const block = (value) => '```json\n' + JSON.stringify(value) + '\n```'

test('extractFindings 解析合法代码块', () => {
  const text = `分析若干\n${block({
    findings: [
      { severity: 'blocker', file: 'lib/cli.js', line: 120, message: '应报 E_PARSE' },
      { severity: 'nit', file: 'a.md', line: 1, message: '措辞' },
    ],
    evidence: ['lib/cli.js:118-124'],
  })}\nNONCE VERDICT: APPROVE SHA: ${'a'.repeat(40)}`
  const parsed = extractFindings(text)
  assert.equal(parsed.findings.length, 2)
  assert.equal(parsed.findings[0].severity, 'blocker')
  assert.deepEqual(parsed.evidence, ['lib/cli.js:118-124'])
})

test('extractFindings 无代码块返回 null', () => {
  assert.equal(extractFindings('只有散文，没有 json'), null)
  assert.equal(extractFindings(''), null)
})

test('extractFindings 坏 JSON 返回 null', () => {
  assert.equal(extractFindings('```json\n{不是 json}\n```'), null)
})

test('extractFindings 跳过非法项但仍返回合法项', () => {
  const text = block({
    findings: [
      { severity: 'fatal', file: 'a', line: 1, message: 'x' },
      { severity: 'major', file: 'b', line: 2, message: 'ok' },
    ],
    evidence: ['b:2', '', 3],
  })
  const parsed = extractFindings(text)
  assert.equal(parsed.findings.length, 1)
  assert.equal(parsed.findings[0].file, 'b')
  assert.deepEqual(parsed.evidence, ['b:2'])
})

test('extractFindings 整块都非法时继续找下一个块', () => {
  const bad = block({ findings: [{ severity: 'nope', file: 'a', line: 1, message: 'x' }] })
  const good = block({ findings: [{ severity: 'minor', file: 'c', line: 3, message: 'ok' }] })
  assert.equal(extractFindings(`${bad}\n${good}`).findings[0].file, 'c')
})

test('extractFindings 允许空 findings', () => {
  const parsed = extractFindings(block({ findings: [], evidence: [] }))
  assert.deepEqual(parsed.findings, [])
})

test('normalizeFinding 拒绝非法字段', () => {
  assert.equal(normalizeFinding(null), null)
  assert.equal(normalizeFinding({ severity: 'major', file: '', line: 1, message: 'm' }), null)
  assert.equal(normalizeFinding({ severity: 'major', file: 'a', line: -1, message: 'm' }), null)
  assert.equal(normalizeFinding({ severity: 'major', file: 'a', line: 1, message: '' }), null)
})

test('normalizeEvidence 只保留非空字符串', () => {
  assert.deepEqual(normalizeEvidence(['a', '', null, 1]), ['a'])
  assert.deepEqual(normalizeEvidence('not array'), [])
})

test('extractFindings 前面有非 json 代码块时仍能取到真块（PR151 事故回归）', () => {
  const text = '```bash\necho hi\n```\n```json\n' + JSON.stringify({
    findings: [{ severity: 'major', file: 'a.js', line: 1, message: 'm' }],
    evidence: ['a.js:1'],
  }) + '\n```'
  const parsed = extractFindings(text)
  assert.ok(parsed, '真块不能被前面的 bash 块吞掉')
  assert.equal(parsed.findings[0].file, 'a.js')
})

test('extractFindings 忽略 ``` 无语言标记的块', () => {
  assert.equal(extractFindings('```\n{"findings":[]}\n```'), null)
})
