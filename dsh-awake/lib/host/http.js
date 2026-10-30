/**
 * HTTP 管道：JSON 响应、有界请求体、方法分发、错误信封。
 *
 * 与 `dsh-plugin-auto-upgrade/lib/host/http.js` 同构（本仓各插件互不依赖，
 * 共享代码以复制为主），差别只在错误码表来自本插件自己的 `protocol.js`。
 * @module dsh-plugin-awake/host/http
 */
import { CODE, MAX_BODY_BYTES } from './protocol.js'

/**
 * 写一个 JSON 响应。
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

/**
 * 一个由调用方造成的失败，携带应当返回的状态码。
 */
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
 * 读取有上限的 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {number} [limit] 字节上限。
 * @returns {Promise<any>} 解析后的 body；空体返回 undefined。
 * @throws {RequestError} 413 超限 / 400 非法 JSON。
 */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new RequestError(413, CODE.BAD_REQUEST, 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, CODE.BAD_REQUEST, 'request body is not valid JSON')
  }
}

/**
 * 把「方法 → 处理器」表包装成一个路由处理器：先过信任围栏，再做方法围栏与错误信封。
 * @param {Record<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => any>} handlers 接受的 HTTP 方法。
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
      writeJson(res, 405, { ok: false, code: CODE.METHOD_NOT_ALLOWED, error: `method not allowed: ${method}` })
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
