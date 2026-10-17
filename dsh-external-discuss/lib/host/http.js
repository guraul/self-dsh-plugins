/**
 * 最小 HTTP 路由工具：方法分派 + loopback 信任围栏 + JSON 错误信封。
 * 与 dsh-auto-upgrade 的同类实现保持同样的形状，便于对读。
 */

/** 带状态码与稳定错误码的请求错误。 */
export class RequestError extends Error {
  /**
   * @param {number} status HTTP 状态码。
   * @param {string} code 稳定错误码。
   * @param {string} message 人类可读信息。
   * @param {unknown} [detail] 附加诊断数据。
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
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应对象。
 * @param {number} status HTTP 状态码。
 * @param {unknown} body 响应体。
 * @returns {void}
 */
export function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * 请求是否来自本机回环地址。
 * @param {import('node:http').IncomingMessage} req 请求对象。
 * @returns {boolean} 判定结果。
 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 把「方法 → 处理器」表包装成路由处理器。
 * @param {Record<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => unknown>} handlers 接受的 HTTP 方法。
 * @param {(req: import('node:http').IncomingMessage) => boolean} fence 信任围栏。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} 路由处理器。
 */
export function createRoute(handlers, fence) {
  return async (req, res) => {
    if (!fence(req)) {
      writeJson(res, 403, { ok: false, code: 'LOOPBACK_ONLY', error: 'forbidden: loopback-only' })
      return
    }
    const method = req.method ?? 'GET'
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
    if (handler === undefined) {
      writeJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: `method not allowed: ${method}` })
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
        code: 'INTERNAL',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
