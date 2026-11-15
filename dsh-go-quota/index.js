/**
 * 宿主半边：OpenCode GO 配额的一条只读路由。
 *
 * 浏览器只发 `GET /plugins/go-quota/usage`；取 key、请求上游、归一化、缓存
 * 全在宿主。失败一律回 HTTP 200 + `{ ok: false, code }`，方便客户端分辨
 * 「没配 key / 上游拒绝 / 网络断了 / 上游改了结构」。
 *
 * 失败码：`no-key`（拿不到凭据，或凭据服务不可用）、`unauthorized`（上游 401/403）、
 * `upstream`（其它非 2xx，带 `status`）、`network`（fetch 抛错）、
 * `shape`（结构或字段不合约定）。
 *
 * key 只以 `Authorization` 头发给上游，不进日志、不进错误信息、不进响应体。
 * @module dsh-plugin-go-quota
 */

/** 只认本机回环地址，插件端点绝不对外。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 归一化后三个窗口的固定顺序：5 小时滚动 / 周 / 月。 */
const WINDOW_KEYS = ['rolling', 'weekly', 'monthly']

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1/usage'

/**
 * 把上游体归一成固定顺序的成功体；结构 / 字段不合约定一律 shape 错误。
 * @param {any} json 上游 JSON（`{ usage: { rolling, weekly, monthly } }`）。
 * @returns {{ok: true, windows: Array<{key: string, percent: number, status: string, resetsAt: string}>, fetchedAt: string} | {ok: false, code: string}}
 */
function normalize(json) {
  const usage = json && typeof json === 'object' ? json.usage : undefined
  if (!usage || typeof usage !== 'object') return { ok: false, code: 'shape' }

  const windows = []
  for (const key of WINDOW_KEYS) {
    const window = usage[key]
    if (!window || typeof window !== 'object') return { ok: false, code: 'shape' }
    if (typeof window.percent !== 'number' || !(window.percent >= 0 && window.percent <= 100)) {
      return { ok: false, code: 'shape' }
    }
    if (typeof window.resetsAt !== 'string' || window.resetsAt === '') return { ok: false, code: 'shape' }
    windows.push({
      key,
      percent: window.percent,
      status: typeof window.status === 'string' ? window.status : '',
      resetsAt: window.resetsAt,
    })
  }

  return { ok: true, windows, fetchedAt: new Date().toISOString() }
}

/**
 * 挂载 `GET /plugins/go-quota/usage`。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {object} [config] 配置，另含测试注入缝 `fetch`；生产代码只传配置。
 * @param {string} [config.apiKeyEnv] 存 key 的凭据名。
 * @param {string} [config.baseUrl] 上游地址。
 * @param {number} [config.timeoutMs] 上游超时。
 * @param {number} [config.cacheMs] 成功体缓存时长。
 * @param {typeof fetch} [config.fetch] 假 fetch（测试用）。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const doFetch = config.fetch ?? globalThis.fetch
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const apiKeyEnv = config.apiKeyEnv ?? 'OPENCODE_GO_API_KEY'
  const timeoutMs = config.timeoutMs ?? 15000
  const cacheMs = config.cacheMs ?? 30000

  /** 上次成功体与取回时刻；只存成功，失败下一次直接重试。 */
  let cached = null
  /** 合并中的上游调用；settle 即清空，期间的新请求共用它。 */
  let inflight = null

  /**
   * 打一次上游并归一化；永不 reject，失败也走返回值（避免把细节抛进响应）。
   * @param {string} key 凭据值（只进 `Authorization` 头）。
   * @returns {Promise<{ok: true, windows: Array, fetchedAt: string} | {ok: false, code: string, status?: number}>}
   */
  const fetchUsage = async (key) => {
    let res
    try {
      res = await doFetch(baseUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return { ok: false, code: 'network' }
    }
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized' }
    if (!res.ok) return { ok: false, code: 'upstream', status: res.status }

    let json
    try {
      json = await res.json()
    } catch {
      return { ok: false, code: 'shape' }
    }
    return normalize(json)
  }

  /**
   * 读缓存 → 复用在途调用 → 发起新调用。
   * @param {string} key 凭据值。
   * @returns {Promise<object>} 归一后的响应体。
   */
  const load = (key) => {
    if (cached && Date.now() - cached.at < cacheMs) return Promise.resolve(cached.body)
    if (!inflight) {
      inflight = fetchUsage(key).then((body) => {
        inflight = null
        if (body.ok) cached = { body, at: Date.now() }
        return body
      })
    }
    return inflight
  }

  /**
   * 回一个 JSON 响应；失败码也用 200，只有本地围栏（405/403）用真状态码。
   * @param {import('node:http').ServerResponse} res 响应。
   * @param {number} status HTTP 状态码。
   * @param {object} body 响应体。
   * @returns {void}
   */
  const send = (res, status, body) => {
    res.statusCode = status
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }

  /**
   * 路由处理器工厂：接注入的凭据服务，返回「方法 → 回环地址 → 取 key → 上游 / 缓存」处理器。
   * @param {{resolve: (name: string) => Promise<{value?: string} | undefined>}} credentials 注入的凭据服务。
   * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
   */
  const handler = (credentials) => async (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'method-not-allowed' })
    if (!LOOPBACK.has(req.socket.remoteAddress)) return send(res, 403, { ok: false, code: 'forbidden' })

    let body
    try {
      const hit = await credentials.resolve(apiKeyEnv)
      body = hit?.value ? await load(hit.value) : { ok: false, code: 'no-key' }
    } catch {
      // 凭据服务不可用与「没配 key」对用户是同一件事：都给可操作的 no-key，
      // 且响应体不带任何错误细节。
      body = { ok: false, code: 'no-key' }
    }
    send(res, 200, body)
  }

  ctx.inject(['webServer', 'credentials'], (scope) => {
    const dispose = scope.webServer.register({
      kind: 'exact',
      path: '/plugins/go-quota/usage',
      handler: handler(scope.credentials),
    })
    // 卸载 / disable / 重启：先摘路由，避免「路由还在但插件已死」。
    ctx.effect(() => {
      return () => {
        dispose()
      }
    })
  })
}

export const name = 'dsh-go-quota'

export const inject = ['webServer', 'credentials']
