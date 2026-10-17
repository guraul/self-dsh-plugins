/**
 * Pure command routing for the WeCom workspace switcher.
 *
 * Everything here is intentionally free of DSH / Cordis imports so the rules
 * stay unit-testable under `node --test` + type stripping: command parsing,
 * session-key derivation and selector resolution all operate on plain data the
 * host plugin hands in.
 */

/** The workspace fields the router reads (a structural subset of `Workspace`). */
export interface WorkspaceEntityLike {
  /** Stable registry id (uuid for real records, `path:<dir>` for fallbacks). */
  readonly id: string
  /** Canonical directory path. */
  readonly path: string
  /** Display title. */
  readonly title: string
  /** Sessions the registry groups under this workspace. */
  readonly sessionIds?: readonly string[]
}

/** One chat window's active workspace. */
export interface WorkspaceBinding {
  /** Workspace record id. */
  readonly id: string
  /** Directory new Agent sessions open in. */
  readonly path: string
  /** Display title used in replies. */
  readonly title: string
}

/** A parsed `/ws …` command; `undefined` means "plain chat text". */
export type WorkspaceCommand =
  /** `/ws`, `/ws list`, `/workspaces`, `/工作区` — list every workspace. */
  | { kind: 'list' }
  /** `/ws help`, `/ws ?`, `/ws 帮助`. */
  | { kind: 'help' }
  /** `/ws reset`, `/ws default` — back to the configured default workspace. */
  | { kind: 'reset' }
  /** `/ws add <path>` — register an existing directory and switch to it. */
  | { kind: 'add'; path: string }
  /** `/ws <序号|title|path|id>` — switch this window's workspace. */
  | { kind: 'switch'; selector: string }

/**
 * Command heads the bridge handles itself: `/ws`, `/workspace`, `/workspaces`
 * and `/工作区`, followed by optional arguments. A head glued to more letters
 * (`/wss`, `/workspacex`) must not match, hence the argument group requires
 * whitespace.
 */
const COMMAND_PATTERN = /^\/(ws|workspace|workspaces|工作区)(?:\s+([\s\S]*))?$/i

/** Arguments that map onto a dedicated command kind. */
const ADD_PATTERN = /^add(?:\s+([\s\S]*))?$/i

/**
 * Parse one inbound text message as a workspace command.
 * @param text - trimmed message text after the bot mention is stripped.
 * @returns the parsed command, or `undefined` when the text is ordinary chat.
 */
export function parseWorkspaceCommand(text: string): WorkspaceCommand | undefined {
  const match = COMMAND_PATTERN.exec(text.trim())
  if (match === null) return undefined
  const args = (match[2] ?? '').trim()
  if (args === '') return { kind: 'list' }
  const lower = args.toLowerCase()
  if (lower === 'help' || lower === '?' || args === '帮助') return { kind: 'help' }
  if (lower === 'reset' || lower === 'default') return { kind: 'reset' }
  if (lower === 'list') return { kind: 'list' }
  const add = ADD_PATTERN.exec(args)
  if (add !== null) return { kind: 'add', path: (add[1] ?? '').trim() }
  return { kind: 'switch', selector: args }
}

/**
 * Session key backing one window's Agent, per workspace.
 *
 * The default workspace keeps the bare window key so windows created before
 * multi-workspace support keep their `wecom-*` session ids; every other
 * workspace appends its registry id, giving each workspace an independent
 * session that is resumed when the window switches back.
 * @param windowKey - {@link WecomSessionRef.key}-style `single:<userid>` / `group:<chatid>`.
 * @param binding - workspace the window is bound to.
 * @param defaultWorkspacePath - path of the configured default workspace.
 * @returns the session key to look the chat state up under.
 */
export function sessionKeyForWorkspace(
  windowKey: string,
  binding: WorkspaceBinding,
  defaultWorkspacePath: string,
): string {
  return binding.path === defaultWorkspacePath
    ? windowKey
    : `${windowKey}#ws=${binding.id}`
}

/** Selector resolution: a match, or a user-facing reason it failed. */
export type WorkspaceSelectorResult =
  | { ok: true; entry: WorkspaceEntityLike }
  | { ok: false; reason: string }

/** Drop trailing separators so `/path` and `/path/` compare equal. */
function trimTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  return trimmed === '' ? path : trimmed
}

/** Final path segment without importing `node:path` (keeps this module pure). */
function pathBasename(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/**
 * Pick one workspace out of an ordered list.
 *
 * Accepted spellings, in order: a 1-based decimal index, an exact path
 * (trailing slashes ignored), an exact registry id, an exact title
 * (case-insensitive), and finally a unique directory basename. Ambiguous
 * titles are refused rather than guessed, so a switch never lands on the
 * wrong directory.
 * @param entries - workspaces in registry display order (the `/ws` list order).
 * @param selector - what the user typed after `/ws`.
 * @returns the matched entry, or the reason to reply with.
 */
export function resolveWorkspaceSelector(
  entries: readonly WorkspaceEntityLike[],
  selector: string,
): WorkspaceSelectorResult {
  const key = selector.trim()
  if (key === '') return { ok: false, reason: '未提供工作区选择器。用法：/ws <序号|title|路径|id>' }

  if (/^\d+$/u.test(key)) {
    const index = Number(key)
    if (index < 1 || index > entries.length) {
      return {
        ok: false,
        reason: `序号 ${key} 超出范围（当前共 ${String(entries.length)} 个工作区，序号 1-${String(entries.length)}）`,
      }
    }
    const entry = entries[index - 1]
    if (entry === undefined) return { ok: false, reason: `序号 ${key} 超出范围` }
    return { ok: true, entry }
  }

  const keyPath = trimTrailingSlash(key)
  const byPath = entries.find((entry) => trimTrailingSlash(entry.path) === keyPath)
  if (byPath !== undefined) return { ok: true, entry: byPath }

  const byId = entries.find((entry) => entry.id === key)
  if (byId !== undefined) return { ok: true, entry: byId }

  const lower = key.toLowerCase()
  const byTitle = entries.filter((entry) => entry.title.toLowerCase() === lower)
  if (byTitle.length === 1) return { ok: true, entry: byTitle[0] as WorkspaceEntityLike }
  if (byTitle.length > 1) {
    return {
      ok: false,
      reason: `标题「${key}」对应 ${String(byTitle.length)} 个工作区，请改用路径或 id 指定`,
    }
  }

  const byBasename = entries.filter((entry) => pathBasename(entry.path).toLowerCase() === lower)
  if (byBasename.length === 1) return { ok: true, entry: byBasename[0] as WorkspaceEntityLike }
  if (byBasename.length > 1) {
    return {
      ok: false,
      reason: `路径末段「${key}」对应 ${String(byBasename.length)} 个工作区，请改用完整路径或 id 指定`,
    }
  }

  return { ok: false, reason: `未找到匹配的工作区：${key}。发 /ws 查看列表` }
}
