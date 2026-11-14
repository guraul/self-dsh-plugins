/**
 * dsh-external-discuss 的冒烟断言（`dsh.smoke` 契约见 `docs/plugins/dsh-auto-upgrade.md`）。
 *
 * 只验升级后 5 秒内能确定的事，不启动完整宿主、不联网：
 *   1. `payload`：会话 → 投递文本的纯函数在 fixture 上产出正确结果（角色过滤 / 截断 / 标题回退）；
 *   2. `route-shape`：`apply()` 注册的两条 exact 路由路径与文档一致；
 *   3. `url-default`：外部模型的默认地址仍是清言 `https://chatglm.cn/`；
 *   4. `host-load`：用**宿主实际安装的那份** cordis（`ctx.dshDir`）真加载本插件并驱动一次
 *      `/payload`，证明升级后模块仍能被当前 dsh 装配、路由仍能返回同一份 payload。
 *
 * 为什么能抓漂移：DSH 改了 `session.deriveMessages()` 的消息形状、路由注册 API，或有人
 * 改了投递目标 / 默认 URL，第 1、2、4 条会直接红；第 3 条守住「默认送到清言」这条产品约定。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** 默认投递目标：清言网页版（改这里等于改产品默认行为，必须是有意的）。 */
const QINGYAN_URL = 'https://chatglm.cn/'
/** manifest.json 的 host_permissions / content_scripts 必须覆盖同一个域。 */
const QINGYAN_MATCH = 'https://chatglm.cn/*'
/** 与 `lib/index.js` 的 API 表一致（文档见 `docs/plugins/dsh-external-discuss.md`）。 */
const ROUTES = ['/api/dsh-external-discuss/health', '/api/dsh-external-discuss/payload']

/**
 * 夹具会话：`deriveMessages()` 返回模型实际看到的消息序列（含应被剔除的角色与块）。
 * @returns {{deriveMessages: () => object[]}} 假会话。
 */
function fixtureSession() {
  return {
    deriveMessages: () => [
      { role: 'system', content: [{ type: 'text', text: '系统提示，不该出现' }] },
      { role: 'user', content: [{ type: 'text', text: '帮我设计插件架构\n第二行' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '内心戏，不该出现' },
          { type: 'text', text: '建议分三层。' },
        ],
      },
      { role: 'tool', content: [{ type: 'text', text: '工具结果，不该出现' }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ],
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
    get: () => undefined,
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

  const { collectConversation, fallbackTitle } = await import('./lib/host/transcript.js')

  await check('payload', async () => {
    const conversation = collectConversation(fixtureSession())
    const roles = conversation.messages.map((message) => message.role)
    const rolesOk = JSON.stringify(roles) === JSON.stringify(['user', 'assistant', 'user'])
    const filtered = !conversation.text.includes('系统提示')
      && !conversation.text.includes('内心戏')
      && !conversation.text.includes('工具结果')
    const titled = fallbackTitle(conversation.messages) === '帮我设计插件架构'
    const truncated = collectConversation(fixtureSession(), { maxChars: 40 })
    const truncationOk = truncated.truncated === true
      && truncated.text.endsWith('…（内容过长，已截断）')
    return {
      ok: rolesOk && filtered && titled && truncationOk && conversation.truncated === false,
      detail: `roles=${roles.join(',')} title=${fallbackTitle(conversation.messages)} `
        + `filtered=${String(filtered)} truncated=${String(truncationOk)}`,
    }
  })

  await check('route-shape', async () => {
    const { apply } = await import('./lib/index.js')
    const { ctx: fake, routes } = fakeApplyContext()
    apply(fake)
    const paths = routes.map((route) => route.path)
    return {
      ok: JSON.stringify(paths) === JSON.stringify(ROUTES) && routes.every((route) => route.kind === 'exact'),
      detail: `paths=${paths.join(',')} kinds=${routes.map((route) => route.kind).join(',')}`,
    }
  })

  await check('url-default', async () => {
    const background = await readFile(join(PACKAGE_DIR, 'extension/background.js'), 'utf8')
    const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, 'extension/manifest.json'), 'utf8'))
    const declaredUrl = /const QINGYAN_URL = '([^']+)'/.exec(background)?.[1]
    const hosts = manifest.host_permissions ?? []
    const matches = (manifest.content_scripts ?? []).flatMap((entry) => entry.matches ?? [])
    return {
      ok: declaredUrl === QINGYAN_URL
        && hosts.includes(QINGYAN_MATCH)
        && matches.includes(QINGYAN_MATCH),
      detail: `url=${String(declaredUrl)} hosts=${hosts.join(',')}`,
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
    host.provide('sessions')
    host.set('sessions', { get: (id) => (id === 'smoke-session' ? fixtureSession() : undefined) })
    host.provide('sessionTitle')
    host.set('sessionTitle', { get: () => ({ title: '  宿主冒烟会话  ' }) })
    const fiber = host.plugin(plugin)
    try {
      await fiber
      const paths = routes.map((route) => route.path)
      if (JSON.stringify(paths) !== JSON.stringify(ROUTES)) {
        return { ok: false, detail: `宿主加载后路由集合变了：${paths.join(',')}` }
      }
      const payloadRoute = routes.find((route) => route.path === ROUTES[1])
      let body = ''
      const req = {
        url: `${ROUTES[1]}?sessionId=smoke-session`,
        method: 'GET',
        socket: { remoteAddress: '127.0.0.1' },
      }
      const res = {
        statusCode: 0,
        setHeader: () => {},
        end: (text) => {
          body = String(text)
        },
      }
      await payloadRoute.handler(req, res)
      const payload = JSON.parse(body)
      const shapeOk = res.statusCode === 200
        && payload.ok === true
        && payload.title === '宿主冒烟会话'
        && payload.text.includes('建议分三层。')
        && payload.stats?.messages === 3
        && typeof payload.stats?.chars === 'number'
        && payload.stats?.truncated === false
      return {
        ok: shapeOk,
        detail: `dsh ${String(ctx.dshVersion ?? 'unknown')} 加载成功；status=${String(res.statusCode)} `
          + `title=${String(payload.title)} messages=${String(payload.stats?.messages)}`,
      }
    } finally {
      await host.fiber.dispose()
    }
  })

  return { ok: checks.every((item) => item.ok), checks }
}
