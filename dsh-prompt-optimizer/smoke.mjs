/**
 * dsh-prompt-optimizer 的冒烟断言（`dsh.smoke` 契约见 `docs/plugins/dsh-auto-upgrade.md`）。
 *
 * 只验升级后 5 秒内能确定的事，不调模型、不发请求：
 *   1. `exports`：宿主半边仍导出 `apply` / `inject` / `name`，`inject` 仍只等 `llm`；
 *   2. `route-shape`：`apply()` 注册的两条 exact 路由与 `docs/plugins/dsh-prompt-optimizer.md` 一致；
 *   3. `client-inject`：浏览器半边的 `exports.inject` 仍以 `slots` 为首（源码 + 构建产物一致）；
 *   4. `host-load`：用**宿主实际安装的那份** cordis（`ctx.dshDir`）真加载本插件，
 *      证明升级后 `apply()` 仍能被当前 dsh 装配、两条路由仍能挂上。
 *
 * ⚠️ 客户端 `exports.inject` 当前是 `['slots', 'connection', 'remote']`（不是单元素 `['slots']`）：
 * 后两个服务用于会话/远端模型目录，缺席时插件会降级。**契约是 `slots` 必须在第一位**，
 * 不是「只能有 slots」——所以这里断言首元素而不是整个数组，避免把合法扩展误判成漂移。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** 与文档一致：优化（SSE）与探活两条 exact 路由。 */
const ROUTES = ['/dsh-prompt-optimizer/optimize', '/dsh-prompt-optimizer/test-model']

/** 只给枚举型配置的合法值：宿主跑冒烟时会从真正的 schema 默认值取，这里避免「undefined 不是有效值」噪声。 */
const CONFIG = { language: 'zh', mode: 'fast', reasoningEffort: 'lowest' }

/**
 * 从一段源码里取出 `inject = [...]` 的字符串数组。
 * @param {string} source 源码（src 用单引号，构建产物用双引号）。
 * @param {RegExp} pattern 匹配到数组字面量的正则。
 * @returns {string[] | undefined} 数组；找不到返回 undefined。
 */
function injectList(source, pattern) {
  const literal = pattern.exec(source)?.[1]
  if (literal === undefined) return undefined
  return [...literal.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => match[1] ?? match[2])
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
 * @returns {{ctx: object, routes: object[], dispose: () => void}} 假上下文、路由与清理函数。
 */
function fakeApplyContext() {
  /** @type {object[]} */
  const routes = []
  /** @type {(() => void)[]} */
  const disposers = []
  /** @type {any} */
  const ctx = {
    inject: (_deps, callback) => callback(ctx),
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  return {
    ctx,
    routes,
    // apply 末尾的「10s 后仍未挂载」定时器必须清掉，否则冒烟会让宿主进程多活 10 秒。
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
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

  const plugin = await import('./lib/index.js')

  await check('exports', async () => {
    const inject = Array.isArray(plugin.inject) ? plugin.inject : []
    return {
      ok: typeof plugin.apply === 'function'
        && plugin.apply.length >= 1
        && plugin.name === 'dsh-prompt-optimizer'
        && JSON.stringify(inject) === JSON.stringify(['llm']),
      detail: `apply=${typeof plugin.apply}/${String(plugin.apply?.length)} inject=${inject.join(',')} name=${String(plugin.name)}`,
    }
  })

  await check('route-shape', async () => {
    const { ctx: fake, routes, dispose } = fakeApplyContext()
    plugin.apply(fake, CONFIG)
    const paths = routes.map((route) => route.path)
    dispose()
    return {
      ok: JSON.stringify(paths) === JSON.stringify(ROUTES) && routes.every((route) => route.kind === 'exact'),
      detail: `paths=${paths.join(',')} kinds=${routes.map((route) => route.kind).join(',')}`,
    }
  })

  await check('client-inject', async () => {
    const source = await readFile(join(PACKAGE_DIR, 'src/client/index.tsx'), 'utf8')
    const built = await readFile(join(PACKAGE_DIR, 'lib/client.js'), 'utf8')
    const fromSource = injectList(source, /export const inject = (\[[^\]]*\])/)
    const fromBuild = injectList(built, /var inject = (\[[^\]]*\])/)
    const same = JSON.stringify(fromSource) === JSON.stringify(fromBuild)
    const slotsFirst = fromBuild?.[0] === 'slots'
    const unique = fromBuild !== undefined && new Set(fromBuild).size === fromBuild.length
    return {
      ok: same && slotsFirst && unique,
      detail: `built=${(fromBuild ?? []).join(',')} source=${(fromSource ?? []).join(',')}`,
    }
  })

  await check('host-load', async () => {
    const dshDir = typeof ctx.dshDir === 'string' && ctx.dshDir !== '' ? ctx.dshDir : undefined
    if (dshDir === undefined) {
      throw new Error('ctx.dshDir 不可用：拿不到宿主安装目录，无法证明模块能被当前 dsh 加载')
    }
    const { Context } = await importFromHost(dshDir, '@deepseek-ai/cordis')
    /** @type {object[]} */
    const routes = []
    const host = new Context()
    host.provide('llm')
    host.set('llm', {
      listProviders: () => [],
      listModels: async () => [],
      stream: async function* stream() {},
    })
    host.provide('webServer')
    host.set('webServer', {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    })
    const fiber = host.plugin(plugin, CONFIG)
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
