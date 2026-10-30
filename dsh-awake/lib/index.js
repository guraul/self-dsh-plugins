/**
 * 宿主半边：保持唤醒的三条 control 路由。
 *
 * 分工很简单——**所有进程操作都在宿主**，浏览器只发三个请求：
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/plugins/awake/status` | 读当前状态（客户端每次挂载读一次，不轮询） |
 * | POST | `/plugins/awake/start` | 拉起 `caffeinate -i`（幂等） |
 * | POST | `/plugins/awake/stop` | 杀掉子进程（幂等） |
 *
 * 围栏顺序：loopback（socket + Host + sec-fetch-site）→ 变更类端点再要
 * `X-DSH-Plugin: awake` 且 `Origin` 为空或同源。细节见 `host/cross-site.js`。
 * @module dsh-plugin-awake
 */
import { assertPluginRequest } from './host/cross-site.js'
import { createRoute, readJsonBody, RequestError, writeJson } from './host/http.js'
import { isLoopbackRequest } from './host/loopback.js'
import { API, CODE } from './host/protocol.js'
import { AwakeError, createAwakeService } from './host/service.js'

/** 插件 id（cordis 里就是组合行的 id）。 */
export const name = 'dsh-awake'

/** 需要的宿主服务：只有 web 宿主有 `webServer`，没有它就没有 HTTP 面。 */
export const inject = ['webServer']

/**
 * 把服务层的失败翻译成 HTTP 失败。
 * @param {() => Promise<any>} action 动作。
 * @returns {Promise<any>} 结果。
 * @throws {RequestError} 服务层失败。
 */
async function run(action) {
  try {
    return await action()
  } catch (error) {
    if (error instanceof AwakeError) throw new RequestError(error.status, error.code, error.message)
    throw error
  }
}

/**
 * 挂载路由族。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {object} [config] 注入缝（`spawn` / `platform` / `now` / `wait` / `verifyDelayMs`），生产代码不传。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const service = createAwakeService(config)

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    /** @type {(() => void)[]} */
    const disposers = []

    /**
     * 注册一条精确路径（同路径的各方法在 handler 内分派）。
     * @param {string} path 绝对路径。
     * @param {Record<string, Function>} handlers 方法表。
     * @returns {void}
     */
    const route = (path, handlers) => {
      disposers.push(webServer.register({ kind: 'exact', path, handler: createRoute(handlers, isLoopbackRequest) }))
    }

    /**
     * 回一个成功信封；`status` 字段永远来自宿主的真实状态，不做乐观更新。
     * @param {import('node:http').ServerResponse} res 响应。
     * @param {{active: boolean, pid: number|null, startedAt: number|null}} snapshot 状态快照。
     * @returns {void}
     */
    const respond = (res, snapshot) => {
      writeJson(res, 200, { ok: true, ...snapshot })
    }

    /**
     * 变更类端点共用的围栏：跨站防护 + 「本端点不吃 body」。
     * @param {import('node:http').IncomingMessage} req 请求。
     * @returns {Promise<void>} 通过。
     */
    const guard = async (req) => {
      assertPluginRequest(req)
      const body = await readJsonBody(req)
      if (body !== undefined) throw new RequestError(400, CODE.BAD_REQUEST, 'this endpoint takes no request body')
    }

    route(API.status, {
      async GET(_req, res) {
        respond(res, service.status())
      },
    })

    route(API.start, {
      async POST(req, res) {
        await guard(req)
        respond(res, await run(() => service.start()))
      },
    })

    route(API.stop, {
      async POST(req, res) {
        await guard(req)
        respond(res, await run(() => service.stop()))
      },
    })

    // 卸载 / disable / 重启：先摘路由，再杀掉子进程。顺序反了会有
    // 「路由还在但服务已死」的窄窗口，虽然只有几十毫秒，没必要留。
    //
    // 另挂一个进程级兜底：`ctx.effect` 的清理在 cordis 正常 dispose 时可靠，
    // 但宿主被直接 `process.exit()` / SIGTERM 收走时不一定跑到；`exit` 钩子里
    // 同步 kill 一次，避免留下没人认领的 `caffeinate`（SIGKILL 场景仍无解）。
    ctx.effect(() => {
      const onExit = () => {
        void service.dispose()
      }
      process.once('exit', onExit)
      return () => {
        process.removeListener('exit', onExit)
        for (const dispose of disposers) dispose()
        void service.dispose()
      }
    })
  })
}
