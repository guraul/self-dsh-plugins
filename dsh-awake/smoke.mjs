/**
 * dsh-awake 的冒烟断言（`dsh.smoke` 契约见 `docs/plugins/dsh-auto-upgrade.md`）。
 *
 * 只验升级后 5 秒内能确定的事，**绝不 spawn 真实 `caffeinate`**：
 *   1. `start-idempotent`：`start()` 两次只拉起一个子进程，重复调用回读同一份状态；
 *   2. `stop-idempotent`：`stop()` 两次只 kill 一次，快照回 inactive；
 *   3. `route-shape`：三条路由与协议常量一致，`caffeinate` 参数永不带 `-t`；
 *   4. `host-load`：用**宿主实际安装的那份** cordis（`ctx.dshDir`）真加载本插件，
 *      证明升级后模块仍能被当前 dsh 装配、三条路由仍能挂上。
 *
 * 为什么能抓漂移：DSH 改了 `webServer.register` 的形状、或有人给 `ARGS` 加了 `-t` /
 * 改了路由前缀，第 3、4 条会直接红；第 1、2 条守住「纯开关」这条核心语义（重复点不叠进程）。
 */
import { join } from 'node:path'

/** 与 `lib/host/protocol.js` 一致：三条路由、exact 注册。 */
const ROUTES = ['/plugins/awake/status', '/plugins/awake/start', '/plugins/awake/stop']

/**
 * 假子进程：只实现状态机用到的 `once` / `kill` / `pid`。
 * @param {number} pid 进程号。
 * @returns {any} 假子进程。
 */
function fakeChild(pid) {
  return {
    pid,
    killCount: 0,
    once() {
      return this
    },
    kill() {
      this.killCount += 1
      return true
    },
  }
}

/**
 * 从宿主安装目录解析一个包（不用插件自己的 `node_modules` 旧副本）。
 * @param {string} dshDir 宿主 dsh 包目录（`ctx.dshDir`）。
 * @param {string} specifier 包名。
 * @returns {Promise<any>} 该包。
 */
async function importFromHost(dshDir, specifier) {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const requireFromHost = createRequire(join(dshDir, 'package.json'))
  return import(pathToFileURL(requireFromHost.resolve(specifier)).href)
}

/**
 * 假 ctx：只实现 `apply()` 用到的 `inject` / `effect` / `webServer.register`。
 * @returns {{ctx: object, routes: object[]}} 假上下文与收集到的路由。
 */
function fakeApplyContext() {
  /** @type {object[]} */
  const routes = []
  /** @type {any} */
  const ctx = {
    inject: (_deps, callback) => callback(ctx),
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    effect: (callback) => {
      callback()
      return () => {}
    },
  }
  return { ctx, routes }
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
   * 跑一条断言：抛错也算失败（不把「断言本身崩了」当成通过）。
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

  const protocol = await import('./lib/host/protocol.js')
  const { createAwakeService } = await import('./lib/host/service.js')

  await check('start-idempotent', async () => {
    const child = fakeChild(4321)
    let spawned = 0
    const service = createAwakeService({
      spawn: () => {
        spawned += 1
        return child
      },
      wait: async () => {},
      now: () => 1_700_000_000_000,
      platform: 'darwin',
    })
    const first = await service.start()
    const second = await service.start()
    return {
      ok: spawned === 1
        && first.active === true
        && first.pid === 4321
        && second.active === true
        && second.pid === first.pid
        && second.startedAt === first.startedAt,
      detail: `spawned=${String(spawned)} pid=${String(first.pid)}/${String(second.pid)}`,
    }
  })

  await check('stop-idempotent', async () => {
    const child = fakeChild(4322)
    const service = createAwakeService({
      spawn: () => child,
      wait: async () => {},
      now: () => 1_700_000_000_000,
      platform: 'darwin',
    })
    await service.start()
    const first = await service.stop()
    const second = await service.stop()
    return {
      ok: child.killCount === 1
        && first.active === false
        && first.pid === null
        && second.active === false
        && second.pid === null,
      detail: `killCount=${String(child.killCount)} active=${String(first.active)}/${String(second.active)}`,
    }
  })

  await check('route-shape', async () => {
    const { apply } = await import('./lib/index.js')
    const { ctx: fake, routes } = fakeApplyContext()
    apply(fake)
    const paths = routes.map((route) => route.path)
    const apiPaths = Object.values(protocol.API)
    return {
      ok: JSON.stringify(paths) === JSON.stringify(ROUTES)
        && JSON.stringify(apiPaths) === JSON.stringify(ROUTES)
        && routes.every((route) => route.kind === 'exact')
        && protocol.BINARY === 'caffeinate'
        && protocol.ARGS.includes('-t') === false,
      detail: `paths=${paths.join(',')} args=${protocol.ARGS.join(' ')}`,
    }
  })

  await check('host-load', async () => {
    const dshDir = typeof ctx.dshDir === 'string' && ctx.dshDir !== '' ? ctx.dshDir : undefined
    if (dshDir === undefined) {
      throw new Error('ctx.dshDir 不可用：拿不到宿主安装目录，无法证明模块能被当前 dsh 加载')
    }
    const { Context } = await importFromHost(dshDir, '@deepseek-ai/cordis')
    const plugin = await import('./lib/index.js')
    /** @type {object[]} */
    const routes = []
    const host = new Context()
    host.provide('webServer')
    host.set('webServer', {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    })
    const fiber = host.plugin(plugin)
    try {
      await fiber
      const paths = routes.map((route) => route.path)
      return {
        ok: JSON.stringify(paths) === JSON.stringify(ROUTES) && routes.every((route) => route.kind === 'exact'),
        detail: `dsh ${String(ctx.dshVersion ?? 'unknown')} 加载成功；paths=${paths.join(',')}`,
      }
    } finally {
      await host.fiber.dispose()
    }
  })

  return { ok: checks.every((item) => item.ok), checks }
}
