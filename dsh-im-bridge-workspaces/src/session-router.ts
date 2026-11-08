/**
 * Pure command routing for the pinned-session switcher (`/s …`).
 *
 * Everything here is intentionally free of DSH / Cordis imports so the rules
 * stay unit-testable under `node --test` + type stripping: command parsing and
 * session-key derivation all operate on plain data the host plugin hands in.
 */

/** A parsed `/s …` command; `undefined` means "plain chat text". */
export type SessionCommand =
  /** `/s`, `/s list`, `/session`, `/会话` — list this window's pinned sessions. */
  | { kind: 'list' }
  | { kind: 'more' }
  /** `/s help`, `/s ?`, `/s 帮助`. */
  | { kind: 'help' }
  /** `/s reset`, `/s default` — back to the default session. */
  | { kind: 'reset' }
  /** `/s <序号>` — bind by the 1-based index shown in this window's last `/s` listing. */
  | { kind: 'bindIndex'; index: number }
  /** `/s <sessionId>` — pin this window to one DSH session. */
  | { kind: 'bind'; sessionId: string }

/**
 * Command heads the bridge handles itself: `/s`, `/session` and `/会话`,
 * followed by optional arguments. A head glued to more letters (`/sx`,
 * `/sessionx`) must not match, hence the argument group requires whitespace.
 */
const COMMAND_PATTERN = /^\/(s|session|会话)(?:\s+([\s\S]*))?$/i

/**
 * Session ids are DSH-shaped identifiers: letters and digits first, then
 * letters, digits and `._:-`. Anything else (spaces, CJK, leading `-`) means
 * the message was ordinary chat that merely started with `/s`.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/**
 * A list index is pure digits, 1–3 wide (`/s 1` … `/s 999`); digits glued to
 * anything else (`1a`) are not one.
 */
const BIND_INDEX_PATTERN = /^[0-9]{1,3}$/

/**
 * Digit-led arguments are index attempts only — real session ids start with a
 * letter — so anything digit-led that is not a valid index is plain chat.
 */
const DIGIT_LED_PATTERN = /^[0-9]/

/**
 * Parse one inbound text message as a session command.
 * @param text - trimmed message text after the bot mention is stripped.
 * @returns the parsed command, or `undefined` when the text is ordinary chat.
 */
export function parseSessionCommand(text: string): SessionCommand | undefined {
  const match = COMMAND_PATTERN.exec(text.trim())
  if (match === null) return undefined
  const args = (match[2] ?? '').trim()
  if (args === '') return { kind: 'list' }
  const lower = args.toLowerCase()
  if (lower === 'list') return { kind: 'list' }
  if (lower === 'more' || args === '更多') return { kind: 'more' }
  if (lower === 'help' || lower === '?' || args === '帮助') return { kind: 'help' }
  if (lower === 'reset' || lower === 'default') return { kind: 'reset' }
  // A digit-led argument can only be an index: bind it when it is a valid
  // 1–3 digit number ≥ 1, and treat `0` / `00` / `1a` / `1234` as plain chat.
  if (DIGIT_LED_PATTERN.test(args)) {
    if (!BIND_INDEX_PATTERN.test(args)) return undefined
    const index = Number.parseInt(args, 10)
    if (index < 1) return undefined
    return { kind: 'bindIndex', index }
  }
  if (!SESSION_ID_PATTERN.test(args)) return undefined
  return { kind: 'bind', sessionId: args }
}

/**
 * Session key backing one window's Agent for a pinned session.
 *
 * Appends the pinned session id to the bare window key so every pinned session
 * gets its own state slot while unpinned windows keep their legacy ids.
 * @param windowKey - {@link WecomSessionRef.key}-style `single:<userid>` / `group:<chatid>`.
 * @param sessionId - the pinned DSH session id.
 * @returns the session key to look the chat state up under.
 */
export function sessionKeyForPinnedSession(windowKey: string, sessionId: string): string {
  return `${windowKey}#sid=${sessionId}`
}
