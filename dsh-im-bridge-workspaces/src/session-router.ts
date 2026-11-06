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
  /** `/s help`, `/s ?`, `/s 帮助`. */
  | { kind: 'help' }
  /** `/s reset`, `/s default` — back to the default session. */
  | { kind: 'reset' }
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
  if (lower === 'help' || lower === '?' || args === '帮助') return { kind: 'help' }
  if (lower === 'reset' || lower === 'default') return { kind: 'reset' }
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

/**
 * Short form of a session id for list display: drops the `session-` prefix
 * and keeps the first 8 characters (shorter ids are shown as-is).
 * @param sessionId - full DSH session id.
 * @returns the display short id.
 */
export function shortSessionId(sessionId: string): string {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return bare.length > 8 ? bare.slice(0, 8) : bare
}
