/**
 * Approval relay: pure bookkeeping and formatting for WeCom approval prompts.
 *
 * Everything here is free of DSH / Cordis / WeCom SDK imports so the rules stay
 * unit-testable under `node --test` + type stripping. The host plugin owns the
 * socket, timers and the DSH request; this module only decides *what to show*
 * and *which request a reply belongs to*.
 */

/** The two decisions a WeCom user can make. */
export type ApprovalDecision = 'allowed-once' | 'rejected'

/** Why a pending approval left the queue. */
export type ApprovalOutcome = ApprovalDecision | 'timeout' | 'unavailable'

/** Button keys carry the request id after the colon. */
export const APPROVE_PREFIX = 'approve:'
export const REJECT_PREFIX = 'reject:'

/** One approval the bridge is waiting on. */
export interface PendingApproval {
  /** Short id shown to the user and echoed in the button key. */
  id: string
  /** WeCom window the prompt belongs to (userid for 1:1, chatid for groups). */
  chatTarget: string
  /** `single` or `group`; decides who may decide. */
  kind: 'single' | 'group'
  /** userid that triggered the tool call; only this user may decide. */
  initiator: string
  toolName: string
  reason?: string
  /** Redacted one-line argument summary. */
  summary: string
  /** Resolves the DSH request; called exactly once by the queue. */
  settle(decision: ApprovalDecision): void
}

/** Minimal card shape the SDK accepts; only the fields we set are typed. */
export interface ApprovalCard {
  card_type: string
  task_id: string
  main_title: { title: string; desc: string }
  sub_title_text: string
  button_list: Array<{ text: string; key: string; style: number }>
}

/** Keys whose values never reach a WeCom message. */
const SECRET_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|credential|cookie|authorization|bearer)/i

/** Inline assignments inside a command line or URL query (`--token x`, `key=v`). */
const SECRET_ASSIGNMENT = /((?:--)?(?:token|secret|password|passwd|api[-_]?key|access[-_]?key)(?:\s*[=:]\s*|\s+))(\S+)/gi

/** Provider token shapes (GitHub, generic bearer, long hex). */
const TOKEN_SHAPES: Array<[RegExp, string]> = [
  [/\b(gh[pousr]_[A-Za-z0-9]{4})[A-Za-z0-9]+/g, '$1***'],
  [/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '***'],
]

/** Field names worth showing first, in priority order. */
const SUMMARY_FIELDS = ['command', 'cmd', 'file_path', 'path', 'url', 'query', 'content']

/** Replace secret-looking substrings inside one string. */
function redactString(value: string): string {
  let out = value.replace(SECRET_ASSIGNMENT, '$1***')
  for (const [pattern, replacement] of TOKEN_SHAPES) out = out.replace(pattern, replacement)
  return out
}

/** Walk a parsed JSON value, blanking secret-named fields. */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '***' : redactValue(inner)
    }
    return out
  }
  if (typeof value === 'string') return redactString(value)
  return value
}

/** Collapse whitespace so a multi-line command stays on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Turn raw tool arguments into a short, redacted, single-line summary.
 *
 * Falls back to the raw string when the arguments are not JSON, and truncates
 * with an ellipsis so a card never carries an unbounded command.
 * @param raw - the tool call's `arguments` string (JSON in practice).
 * @param maxLength - hard cap before the ellipsis.
 * @returns one line safe to put in a WeCom message.
 */
export function redactArguments(raw: string | undefined, maxLength = 160): string {
  if (raw === undefined || raw.trim() === '') return '（无参数）'
  let text = raw
  try {
    const parsed = redactValue(JSON.parse(raw))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const field = SUMMARY_FIELDS.find((name) => typeof record[name] === 'string')
      text = field === undefined ? JSON.stringify(record) : String(record[field])
    } else {
      text = JSON.stringify(parsed)
    }
  } catch {
    text = redactString(raw)
  }
  const flat = oneLine(text)
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`
}

/** Render the plain-text fallback prompt (used when cards fail). */
export function formatApprovalText(
  entry: PendingApproval,
  position: { index: number; total: number },
  timeoutMinutes: number,
): string {
  const lines = [
    `🔐 需要你批准一次操作（${String(position.index)}/${String(position.total)}）`,
    `工具：${entry.toolName}`,
  ]
  if (entry.reason !== undefined && entry.reason !== '') lines.push(`原因：${entry.reason}`)
  lines.push(`内容：${entry.summary}`)
  lines.push(
    `回复「同意 ${entry.id}」放行这一次，或「拒绝 ${entry.id}」拒绝（${String(timeoutMinutes)} 分钟内有效）`,
  )
  return lines.join('\n')
}

/**
 * Build the button card for one pending approval.
 * @param entry - the pending request.
 * @param timeoutMinutes - shown in the subtitle so the user knows the window.
 * @returns a `button_interaction` card.
 */
export function buildApprovalCard(entry: PendingApproval, timeoutMinutes: number): ApprovalCard {
  const subtitle = entry.reason === undefined || entry.reason === ''
    ? entry.summary
    : `${entry.reason}｜${entry.summary}`
  return {
    card_type: 'button_interaction',
    task_id: entry.id,
    main_title: { title: '需要你批准一次操作', desc: entry.toolName },
    sub_title_text: `${subtitle.slice(0, 110)}（${String(timeoutMinutes)} 分钟内有效）`,
    button_list: [
      { text: '同意', key: `${APPROVE_PREFIX}${entry.id}`, style: 1 },
      { text: '拒绝', key: `${REJECT_PREFIX}${entry.id}`, style: 2 },
    ],
  }
}

/** Words a user may type to approve. */
const APPROVE_WORDS = ['同意', '批准', '允许', '可以', 'approve', 'allow', 'yes', 'y']
/** Words a user may type to reject. */
const REJECT_WORDS = ['拒绝', '不同意', '不允许', '不行', 'reject', 'deny', 'no', 'n']

/**
 * Parse a plain-text approval reply such as `同意 3` or `拒绝`.
 *
 * A bare word is only accepted when `solePendingId` is given, so an ambiguous
 * "同意" never decides the wrong request.
 * @param text - inbound message text (already trimmed of bot mentions).
 * @param solePendingId - id to use when the message names none.
 * @returns the decision plus the request id, or undefined when unrelated.
 */
export function parseApprovalReply(
  text: string,
  solePendingId?: string,
): { id: string; decision: ApprovalDecision } | undefined {
  const normalized = oneLine(text).toLowerCase()
  if (normalized === '') return undefined
  const match = /^(同意|批准|允许|可以|approve|allow|yes|y|拒绝|不同意|不允许|不行|reject|deny|no|n)\s*#?\s*([A-Za-z0-9_-]{1,16})?$/i.exec(normalized)
  if (match === null) return undefined
  const word = (match[1] ?? '').toLowerCase()
  const explicitId = match[2]
  const decision: ApprovalDecision = APPROVE_WORDS.includes(word) ? 'allowed-once' : 'rejected'
  if (!REJECT_WORDS.includes(word) && !APPROVE_WORDS.includes(word)) return undefined
  const id = explicitId ?? solePendingId
  if (id === undefined) return undefined
  return { id, decision }
}

/** Parse a card button key into a decision plus request id. */
export function parseButtonKey(key: string): { id: string; decision: ApprovalDecision } | undefined {
  if (key.startsWith(APPROVE_PREFIX)) {
    const id = key.slice(APPROVE_PREFIX.length)
    return id === '' ? undefined : { id, decision: 'allowed-once' }
  }
  if (key.startsWith(REJECT_PREFIX)) {
    const id = key.slice(REJECT_PREFIX.length)
    return id === '' ? undefined : { id, decision: 'rejected' }
  }
  return undefined
}

/** Hooks the host plugin supplies; keeps the queue free of socket code. */
export interface ApprovalQueueHooks {
  /** Show one prompt; resolves once it is on the wire (or throws to fail closed). */
  send(entry: PendingApproval, position: { index: number; total: number }): Promise<void>
  /** Called exactly once per entry, after its decision is known. */
  done(entry: PendingApproval, outcome: ApprovalOutcome): void
}

/**
 * Serial queue for pending approvals.
 *
 * Only one prompt is on the wire at a time: a row of cards in WeCom is easy to
 * mis-click, and a mis-click here grants one out-of-sandbox operation. The next
 * prompt is sent as soon as the active one settles.
 */
export class ApprovalQueue {
  private readonly waiting: PendingApproval[] = []
  private active: PendingApproval | undefined
  private readonly hooks: ApprovalQueueHooks

  constructor(hooks: ApprovalQueueHooks) {
    this.hooks = hooks
  }

  /** Number of prompts not yet decided (including the active one). */
  get size(): number {
    return this.waiting.length + (this.active === undefined ? 0 : 1)
  }

  /** The id of the prompt currently on the wire, if any. */
  get activeId(): string | undefined {
    return this.active?.id
  }

  /** Look up a pending entry without removing it. */
  get(id: string): PendingApproval | undefined {
    if (this.active?.id === id) return this.active
    return this.waiting.find((entry) => entry.id === id)
  }

  /** Queue one approval and start it when the wire is free. */
  add(entry: PendingApproval): void {
    this.waiting.push(entry)
    void this.pump()
  }

  /**
   * Decide one request.
   * @param id - request id from a button key or text reply.
   * @param decision - what the user chose.
   * @param outcome - how it left the queue (defaults to the decision).
   * @returns true when a pending request matched.
   */
  settle(id: string, decision: ApprovalDecision, outcome: ApprovalOutcome = decision): boolean {
    const index = this.waiting.findIndex((entry) => entry.id === id)
    if (index >= 0) {
      // Deciding a queued (not yet shown) prompt: drop it without sending,
      // but still resolve the DSH request so the caller never hangs.
      const [entry] = this.waiting.splice(index, 1)
      if (entry === undefined) return false
      this.hooks.done(entry, outcome)
      entry.settle(decision)
      return true
    }
    if (this.active?.id !== id) return false
    const entry = this.active
    this.active = undefined
    this.hooks.done(entry, outcome)
    entry.settle(decision)
    void this.pump()
    return true
  }

  /** Drop every pending prompt (used on shutdown) without deciding them. */
  clear(): void {
    for (const entry of this.waiting.splice(0)) this.hooks.done(entry, 'unavailable')
    const active = this.active
    this.active = undefined
    if (active !== undefined) this.hooks.done(active, 'unavailable')
  }

  /** Send the next prompt when nothing is on the wire. */
  private async pump(): Promise<void> {
    if (this.active !== undefined) return
    const next = this.waiting.shift()
    if (next === undefined) return
    this.active = next
    try {
      await this.hooks.send(next, { index: 1, total: this.waiting.length + 1 })
    } catch (error) {
      // Sending failed: fail closed instead of leaving the request hanging.
      this.active = undefined
      this.hooks.done(next, 'unavailable')
      next.settle('rejected')
      void this.pump()
    }
  }
}
