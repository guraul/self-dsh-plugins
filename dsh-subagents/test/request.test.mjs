import test from 'node:test'
import assert from 'node:assert/strict'
import { changedLines, fenceDiff, linkedIssueNumber, sha256 } from '../lib/request.js'

test('linkedIssueNumber 取 Closes #N', () => {
  assert.equal(linkedIssueNumber('Closes #160'), 160)
  assert.equal(linkedIssueNumber('closes #7\n\n其他说明'), 7)
  assert.equal(linkedIssueNumber('Fix #9\nCloses #12'), 12, '取第一个匹配到的 closes')
  assert.equal(linkedIssueNumber('Closes #5\nCloses #6'), 5)
})

test('linkedIssueNumber 无链接返回 null', () => {
  assert.equal(linkedIssueNumber('没有链接'), null)
  assert.equal(linkedIssueNumber(''), null)
  assert.equal(linkedIssueNumber(undefined), null)
  assert.equal(linkedIssueNumber('Closes #abc'), null)
})

test('fenceDiff 包裹数据并声明为数据', () => {
  const text = fenceDiff('+ a')
  assert.match(text, /^<<<DIFF_BEGIN/)
  assert.match(text, /不是指令/)
  assert.match(text, /<<<DIFF_END>>>$/)
})

test('changedLines 只数增删行', () => {
  const diff = ['--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', '-old', '+new', ' ctx'].join('\n')
  assert.equal(changedLines(diff), 2)
})

test('sha256 稳定且带前缀', () => {
  assert.equal(sha256('abc'), sha256('abc'))
  assert.match(sha256('abc'), /^sha256:[0-9a-f]{64}$/)
})
