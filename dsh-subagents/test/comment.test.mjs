import test from 'node:test'
import assert from 'node:assert/strict'
import { renderComment } from '../lib/comment.js'

const result = {
  verdict: 'REJECT',
  head_sha: 'a'.repeat(40),
  form: 'cli',
  model: 'codebuddy/glm-5.3',
  durationMs: 51000,
  traceId: '20261101T021500Z-a1b2c3d4',
  errorCode: null,
  findings: [
    { severity: 'blocker', file: 'lib/cli.js', line: 120, message: '重复命中应报 E_PARSE' },
    { severity: 'major', file: 'lib/record.js', line: 44, message: '熔断日期未区分时区' },
    { severity: 'nit', file: 'test/cli.test.mjs', line: 96, message: '断言可以更严' },
  ],
  evidence: ['lib/cli.js:118-124', 'test/cli.test.mjs:96'],
}

test('renderComment 渲染判定与轮次', () => {
  const text = renderComment({ result, round: 2 })
  assert.match(text, /^## 审核判定：REQUEST_CHANGES（第 2 次 \/ 共 3 次）/)
  assert.match(text, /\*\*提交\*\*：a{40}/)
  assert.match(text, /\*\*形态\/模型\*\*：cli \/ codebuddy\/glm-5\.3/)
  assert.match(text, /\*\*耗时\*\*：51s/)
})

test('renderComment 按严重度分成必须修与建议', () => {
  const text = renderComment({ result, round: 1 })
  const mustFix = text.split('### 必须修')[1].split('### 建议')[0]
  const suggestions = text.split('### 建议（不阻塞）')[1].split('### 证据')[0]
  assert.match(mustFix, /lib\/cli\.js:120/)
  assert.match(mustFix, /lib\/record\.js:44/)
  assert.doesNotMatch(mustFix, /test\/cli\.test\.mjs:96/)
  assert.match(suggestions, /test\/cli\.test\.mjs:96/)
})

test('renderComment 无 findings 时给出（无）', () => {
  const text = renderComment({ result: { ...result, verdict: 'APPROVE', findings: [] }, round: 1 })
  assert.match(text, /^## 审核判定：APPROVE/)
  assert.match(text, /### 必须修\n- （无）/)
})

test('renderComment 对 ESCALATE 带错误码', () => {
  const text = renderComment({ result: { ...result, verdict: 'ESCALATE', errorCode: 'E_POLICY' }, round: 3 })
  assert.match(text, /ESCALATE（交回人工）（第 3 次 \/ 共 3 次）/)
  assert.match(text, /\*\*错误码\*\*：E_POLICY/)
})

test('renderComment 缺 verdict 或缺轮次时报错', () => {
  assert.throws(() => renderComment({ result: {}, round: 1 }), /缺少 result\.verdict/)
  assert.throws(() => renderComment({ result, round: 0 }), /round/)
})

test('safeInline 压平换行、转义反引号与 @', async () => {
  const { safeInline } = await import('../lib/comment.js')
  assert.equal(safeInline('第一行\n第二行'), '第一行 第二行')
  assert.equal(safeInline('代码 `x`'), "代码 'x'")
  assert.equal(safeInline('@someone'), '@\u200bsomeone')
})

test('renderComment 的证据走行内代码并压平', () => {
  const text = renderComment({
    result: { ...result, evidence: ['lib/a.js:1\n```block```'] },
    round: 1,
  })
  const evidence = text.split('### 证据')[1]
  assert.match(evidence, /^- `lib\/a\.js:1 /mu)
  assert.doesNotMatch(evidence, /```/)
})
