/**
 * 跨站防护（变更类端点：`POST /start`、`POST /stop`）。
 *
 * loopback 围栏只回答「请求是不是本机发来的」，回答不了「是本机哪个页面发来的」：
 * 用户在本机浏览器里打开的任何网页，都能往 `http://127.0.0.1:3080` 发一个
 * 简单 POST（不带自定义头的 `fetch` 是**免预检**的）。所以变更类端点再加两道：
 *
 * 1. **自定义请求头** `X-DSH-Plugin: awake`。跨源 `fetch` 想带自定义头必须先过
 *    CORS 预检，而本插件的路由不返回任何 `Access-Control-Allow-*`，预检必然失败
 *    ——请求根本发不出去。同源请求不触发预检，所以自家页面零成本。
 * 2. **`Origin` 为空或同源**。挡住「表单类」跨站提交（它们不带自定义头也无预检，
 *    但浏览器一定会带 `Origin`）。
 *
 * 两条都不满足一律 403，不区分原因（避免给探测者做二分）。
 * @module dsh-plugin-awake/host/cross-site
 */
import { RequestError } from './http.js'
import { CODE, PLUGIN_HEADER, PLUGIN_HEADER_VALUE } from './protocol.js'

/**
 * 请求头是否带了本插件的标记。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 带且值正确返回 true。
 */
export function hasPluginHeader(req) {
  const value = req.headers[PLUGIN_HEADER]
  // 重复头的数组形态无法判断哪一个是「真的」，一律拒绝。
  return typeof value === 'string' && value.trim().toLowerCase() === PLUGIN_HEADER_VALUE
}

/**
 * `Origin` 是否为空（非浏览器 / 同源导航）或与 `Host` 同源。
 *
 * 判据只比 authority（`host:port`），不比 scheme：HTTPS 反代下宿主看到的
 * `Host` 仍是同一个 authority，而 scheme 两侧都可能被终止，比它只会误杀。
 * `Origin: null`（沙箱 iframe / `data:` 页面）算不同源。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 通过返回 true。
 */
export function isSameOriginOrEmpty(req) {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  if (typeof origin !== 'string' || origin === 'null') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  return parsed.host.toLowerCase() === host.toLowerCase()
}

/**
 * 变更类请求是否满足跨站防护。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 满足返回 true。
 */
export function isPluginRequest(req) {
  return hasPluginHeader(req) && isSameOriginOrEmpty(req)
}

/**
 * 不满足就抛 403。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {void}
 * @throws {RequestError} 403。
 */
export function assertPluginRequest(req) {
  if (!isPluginRequest(req)) {
    throw new RequestError(
      403,
      CODE.FORBIDDEN,
      `forbidden: POST requires the ${PLUGIN_HEADER}: ${PLUGIN_HEADER_VALUE} header and an empty or same-origin Origin`,
    )
  }
}
