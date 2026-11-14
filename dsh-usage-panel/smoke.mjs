/**
 * dsh-usage-panel 的冒烟断言（契约见 `docs/plugins/dsh-auto-upgrade.md` 的 `dsh.smoke`）。
 *
 * 两条行为断言：
 *   1. `usagePanel-fold`：插件自己的投影单元（`src/host/projection-unit.ts`）在 fixture
 *      事件上折出正确的 `usagePanel` 值 —— 纯函数层，任何机器都能跑；
 *   2. `coldSnapshot`：用**宿主实际安装的那份** `@deepseek-ai/dsh-session-projection[-cache]`
 *      启动 registry + cache，注册本插件的投影定义，再走真实 `coldSnapshot(header, 0, events)`
 *      冷读路径，断言返回值里的 `usagePanel`。
 *
 * 为什么能抓漂移：宿主升级后若 `coldSnapshot` 签名 / `ProjectionDefinition` 形状 /
 * wire 契约变了，第 2 条会直接红——这正是「插件装上了但统计永远是 0」那类静默故障。
 * 只 import 宿主目录（`ctx.dshDir`）里的包，避免插件自己 devDependencies 里的旧副本
 * 把版本差异洗成假绿。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 夹具事件：两个模型 / 两个 provider，两个 step。 */
const EVENTS = [
  { type: 'request/context', seq: 0, time: 1_700_000_000_000, data: { model: 'deepseek-chat', provider: 'deepseek' } },
  { type: 'assistant/message', seq: 1, time: 1_700_000_000_001, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2 } } },
  { type: 'step/end', seq: 2, time: 1_700_000_000_002, data: { turn: 1, step: 1 } },
  { type: 'request/header', seq: 3, time: 1_700_000_000_003, data: { header: { config: { model: 'gpt-5', provider: 'openai' } } } },
  { type: 'assistant/message', seq: 4, time: 1_700_000_000_004, data: { turn: 2, step: 1, usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0 } } },
  { type: 'step/end', seq: 5, time: 1_700_000_000_005, data: { turn: 2, step: 1 } },
]

/** 期望的 `usagePanel` 关键值（四个不相交桶 + 按模型归属）。 */
const EXPECTED = {
  totals: { input: 107, output: 13, cacheRead: 6, cacheWrite: 2 },
  byModel: {
    'deepseek-chat': { input: 100, output: 10, cacheRead: 5, cacheWrite: 2 },
    'gpt-5': { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 },
  },
  byProvider: {
    deepseek: { input: 100, output: 10, cacheRead: 5, cacheWrite: 2 },
    openai: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 },
  },
  asOfSeq: 5,
}

/** 冷读用的会话头（只放 cache 身份与 projection init 需要的字段）。 */
const HEADER = { id: 'smoke-session', version: 1, createdAt: 1_700_000_000_000, isSeeded: false }

/**
 * 比较实际值是否覆盖期望值（只比关键字段，给 detail 留出可读差异）。
 *
 * `usagePanel` 是 `{ epochs, current, … }` 形状；fixture 没有 seed 边界，
 * 全部用量都落在仍打开的 `current` epoch 里。
 * @param {{current?: object}} actual 实际的 `usagePanel` 状态。
 * @returns {string[]} 不一致项；空数组表示通过。
 */
function diffUsage(actual) {
  const view = actual?.current ?? actual
  const problems = []
  for (const [key, expected] of Object.entries(EXPECTED.totals)) {
    if (view?.totals?.[key] !== expected) problems.push(`totals.${key}=${String(view?.totals?.[key])}≠${String(expected)}`)
  }
  for (const [model, expected] of Object.entries(EXPECTED.byModel)) {
    for (const [key, value] of Object.entries(expected)) {
      if (view?.byModel?.[model]?.[key] !== value) {
        problems.push(`byModel.${model}.${key}=${String(view?.byModel?.[model]?.[key])}≠${String(value)}`)
      }
    }
  }
  for (const [provider, expected] of Object.entries(EXPECTED.byProvider)) {
    for (const [key, value] of Object.entries(expected)) {
      if (view?.byProvider?.[provider]?.[key] !== value) {
        problems.push(`byProvider.${provider}.${key}=${String(view?.byProvider?.[provider]?.[key])}≠${String(value)}`)
      }
    }
  }
  return problems
}

/**
 * 从宿主安装目录解析一个包（不用插件自己的 `node_modules` 旧副本）。
 * @param {string} dshDir 宿主 dsh 包目录（`ctx.dshDir`）。
 * @param {string} specifier 包名。
 * @returns {Promise<any>} 该包。
 */
async function importFromHost(dshDir, specifier) {
  const requireFromHost = createRequire(join(dshDir, 'package.json'))
  return import(pathToFileURL(requireFromHost.resolve(specifier)).href)
}

/**
 * 跑一遍断言。
 * @param {{name?: string, dshDir?: string, dshVersion?: string}} [ctx] 宿主事实（由冒烟 runner 传入）。
 * @returns {Promise<{ok: boolean, checks: {name: string, ok: boolean, detail?: string}[]}>} 结果。
 */
export async function run(ctx = {}) {
  /** @type {{name: string, ok: boolean, detail?: string}[]} */
  const checks = []
  /**
   * 跑一条断言：抛错也算失败。
   * @param {string} name 断言名。
   * @param {() => Promise<{ok: boolean, detail?: string}>} fn 断言体。
   * @returns {Promise<void>} 无。
   */
  const check = async (name, fn) => {
    try {
      const { ok, detail } = await fn()
      checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const { usagePanelProjectionDefinition } = await import('./src/host/projection-unit.ts')

  await check('usagePanel-fold', async () => {
    const definition = usagePanelProjectionDefinition
    let state = definition.init(HEADER, 0)
    for (const event of EVENTS) state = definition.apply(state, event)
    const value = definition.wire.viewSchema.parse(definition.wire.view(state))
    const problems = diffUsage(value)
    return {
      ok: problems.length === 0,
      detail: problems.length === 0 ? `totals=${JSON.stringify(value.current.totals)}` : problems.join('; '),
    }
  })

  await check('coldSnapshot', async () => {
    const dshDir = typeof ctx.dshDir === 'string' && ctx.dshDir !== '' ? ctx.dshDir : undefined
    if (dshDir === undefined) {
      throw new Error('ctx.dshDir 不可用：拿不到宿主安装目录，无法验证真实 coldSnapshot 冷读路径')
    }
    const { Context, Service } = await importFromHost(dshDir, '@deepseek-ai/cordis')
    const { SessionProjectionRegistry } = await importFromHost(dshDir, '@deepseek-ai/dsh-session-projection')
    const { SessionProjectionCache } = await importFromHost(dshDir, '@deepseek-ai/dsh-session-projection-cache')

    // 只提供 coldSnapshot 需要的最小宿主面：存储域的 table、sessions.get/flush。
    const rows = new Map()
    const table = { get: (id) => rows.get(id), put: async (id, record) => { rows.set(id, record) } }
    class SmokeDomains extends Service {
      constructor(host) {
        super(host, 'storageDomain')
      }
      async open() {
        return { table: () => table, close() {} }
      }
    }
    class SmokeSessions extends Service {
      constructor(host) {
        super(host, 'sessions')
      }
      get() {
        return undefined
      }
      async flush() {}
    }

    const host = new Context()
    await host.plugin(SmokeDomains)
    await host.plugin(SmokeSessions)
    await host.plugin(SessionProjectionRegistry)
    await host.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    try {
      await host.sessionProjections.register(usagePanelProjectionDefinition)
      const snapshot = host.sessionProjectionCache.coldSnapshot(HEADER, 0, EVENTS)
      const value = snapshot.values.usagePanel
      if (value === undefined) throw new Error('coldSnapshot 没有产出 usagePanel 值（投影定义没被宿主认领）')
      const problems = diffUsage(value)
      if (snapshot.asOfSeq !== EXPECTED.asOfSeq) problems.push(`asOfSeq=${String(snapshot.asOfSeq)}≠${String(EXPECTED.asOfSeq)}`)
      return {
        ok: problems.length === 0,
        detail: problems.length === 0
          ? `dsh ${String(ctx.dshVersion ?? 'unknown')}：asOfSeq=${String(snapshot.asOfSeq)} totals=${JSON.stringify(value.current.totals)}`
          : problems.join('; '),
      }
    } finally {
      await host.fiber.dispose()
    }
  })

  return { ok: checks.every((item) => item.ok), checks }
}
