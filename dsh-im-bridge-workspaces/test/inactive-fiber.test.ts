/**
 * issue #294 回归测试：启动失败（fiber 在续段的 `await` 期间失活）时，`apply`
 * 的游离启动续段必须干净中止——原实现在 `ctx.on('session/event')` 抛
 * `CordisError('INACTIVE_EFFECT')`，在游离续段里变成 unhandled rejection →
 * dsh `fatal load failure`，一个插件没起来把整个进程带崩。
 *
 * Node 24 type stripping. Run with `pnpm test`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Context, CordisError, type Fiber } from '@deepseek-ai/cordis'
import { apply as applyBridge, Config, guardInactiveEffect, isFiberInactive } from '../src/index.ts'
import { DEFAULT_THINKING } from '../src/wecom.ts'

/**
 * 完整配置。中止点之前只读 `workspace`；去掉守卫的反证跑会继续往下读
 * `botId` / `secret` / `wecomCli` 直到 `ctx.on`，所以这几个字段必须在。
 * @param workspace - 用例自己的临时目录。
 * @returns 可直接交给 `apply` 的配置。
 */
function makeConfig(workspace: string): Config {
  return {
    botId: 'test-bot',
    secret: 'test-secret',
    workspace,
    workspaceSwitch: true,
    workspaceAllowFrom: [],
    workspaceAdd: false,
    allowFrom: [],
    startHint: '🧠 正在思考...',
    agentTimeoutSec: 600,
    agentPreset: 'standard',
    provider: '',
    model: '',
    reasoningEffort: '',
    persona: '',
    personaFile: '',
    maxReplyBytes: 20000,
    thinking: DEFAULT_THINKING,
    imageEnabled: true,
    deniedMessage: '无权访问本服务',
    welcomeMessage: '👋',
    wecomCli: { enabled: false, skillsDir: '', configDir: '', allowFrom: [] },
    approval: { enabled: true, timeoutSec: 300 },
  }
}

/** 异步收集 `console.warn`，跑完立刻还原，不污染其它用例。 */
async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    await run()
  } finally {
    console.warn = original
  }
  return warnings
}

/** 装一个只用于取 `ctx` 的探针插件，等它加载完再返回。 */
async function loadProbe(name: string): Promise<{ ctx: Context, fiber: Fiber }> {
  const root = new Context()
  let captured: Context | undefined
  const fiber = root.plugin({ name, apply(inner: Context) { captured = inner } })
  await fiber
  assert.ok(captured, `${name}: apply 未执行`)
  return { ctx: captured, fiber }
}

describe('apply 启动续段在 fiber 失活后（issue #294）', () => {
  it('中止启动：不注册 session/event，也不产生 unhandled rejection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'im-bridge-294-'))
    const previousHome = process.env.DSH_HOME
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    let fiber: Fiber | undefined
    let warnings: string[] = []
    try {
      // 绑定读写落在临时目录，不碰真实的 ~/.dsh。
      process.env.DSH_HOME = home
      const root = new Context()
      // 服务槽由 cordis 登记，值用索引访问写入（类型面由 requireService 只查非空）。
      const services = root as unknown as Record<string, unknown>
      root.provide('agents')
      services.agents = {}
      root.provide('sessions')
      services.sessions = {}
      root.provide('agentDefaultModel')
      services.agentDefaultModel = {}

      warnings = await captureWarnings(async () => {
        const wrapped = root.plugin({
          name: 'im-bridge-issue-294',
          apply(inner: Context, config: unknown) {
            applyBridge(inner, config as Config)
            // apply 的同步段跑完就让 fiber 失活：等价于启动失败 / 热重载把
            // 插件停掉，而游离续段（`await loader…` 那条链）才刚开始。
            queueMicrotask(() => {
              void fiber?.dispose().catch((error: unknown) => { rejections.push(error) })
            })
          },
        }, makeConfig(home))
        fiber = wrapped
        await new Promise((resolve) => { setTimeout(resolve, 100) })
      })

      assert.deepEqual(rejections, [], '启动续段不得产生 unhandled rejection（原 fatal 出口）')
      assert.ok(
        warnings.some((w) => w.includes('中止启动（工作区初始化后）')),
        `应在第一个 await 后中止启动，实际 warn: ${JSON.stringify(warnings)}`,
      )
      assert.ok(
        !warnings.some((w) => w.includes('跳过注册')),
        `中止后不应再走到任何注册点，实际 warn: ${JSON.stringify(warnings)}`,
      )
    } finally {
      process.off('unhandledRejection', onRejection)
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('isFiberInactive', () => {
  it('活着的 fiber 返回 false，dispose 后返回 true', async () => {
    const { ctx, fiber } = await loadProbe('fiber-state-probe')
    assert.equal(isFiberInactive(ctx), false)
    await fiber.dispose()
    assert.equal(isFiberInactive(ctx), true)
  })

  it('UNLOADING（state=5，uid 还在）也算失活', async () => {
    const { ctx } = await loadProbe('fiber-unloading-probe')
    const state = ctx.fiber as unknown as { state: number, uid: number | null }
    const original = state.state
    state.state = 5
    try {
      assert.notEqual(state.uid, null, '前提：uid 还在')
      assert.equal(isFiberInactive(ctx), true)
    } finally {
      state.state = original
    }
  })
})

describe('guardInactiveEffect', () => {
  it('fiber 已失活时跳过注册并 warn，不抛', async () => {
    const { ctx, fiber } = await loadProbe('guard-dead-probe')
    await fiber.dispose()
    assert.equal(isFiberInactive(ctx), true)

    let outcome: unknown = 'unset'
    const warnings = await captureWarnings(async () => {
      outcome = guardInactiveEffect(ctx, 'test: session/event', () =>
        ctx.on('session/event', () => {}))
    })
    assert.equal(outcome, undefined, '失活时应跳过而不是执行注册')
    assert.ok(
      warnings.some((w) => w.includes('跳过注册: test: session/event')),
      `应记 warn，实际: ${JSON.stringify(warnings)}`,
    )
  })

  it('活着的上下文照常注册并返回 disposer', async () => {
    const { ctx } = await loadProbe('guard-live-probe')
    const disposer = guardInactiveEffect(ctx, 'test: live', () => ctx.on('session/event', () => {}))
    assert.equal(typeof disposer, 'function')
  })

  it('run() 自己抛 INACTIVE_EFFECT（UNLOADING 窗口）时只吞这一种', async () => {
    const { ctx } = await loadProbe('guard-backstop-probe')
    const warnings = await captureWarnings(async () => {
      const outcome = guardInactiveEffect(ctx, 'test: backstop', () => {
        throw new CordisError('INACTIVE_EFFECT')
      })
      assert.equal(outcome, undefined)
    })
    assert.ok(warnings.some((w) => w.includes('跳过注册: test: backstop')))
  })

  it('注册动作的其它错误原样上抛，不许被遮住', async () => {
    const { ctx } = await loadProbe('guard-propagate-probe')
    assert.throws(
      () => guardInactiveEffect(ctx, 'test: boom', () => { throw new TypeError('boom') }),
      TypeError,
    )
  })
})
