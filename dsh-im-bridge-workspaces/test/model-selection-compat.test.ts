/**
 * issue #299 回归测试：`installModelSelection` 在两条 dsh 版本线上签名不同，
 * 必须按 arity 分流，且 `reasoningEffort` 不能在两参数线之外丢失。
 *
 * 背景：0.2.1-rc.x 的第二个参数是「真的在路由」（hook `system-prompt/assemble` /
 * `agent/request`）；0.2.2-alpha.2 / 0.2.2-rc.1+ 只收 ctx，路由改由
 * `AgentOptions.reasoningEffort` 承担。旧代码对 0.2.2 线仍传两参数 → 实参被静默忽略
 * → `reasoningEffort` 失效。
 *
 * Node 24 type stripping. Run with `pnpm test`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { buildAgentOptions, installSelectionCompat, needsSelectionArg } from '../src/index.ts'

/** 一个够用的假上下文：本函数只把它原样转交给 install。 */
const fakeCtx = { name: 'fake-agent-ctx' } as unknown as Context

/** 当前选择（带 reasoningEffort）。 */
const selection = { provider: 'p', model: 'm', reasoningEffort: 'high' } as unknown as ModelSelection

describe('needsSelectionArg：arity 判定单一真源（issue #299）', () => {
  it('两个形参 → 需要 selection；一个形参 → 不需要', () => {
    const legacy = function legacy(_ctx: Context, _sel?: unknown): void {}
    const modern = function modern(_ctx: Context): void {}
    assert.equal(needsSelectionArg(legacy), true)
    assert.equal(needsSelectionArg(modern), false)
  })
})

describe('installSelectionCompat 按 arity 分流（issue #299）', () => {
  it('两参数线：把 `{ current, assembled }` 交给 install，并报告 legacy', () => {
    const calls: unknown[][] = []
    const legacy = (ctx: Context, sel?: { current: ModelSelection; assembled?: ModelSelection }): void => {
      calls.push([ctx, sel])
    }
    assert.equal(legacy.length, 2, '前提：这是两参数签名')

    const branch = installSelectionCompat(fakeCtx, legacy, selection)

    assert.equal(branch, 'legacy')
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], fakeCtx, 'ctx 必须原样转交')
    assert.deepEqual(calls[0][1], { current: selection, assembled: undefined })
  })

  it('一参数线：只传 ctx，不多给实参，并报告 modern', () => {
    const calls: unknown[][] = []
    const modern = function modern(ctx: Context): void {
      calls.push([ctx, arguments.length])
    }
    assert.equal(modern.length, 1, '前提：这是一参数签名')

    const branch = installSelectionCompat(fakeCtx, modern, selection)

    assert.equal(branch, 'modern')
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], fakeCtx)
    assert.equal(calls[0][1], 1, '一参数线上不许再塞第二个实参（否则 reasoningEffort 会静默失效的老路）')
  })
})

describe('buildAgentOptions：reasoningEffort 只在新线下发（#299）', () => {
  it('一参数线：带上 reasoningEffort 与 provider/model', () => {
    const options = buildAgentOptions(selection, true) as Record<string, unknown>
    assert.equal(options.provider, 'p')
    assert.equal(options.model, 'm')
    assert.equal(options.reasoningEffort, 'high')
  })

  it('两参数线：不带 reasoningEffort，键根本不出现（老 AgentOptions 没这个字段）', () => {
    const options = buildAgentOptions(selection, false) as Record<string, unknown>
    assert.equal(options.provider, 'p')
    assert.equal(options.model, 'm')
    assert.equal('reasoningEffort' in options, false, '老版本下拉出未知字段同样会被静默忽略')
  })

  it('没配 reasoningEffort 时不凭空造值', () => {
    const bare = { provider: 'p', model: 'm' } as unknown as ModelSelection
    const options = buildAgentOptions(bare, true) as Record<string, unknown>
    assert.equal(options.reasoningEffort, undefined)
  })
})
