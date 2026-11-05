/**
 * issue #299 回归测试：`installModelSelection` 在两条 dsh 版本线上签名不同，
 * `installSelectionCompat` 必须按 arity 分流，且 `reasoningEffort` 不能在两参数线之外丢失。
 *
 * 背景：0.2.1-rc.x 的第二个参数是「真的在路由」（hook `system-prompt/assemble` /
 * `agent/request`）；0.2.2-rc.1+ 只收 ctx，路由改由 `AgentOptions.reasoningEffort`
 * 承担。旧代码对 rc.1 仍传两参数 → 实参被静默忽略 → `reasoningEffort` 失效。
 *
 * Node 24 type stripping. Run with `pnpm test`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { installSelectionCompat } from '../src/index.ts'

/** 一个够用的假上下文：本函数只把它原样转交给 install。 */
const fakeCtx = { name: 'fake-agent-ctx' } as unknown as Context

/** 双参数线（0.2.1-rc.x）的 selection 对象。 */
const selection = { provider: 'p', model: 'm', reasoningEffort: 'high' } as unknown as ModelSelection

describe('installSelectionCompat 按 arity 分流（issue #299）', () => {
  it('两参数线：把 `{ current, assembled }` 交给 install（路由靠它）', () => {
    const calls: unknown[][] = []
    // 声明成两个形参 → arity 为 2，模拟 0.2.1-rc.x。
    const legacy = (ctx: Context, sel?: { current: ModelSelection; assembled?: ModelSelection }): void => {
      calls.push([ctx, sel])
    }
    assert.equal(legacy.length, 2, '前提：这是两参数签名')

    installSelectionCompat(fakeCtx, legacy, selection)

    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], fakeCtx, 'ctx 必须原样转交')
    assert.deepEqual(calls[0][1], { current: selection, assembled: undefined })
  })

  it('一参数线：只传 ctx，不多给实参（0.2.2-rc.1+ 的签名）', () => {
    const calls: unknown[][] = []
    // 声明成一个形参 → arity 为 1，模拟 0.2.2-rc.1。
    const modern = function modern(ctx: Context): void {
      // 用 arguments.length 断言「真的只传了一个实参」。
      calls.push([ctx, arguments.length])
    }
    assert.equal(modern.length, 1, '前提：这是一参数签名')

    installSelectionCompat(fakeCtx, modern, selection)

    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], fakeCtx)
    assert.equal(calls[0][1], 1, '一参数线上不许再塞第二个实参（否则 reasoningEffort 会静默失效的老路）')
  })
})

describe('reasoningEffort 必须随 agentOptions 下发（#299）', () => {
  it('只在「一参数线」展开 reasoningEffort，老版本 AgentOptions 没有该字段', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    assert.match(
      source,
      /\.\.\.\(selectionArgRequired \? \{\} : \{ reasoningEffort: selection\.reasoningEffort \}\)/,
      '新签名线上必须把 reasoningEffort 放进 agentOptions',
    )
    assert.match(
      source,
      /const selectionArgRequired = installModelSelection\.length >= 2/,
      'arity 判定只能有一处',
    )
    assert.match(
      source,
      /installSelectionCompat\(agentCtx, installLegacy, selection\)/,
      'setup 必须走共用分流函数，不许各自内联',
    )
  })
})
