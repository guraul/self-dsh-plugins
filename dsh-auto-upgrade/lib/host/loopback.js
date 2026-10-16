/**
 * Loopback 信任围栏。这族路由能读 npm、重写全局安装树、覆盖 ~/.dsh、
 * 并结束本进程，所以 LAN 暴露的 dsh web 只能服务本机浏览器。
 * 语义：socket 地址为准（绝不信任 X-Forwarded-For），再校验 Host 与浏览器同源标记。
 * @module dsh-plugin-auto-upgrade/host/loopback
 */

/**
 * IPv4 127/8 判定。
 * @param {string} v4 点分十进制地址。
 * @returns {boolean} 是否属于 127/8。
 */
export function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
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
 * 请求是否通过信任围栏。
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
