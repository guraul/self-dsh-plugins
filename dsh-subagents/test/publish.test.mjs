import test from 'node:test'
import assert from 'node:assert/strict'
import { ghCommands, publishPlan, reviewAction } from '../lib/publish.js'

const record = {
  pr: 42,
  verdict: 'APPROVE',
  head_sha: 'a'.repeat(40),
  form: 'cli',
  model: 'codebuddy/glm-5.3-flash',
  durationMs: 51000,
  traceId: '20261101T021500Z-a1b2c3d4',
  findings: [],
  evidence: ['lib/a.js:1'],
}

test('reviewAction 三值映射', () => {
  assert.equal(reviewAction('APPROVE'), 'approve')
  assert.equal(reviewAction('REJECT'), 'request-changes')
  assert.equal(reviewAction('ESCALATE'), 'none')
  assert.equal(reviewAction('UNKNOWN'), 'none')
})

test('publishPlan 渲染评论并给出动作', () => {
  const plan = publishPlan({ record, round: 2 })
  assert.match(plan.commentBody, /^## 审核判定：APPROVE（第 2 次 \/ 共 3 次）/)
  assert.equal(plan.action, 'approve')
  assert.match(plan.reviewBody, /审核通过/)
})

test('publishPlan 对 ESCALATE 不产生 review 动作', () => {
  const plan = publishPlan({ record: { ...record, verdict: 'ESCALATE', errorCode: 'E_POLICY' }, round: 1 })
  assert.equal(plan.action, 'none')
})

test('publishPlan 缺 verdict 时报错', () => {
  assert.throws(() => publishPlan({ record: {}, round: 1 }), /缺少 verdict/)
})

test('ghCommands 组装评论与 review 两条命令', () => {
  const plan = publishPlan({ record: { ...record, verdict: 'REJECT' }, round: 1 })
  const commands = ghCommands({ plan, pr: 42, repo: 'o/r' })
  assert.equal(commands.length, 2)
  assert.deepEqual(commands[0].args.slice(0, 3), ['pr', 'comment', '42'])
  assert.ok(commands[0].args.includes('--body-file'))
  assert.deepEqual(commands[1].args.slice(0, 3), ['pr', 'review', '42'])
  assert.ok(commands[1].args.includes('--request-changes'))
  assert.equal(commands[1].stdin, null)
})

test('ghCommands 对 ESCALATE 只发评论', () => {
  const plan = publishPlan({ record: { ...record, verdict: 'ESCALATE' }, round: 1 })
  const commands = ghCommands({ plan, pr: 42, repo: 'o/r' })
  assert.equal(commands.length, 1)
  assert.ok(!commands[0].args.includes('--approve'))
})

test('parseRemoteUrl 支持 SSH 与 HTTPS', async () => {
  const { parseRemoteUrl } = await import('../lib/publish.js')
  assert.equal(parseRemoteUrl('git@github.com:guraul/self-dsh-plugins.git'), 'guraul/self-dsh-plugins')
  assert.equal(parseRemoteUrl('https://github.com/guraul/self-dsh-plugins.git'), 'guraul/self-dsh-plugins')
  assert.equal(parseRemoteUrl('https://github.com/guraul/self-dsh-plugins'), 'guraul/self-dsh-plugins')
  assert.equal(parseRemoteUrl('不是 URL'), null)
})
