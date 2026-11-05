import test from 'node:test'
import assert from 'node:assert/strict'

import {
  failedResults,
  maybeReportSmokeFailures,
  safeDetail,
  planSmokeIssue,
  smokeIssueBody,
  smokeIssueTitle,
} from '../lib/host/smoke-issue.js'

/** 一个通过的结果（含 partial：兜底三项过了、行为未验证）。 */
const passing = { name: 'p', ok: true, partial: true, checks: [{ name: 'bundle', ok: true }] }
/** 一个失败的结果。 */
const failing = {
  name: 'dsh-im-bridge',
  ok: false,
  partial: false,
  checks: [
    { name: 'bundle', ok: true },
    { name: '分流判定与运行时 arity 一致', ok: false, detail: 'arity=1 → needsSelectionArg=true' },
  ],
}

test('failedResults：只挑 ok=false，partial（没写 dsh.smoke）不算失败', () => {
  assert.deepEqual(failedResults([passing, failing]), [failing])
  assert.deepEqual(failedResults([passing]), [], 'partial 也是 ok=true，绝不该开 issue')
  assert.deepEqual(failedResults(undefined), [])
})

test('planSmokeIssue：全过就不开单；有失败才给标题与正文', () => {
  assert.equal(planSmokeIssue({ version: '1.0.0', results: [passing] }).needed, false)

  const plan = planSmokeIssue({ version: '0.2.2-rc.1', results: [passing, failing] })
  assert.equal(plan.needed, true)
  assert.equal(plan.failed.length, 1)
  assert.match(plan.title, /升级到 0\.2\.2-rc\.1 后 1 个插件冒烟失败/)
  assert.match(plan.title, /dsh-im-bridge/)
})

test('smokeIssueTitle：插件名超过 3 个折叠成「等 N 个」', () => {
  const failed = ['a', 'b', 'c', 'd'].map((name) => ({ name, ok: false, checks: [] }))
  const title = smokeIssueTitle({ version: '9.9.9', failed })
  assert.match(title, /4 个插件冒烟失败/)
  assert.match(title, /a、b、c 等 4 个/)
  assert.equal(title.includes('、d'), false, '第四个名字要折叠掉')
})

test('smokeIssueBody：逐插件列出失败断言与说明，并给复现命令', () => {
  const body = smokeIssueBody({ version: '0.2.2-rc.1', failed: [failing], at: 1_700_000_000_000 })
  assert.match(body, /装得上，但行为坏了/)
  assert.match(body, /\| `dsh-im-bridge` \|/, '要有插件行')
  assert.match(body, /分流判定与运行时 arity 一致/, '要点名失败断言')
  assert.match(body, /arity=1 → needsSelectionArg=true/, '要带出 detail')
  assert.match(body, /POST http:\/\/127\.0\.0\.1:3080\/api\/dsh-auto-upgrade\/smoke/, '要给复现命令')
  assert.match(body, /不会重复开单/, '要去重说明')
})

test('smokeIssueBody：整体失败（没有单项 checks）也要说清', () => {
  const body = smokeIssueBody({
    version: '9.9.9',
    failed: [{ name: 'x', ok: false, detail: 'import 失败：ENOENT' }],
  })
  assert.match(body, /（整体失败）/)
  assert.match(body, /import 失败：ENOENT/)
})

test('maybeReportSmokeFailures：全过不开单，且根本不调 gh', async () => {
  let called = 0
  const result = await maybeReportSmokeFailures({
    version: '1.0.0', results: [passing], slug: 'o/r',
    report: async () => { called += 1; return { number: 1 } },
  })
  assert.deepEqual(result, { opened: false, reason: 'no-failures' })
  assert.equal(called, 0)
})

test('maybeReportSmokeFailures：没有 repository 就不开单，也不抛', async () => {
  const result = await maybeReportSmokeFailures({
    version: '1.0.0', results: [failing], slug: undefined,
    report: async () => { throw new Error('不该被调用') },
  })
  assert.deepEqual(result, { opened: false, reason: 'no-slug' })
})

test('maybeReportSmokeFailures：有失败就开单并把编号带回来', async () => {
  const seen = []
  const result = await maybeReportSmokeFailures({
    version: '0.2.2-rc.1', results: [failing], slug: 'o/r',
    report: async (input) => { seen.push(input); return { number: 42, created: true } },
  })
  assert.equal(result.opened, true)
  assert.equal(result.number, 42)
  assert.equal(result.created, true)
  assert.match(seen[0].title, /冒烟失败/)
  assert.equal(seen[0].slug, 'o/r')
})

test('maybeReportSmokeFailures：开单失败被降级成 reason，绝不把冒烟本身弄挂', async () => {
  const result = await maybeReportSmokeFailures({
    version: '1.0.0', results: [failing], slug: 'o/r',
    report: async () => { throw new Error('gh 未登录') },
  })
  assert.equal(result.opened, false)
  assert.match(result.reason, /report-failed.*gh 未登录/)
})

test('safeDetail：抹掉本机家目录并截断，避免把本机信息写进 issue', () => {
  assert.equal(safeDetail('/Users/gubin/repo/x.mjs 不存在'), '~/repo/x.mjs 不存在')
  assert.equal(safeDetail('short'), 'short')
  assert.equal(safeDetail(undefined), '')
  assert.ok(safeDetail('x'.repeat(500)).length <= 200)
})

test('maybeReportSmokeFailures：version 缺失时用 unknown，不丢开单', async () => {
  const seen = []
  const result = await maybeReportSmokeFailures({
    version: undefined, results: [failing], slug: 'o/r',
    report: async (input) => { seen.push(input); return { number: 7, created: true } },
  })
  assert.equal(result.opened, true)
  assert.match(seen[0].title, /unknown/)
})

test('safeDetail：表格分隔符与换行也要清掉，否则正文表格会被打散', () => {
  assert.equal(safeDetail('a|b' + String.fromCharCode(10) + 'c'), 'a b c')
})
