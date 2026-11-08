/**
 * The token URL of a running `dsh web`, recovered from its stdout log.
 *
 * `dsh web` prints `http://127.0.0.1:<port>/?token=<token>` once per start, and
 * the token changes on every start. `.dsh-web/url.txt` used to keep whatever a
 * human happened to paste there, so after a restart it pointed at a dead
 * token. The helper refreshes it from the log instead.
 *
 * Kept pure and dependency-free so `test/token-url.test.mjs` can cover the
 * parsing rules without touching the filesystem.
 */

/** Matches one `http://host:port/?token=…` occurrence. */
const TOKEN_URL = /https?:\/\/[^\s"'<>]+[?&]token=[A-Za-z0-9_-]{6,}/g

/**
 * Last token URL in `text`, optionally restricted to one port.
 *
 * The log accumulates every past start, so the LAST match is the current one.
 *
 * @param {string} text log text (a whole file or a tail).
 * @param {number} [port] restrict to URLs on this port.
 * @returns {string | undefined} the URL, or undefined when none matches.
 */
export function latestTokenUrl(text, port) {
  const matches = String(text ?? '').match(TOKEN_URL)
  if (matches === null) return undefined
  const wanted = typeof port === 'number' && Number.isFinite(port)
    ? matches.filter((url) => url.includes(`:${port}/`))
    : matches
  return wanted.length === 0 ? undefined : wanted[wanted.length - 1]
}

/**
 * 从启动地址里取出令牌。
 *
 * 启动令牌是**进程级**的：每次重启都会换。所以校验写操作时要读「当前那份 url.txt」，
 * 不能把令牌缓存在内存里（重启后就是旧的）。
 * @param {string} text url.txt 内容。
 * @returns {string|undefined} 令牌；取不到返回 undefined。
 */
export function tokenOf(text) {
  const matched = /[?&]token=([A-Za-z0-9_-]+)/.exec(String(text ?? ''))
  return matched === null ? undefined : matched[1]
}

/**
 * 判定请求带来的令牌是否可用。
 *
 * 除了当前令牌，还接受**上一个令牌**——重启后已经打开的页面还拿着它，
 * 不认的话用户必须手动重开标签页（#377 的真机症状）。但只给一段宽限期，不让旧令牌长期有效。
 * @param {object} input 输入。
 * @param {string|undefined} input.current 当前令牌。
 * @param {string|undefined} input.previous 启动时记下的上一个令牌。
 * @param {string|undefined} input.presented 请求带来的令牌。
 * @param {number} input.ageMs 距启动过了多久。
 * @param {number} [input.graceMs] 宽限期，默认 10 分钟。
 * @returns {boolean} 可用返回 true。
 */
export function tokenAccepted(input) {
  if (input.current === undefined || input.presented === undefined) return false
  if (input.presented === input.current) return true
  const grace = input.graceMs ?? 10 * 60 * 1000
  return input.previous !== undefined && input.presented === input.previous && input.ageMs <= grace
}

/**
 * 按请求来源决定写操作怎么处理。
 *
 * 宿主给浏览器用的是 HttpOnly cookie，页面 URL 里没有令牌，所以浏览器路径不能靠令牌（#379）。
 * `Sec-Fetch-Site` 由浏览器写入、网页伪造不了，用它判定来源。
 * @param {string|undefined} site `Sec-Fetch-Site` 头的值。
 * @returns {'allow'|'deny'|'token'} 放行 / 拒绝 / 交给令牌校验（脚本没有这个头）。
 */
export function originDecision(site) {
  if (site === 'same-origin') return 'allow'
  if (site === undefined) return 'token'
  return 'deny'
}
