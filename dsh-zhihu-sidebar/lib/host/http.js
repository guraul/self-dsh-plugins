/**
 * 路由辅助：回环围栏、JSON 信封、方法分派、查询参数校验。
 *
 * 只读接口挂在 dsh 自带的 webServer 上（不自己开端口），且只服务本机浏览器：
 * 数据背后是用户的知乎账号，LAN 暴露的 dsh web 不该把热榜之外的「我的创作」也送出去。
 * @module dsh-plugin-zhihu-sidebar/host/http
 */

/** 路由族前缀。 */
export const API_PREFIX = '/api/dsh-zhihu-sidebar'

/** 端点表。webServer 以 (kind, path) 为键注册，一条路径只注册一次。 */
export const API = {
  hot: `${API_PREFIX}/hot`,
  search: `${API_PREFIX}/search`,
  contents: `${API_PREFIX}/contents`,
  capabilities: `${API_PREFIX}/capabilities`,
  status: `${API_PREFIX}/status`,
}

/** 统一错误码。 */
export const CODE = {
  LOOPBACK_ONLY: 'E_LOOPBACK_ONLY',
  METHOD_NOT_ALLOWED: 'E_METHOD_NOT_ALLOWED',
  BAD_REQUEST: 'E_BAD_REQUEST',
  INTERNAL: 'E_INTERNAL',
}

/**
 * IPv4 127/8 判定。
 * @param {string} v4 点分十进制地址。
 * @returns {boolean} 是否属于 127/8。
 */
export function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * socket 远端地址是否为本机。
 * @param {string|undefined} address remoteAddress。
 * @returns {boolean} 127/8、::1 或 IPv4 映射回环返回 true。
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/**
 * 主机名是否为本机名字。
 * @param {string} hostname 主机名（不带端口）。
 * @returns {boolean} localhost / 回环地址返回 true。
 */
export function isLoopbackHostname(hostname) {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost' || name.endsWith('.localhost') || isLoopbackAddress(name)
}

/**
 * 请求是否通过信任围栏。socket 地址为准，绝不信任 `X-Forwarded-For`。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 可信返回 true。
 */
export function isLoopbackRequest(req) {
  const socket = req.socket
  if (socket === undefined || !isLoopbackAddress(socket.remoteAddress)) return false

  const rawHost = req.headers.host
  if (typeof rawHost !== 'string' || rawHost === '') return false
  const hostWithoutPort = rawHost.startsWith('[')
    ? rawHost.slice(1, rawHost.indexOf(']') === -1 ? undefined : rawHost.indexOf(']'))
    : rawHost.replace(/:\d+$/, '')
  if (!isLoopbackHostname(hostWithoutPort)) return false

  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false

  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} status 状态码。
 * @param {unknown} body 可 JSON 化对象。
 * @returns {void}
 */
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** 由调用方造成的失败，携带应返回的状态码。 */
export class RequestError extends Error {
  /**
   * @param {number} status HTTP 状态码。
   * @param {string} code 统一错误码。
   * @param {string} message 人话原因。
   * @param {object} [detail] 附加信息。
   */
  constructor(status, code, message, detail) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/**
 * 把「方法 → 处理器」表包装成路由处理器。
 * @param {Record<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => any>} handlers 接受的方法。
 * @param {(req: import('node:http').IncomingMessage) => boolean} fence 信任围栏。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} 路由处理器。
 */
export function createRoute(handlers, fence) {
  return async (req, res) => {
    if (!fence(req)) {
      writeJson(res, 403, { ok: false, code: CODE.LOOPBACK_ONLY, error: 'forbidden: loopback-only' })
      return
    }
    const method = req.method ?? 'GET'
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
    if (handler === undefined) {
      writeJson(res, 405, {
        ok: false,
        code: CODE.METHOD_NOT_ALLOWED,
        error: `method not allowed: ${method}`,
      })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (error instanceof RequestError) {
        writeJson(res, error.status, {
          ok: false,
          code: error.code,
          error: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        })
        return
      }
      writeJson(res, 500, {
        ok: false,
        code: CODE.INTERNAL,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * 读一个整数查询参数并夹到区间内。
 * @param {URL} url 请求 URL。
 * @param {string} name 参数名。
 * @param {{ min: number, max: number, fallback: number }} bounds 区间与默认值。
 * @returns {number} 合法整数。
 * @throws {RequestError} 400。
 */
export function queryInt(url, name, { min, max, fallback }) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return fallback
  if (!/^-?\d+$/.test(raw)) {
    throw new RequestError(400, CODE.BAD_REQUEST, `${name} must be an integer`)
  }
  const value = Number(raw)
  if (value < min || value > max) {
    throw new RequestError(400, CODE.BAD_REQUEST, `${name} must be between ${min} and ${max}`)
  }
  return value
}

/**
 * 读一个必填字符串查询参数。
 * @param {URL} url 请求 URL。
 * @param {string} name 参数名。
 * @param {number} maxLength 长度上限。
 * @returns {string} 去空白后的值。
 * @throws {RequestError} 400。
 */
export function queryText(url, name, maxLength = 200) {
  const raw = url.searchParams.get(name)
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') throw new RequestError(400, CODE.BAD_REQUEST, `${name} is required`)
  if (value.length > maxLength) {
    throw new RequestError(400, CODE.BAD_REQUEST, `${name} must be at most ${maxLength} characters`)
  }
  return value
}
