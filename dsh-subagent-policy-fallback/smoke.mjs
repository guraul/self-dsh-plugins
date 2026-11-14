/**
 * dsh-subagent-policy-fallback 的冒烟断言（契约见 `docs/plugins/dsh-auto-upgrade.md` 的 `dsh.smoke`）。
 *
 * 只验升级后 5 秒内能确定的行为，不启动完整宿主：
 *   1. `payload`：策略事件的构造 —— 在 fixture 会话上产出与设置服务一致的事件体；
 *   2. `dedup`：幂等 —— 日志已有策略事件 / 子会话 / 重复触发都不得写第二条；
 *   3. `host-load`：用**宿主实际安装的那份** cordis（`ctx.dshDir`）加载本插件，
 *      证明升级后模块仍能被当前 dsh 装配，且 `agent/created` 监听真的挂上了。
 *
 * 为什么能抓漂移：`backfillSession()` 的判据（`origin` / `snapshotEvents()` / 设置服务
 * `current()` 的形状）与 DSH 上游一致；上游改了会话事件结构或 `current()` 返回形态，
 * 第 1、2 条会直接红。第 3 条则抓「插件导出面 / 装配方式」被宿主破坏。
 */

/** 夹具：两条合法路由，与设置服务 `current()` 的返回形状一致。 */
const ROUTES = [
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'openai', model: 'gpt-5' },
]

/** 策略事件类型名（与 DSH 上游一致；这里写死是为了让上游改名时冒烟变红）。 */
const UPSTREAM_POLICY_EVENT = 'subagent/model-selection-policy'

/**
 * 假会话：只实现 `policy.js` 读取的两条路径（`snapshotEvents` / `append`）。
 * @param {object} [options] 选项。
 * @param {string} [options.id] 会话 id。
 * @param {string} [options.origin] `header.origin`。
 * @param {Array<{type: string}>} [options.events] 初始日志。
 * @returns {any} 假会话。
 */
function createSession({ id = 'smoke-session', origin, events = [] } = {}) {
  const log = [...events]
  return {
    id,
    header: origin === undefined ? {} : { origin },
    appended: [],
    snapshotEvents() {
      return log
    },
    append(type, data) {
      this.appended.push({ type, data })
      log.push({ type, data })
    },
  }
}

/**
 * 假 ctx：只实现本插件用到的 `get` / `sessions.list` / `logger`。
 * @param {object} [options] 选项。
 * @param {any} [options.service] 设置服务；`undefined` 表示缺失。
 * @param {any[]} [options.sessions] 存活会话。
 * @returns {any} 假 ctx。
 */
function createCtx({ service, sessions = [] } = {}) {
  return {
    sessions: { list: () => sessions },
    get: (wanted) => (wanted === 'subagentModelSelection' ? service : undefined),
    logger: { info: () => {}, warn: () => {} },
  }
}

/** 正常工作的设置服务。 */
const service = { current: () => ({ enabled: true, allowedModels: ROUTES }) }

/**
 * 从宿主安装目录解析一个包（不用插件自己的 `node_modules` 旧副本）。
 * @param {string} dshDir 宿主 dsh 包目录（`ctx.dshDir`）。
 * @param {string} specifier 包名。
 * @returns {Promise<any>} 该包。
 */
async function importFromHost(dshDir, specifier) {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const { join } = await import('node:path')
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

  const { POLICY_EVENT: eventName, backfillSession, policyEventExists } = await import('./lib/policy.js')

  await check('payload', async () => {
    const session = createSession()
    const patched = backfillSession(createCtx({ service }), session)
    const appended = session.appended[0]
    const payloadOk = appended !== undefined
      && appended.type === eventName
      && appended.type === UPSTREAM_POLICY_EVENT
      && JSON.stringify(appended.data) === JSON.stringify({ allowedModels: ROUTES })
    return {
      ok: patched === true && session.appended.length === 1 && payloadOk && policyEventExists(session),
      detail: `patched=${String(patched)} append=${JSON.stringify(session.appended)}`,
    }
  })

  await check('dedup', async () => {
    const existing = createSession({ id: 'existing', events: [{ type: eventName }] })
    const child = createSession({ id: 'child', origin: 'subagent' })
    const twice = createSession({ id: 'twice' })
    const host = createCtx({ service })
    const first = backfillSession(host, twice)
    const second = backfillSession(host, twice)
    const skippedExisting = backfillSession(host, existing)
    const skippedChild = backfillSession(host, child)
    return {
      ok: first === true
        && second === false
        && twice.appended.length === 1
        && skippedExisting === false
        && skippedChild === false
        && existing.appended.length === 0
        && child.appended.length === 0,
      detail: `twice=${String(first)}/${String(second)}(appends=${String(twice.appended.length)}) `
        + `existing=${String(skippedExisting)} child=${String(skippedChild)}`,
    }
  })

  await check('host-load', async () => {
    const dshDir = typeof ctx.dshDir === 'string' && ctx.dshDir !== '' ? ctx.dshDir : undefined
    if (dshDir === undefined) {
      throw new Error('ctx.dshDir 不可用：拿不到宿主安装目录，无法证明模块能被当前 dsh 加载')
    }
    const { Context } = await importFromHost(dshDir, '@deepseek-ai/cordis')
    const plugin = await import('./lib/index.js')
    const host = new Context()
    // 插件 inject 的 sessions 服务 + 软探测的 subagentModelSelection。
    host.provide('sessions')
    host.set('sessions', { list: () => [] })
    host.provide('subagentModelSelection')
    host.set('subagentModelSelection', service)
    const fiber = host.plugin(plugin)
    try {
      await fiber
      const session = createSession()
      host.emit('agent/created', { agent: { session } })
      const appended = session.appended[0]
      const loaded = appended !== undefined
        && appended.type === UPSTREAM_POLICY_EVENT
        && JSON.stringify(appended.data) === JSON.stringify({ allowedModels: ROUTES })
      return {
        ok: loaded,
        detail: `dsh ${String(ctx.dshVersion ?? 'unknown')} 加载成功；agent/created → ${JSON.stringify(session.appended)}`,
      }
    } finally {
      await host.fiber.dispose()
    }
  })

  return { ok: checks.every((item) => item.ok), checks }
}
