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
