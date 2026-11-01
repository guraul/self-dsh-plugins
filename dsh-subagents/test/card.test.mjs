import test from 'node:test'
import assert from 'node:assert/strict'
import { CardError, MAX_ROUNDS, parseCard, renderCard } from '../lib/card.js'

const base = {
  role: 'executor',
  goal: '修复 PR #138 的审核问题',
  round: 2,
  boundaries: ['只改 comment 里「必须修」列出的位置'],
  acceptance: ['node --test dsh-subagents 全过'],
  pointers: ['PR #138', 'issue #138'],
}

test('renderCard 渲染出轮次与三个区块', () => {
  const text = renderCard(base)
  assert.match(text, /角色: executor/)
  assert.match(text, /轮次: 第 2 次 \/ 共 3 次/)
  assert.match(text, /边界:\n- 只改/)
  assert.match(text, /验收:\n- node --test/)
  assert.match(text, /指针:\n- PR #138/)
})

test('renderCard 与 parseCard 往返一致', () => {
  const parsed = parseCard(renderCard(base))
  assert.equal(parsed.role, base.role)
  assert.equal(parsed.goal, base.goal)
  assert.equal(parsed.round, 2)
  assert.equal(parsed.maxRounds, MAX_ROUNDS)
  assert.deepEqual(parsed.boundaries, base.boundaries)
  assert.deepEqual(parsed.acceptance, base.acceptance)
  assert.deepEqual(parsed.pointers, base.pointers)
})

test('renderCard 缺字段时指出缺哪个', () => {
  const { boundaries, ...rest } = base
  assert.throws(() => renderCard(rest), (error) => {
    assert.ok(error instanceof CardError)
    assert.ok(error.missing.includes('boundaries'))
    return true
  })
})

test('renderCard 拒绝空数组与非法轮次', () => {
  assert.throws(() => renderCard({ ...base, acceptance: [] }), CardError)
  assert.throws(() => renderCard({ ...base, round: 0 }), CardError)
  assert.throws(() => renderCard({ ...base, round: 1.5 }), CardError)
})

test('renderCard 拒绝超过上限的轮次', () => {
  assert.throws(() => renderCard({ ...base, round: 4 }), /round>3/)
  assert.equal(parseCard(renderCard({ ...base, round: 3 })).round, 3)
})

test('renderCard 支持自定义上限', () => {
  const text = renderCard({ ...base, round: 5, maxRounds: 5 })
  assert.match(text, /第 5 次 \/ 共 5 次/)
})
