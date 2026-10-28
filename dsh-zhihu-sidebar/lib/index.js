/**
 * 宿主半边：知乎侧栏的数据层路由。
 *
 * 本阶段只有只读接口（热榜 / 搜索 / 我的创作 / 能力清单 / 状态），浏览器半边
 * （右侧栏）留到第二阶段。所有端点 loopback-only：数据来自当前账号的 Access Secret。
 * @module dsh-plugin-zhihu-sidebar
 */
import { createCli } from './host/cli.js'
import { API, createRoute, isLoopbackRequest, queryInt, queryText, writeJson } from './host/http.js'
import { REASON } from './host/parse.js'
import { createService, LIMITS } from './host/service.js'

/** cordis 插件 id（不是包名）。 */
export const name = 'dsh-zhihu-sidebar'

/** 需要的宿主服务。 */
export const inject = ['webServer']

/** 失败原因 → HTTP 状态码。 */
const STATUS_BY_REASON = {
  [REASON.AUTH_REQUIRED]: 401,
  [REASON.RATE_LIMITED]: 429,
  [REASON.QUOTA_EXHAUSTED]: 429,
  [REASON.INVALID_ARGUMENT]: 400,
  [REASON.NETWORK_ERROR]: 502,
  [REASON.TIMEOUT]: 504,
  [REASON.SERVER_ERROR]: 502,
  [REASON.CLI_MISSING]: 503,
  [REASON.KEYCHAIN_UNAVAILABLE]: 503,
}

/**
 * 按原因挑状态码。
 * @param {string|undefined} reason 原因。
 * @returns {number} HTTP 状态码。
 */
function statusFor(reason) {
  return (reason === undefined ? undefined : STATUS_BY_REASON[reason]) ?? 502
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文。
 * @param {object} [config] 插件配置。
 * @param {string} [config.cliPath] `zhihu-cli` 路径（默认 `.probe/bin/zhihu-cli`）。
 * @param {number} [config.timeoutMs] 单次调用超时。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const service = createService({
    cli: createCli({ binPath: config.cliPath, timeoutMs: config.timeoutMs }),
  })

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    /** @type {(() => void)[]} */
    const disposers = []

    /**
     * 注册一条路径。
     * @param {string} path 绝对路径。
     * @param {Record<string, Function>} handlers 方法表。
     * @returns {void}
     */
    const route = (path, handlers) => {
      disposers.push(
        webServer.register({ kind: 'exact', path, handler: createRoute(handlers, isLoopbackRequest) }),
      )
    }

    /**
     * 数据回包 → HTTP。成功 200；失败按原因给 4xx/5xx，body 仍是统一信封。
     * @param {import('node:http').ServerResponse} res 响应。
     * @param {object} result 回包。
     * @returns {void}
     */
    const send = (res, result) => {
      writeJson(res, result.ok ? 200 : statusFor(result.reason), result)
    }

    /**
     * 取请求 URL。
     * @param {import('node:http').IncomingMessage} req 请求。
     * @returns {URL} URL。
     */
    const urlOf = (req) => new URL(req.url ?? '/', 'http://127.0.0.1')

    route(API.hot, {
      async GET(req, res) {
        send(res, await service.hot(queryInt(urlOf(req), 'limit', LIMITS.hot)))
      },
    })

    route(API.search, {
      async GET(req, res) {
        const url = urlOf(req)
        const query = queryText(url, 'q')
        send(res, await service.search(query, queryInt(url, 'count', LIMITS.search)))
      },
    })

    route(API.contents, {
      async GET(req, res) {
        send(res, await service.contents(queryInt(urlOf(req), 'limit', LIMITS.contents)))
      },
    })

    route(API.capabilities, {
      async GET(_req, res) {
        send(res, await service.capabilities())
      },
    })

    route(API.status, {
      GET(_req, res) {
        writeJson(res, 200, service.status())
      },
    })

    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    })
  })
}
