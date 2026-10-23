/**
 * Session events adapter: one child session id → one normalized event array.
 *
 * Why a service read instead of `session.events` (issue #41): the real DSH
 * `Session` object has no `events` property, and `sessions.get(id)` serves only
 * *live* sessions — a settled child is gone from the store. Both `subagent_progress`
 * and `product_wait` therefore folded an always-null session.
 *
 * The read goes through the `sessionQuery` service, which is live-preferred and
 * falls back to persistence, so it also covers settled children:
 *  - `readSession(id).events` — complete raw event log, each event carrying its
 *    `data` payload. This is the preferred call: `listEvents(id)` returns
 *    *lightweight records* (`sessionId, seq, type, time, surface`) with no
 *    payload at all, which cannot feed `lastAnswer` / `lastTask`.
 *  - `listEvents(id)` — kept as a second choice for a sessionQuery build
 *    without `readSession`; still useful for turn/step counts.
 *
 * `session.snapshotEvents()` is only a last-resort fallback (live sessions
 * only, deprecated upstream), and the raw `session.v4.jsonl.zstd` files are
 * never read directly — they are multi-frame zstd.
 */
const DEFAULT_TIMEOUT_MS = 5000

let warned = false

/**
 * Read one session's events in a fold-ready shape. Never throws: any failure
 * (missing service, read error, timeout) degrades to `[]`.
 *
 * Normalization keeps every original field and only adds what the folds read:
 *  - `payload` mirrors `data` (real events are `{ type, seq, time, data }`)
 *  - `timestamp` mirrors `time`
 *  - `events` may be passed through as-is when `sessionId` is an array/`{ events }`
 *
 * @param {object} ctx - plugin context exposing `get(name)`.
 * @param {string|{events?: unknown[], id?: string}} sessionId - child session id.
 * @param {{timeoutMs?: number}} [options] - timeout override (tests).
 * @returns {Promise<object[]>} normalized events, ascending; `[]` on failure.
 */
export async function loadEvents(ctx, sessionId, options = {}) {
  const direct = eventsOf(sessionId)
  if (direct) return normalizeAll(direct)
  const id = idOf(sessionId)
  if (!id) return []

  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS

  const query = service(ctx, 'sessionQuery')
  if (query) {
    try {
      const events = await withTimeout(readViaQuery(query, id), timeoutMs)
      if (Array.isArray(events)) return normalizeAll(events)
    } catch (error) {
      warnOnce(ctx, `sessionQuery could not read session ${id} (${messageOf(error)}); falling back to the live session log`)
    }
  }

  const live = readViaSessions(service(ctx, 'sessions'), id)
  return live ? normalizeAll(live) : []
}

function eventsOf(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.events)) return value.events
  return undefined
}

function idOf(value) {
  if (typeof value === 'string' && value.length > 0) return value
  if (value && typeof value.id === 'string' && value.id.length > 0) return value.id
  return undefined
}

function service(ctx, name) {
  if (!ctx || typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(name) || undefined
  } catch {
    return undefined
  }
}

async function readViaQuery(query, id) {
  if (typeof query.readSession === 'function') {
    try {
      const loaded = await query.readSession(id)
      if (loaded && Array.isArray(loaded.events)) return loaded.events
    } catch {
      // older builds may not serve this call; try the record list next
    }
  }
  if (typeof query.listEvents === 'function') {
    const records = await query.listEvents(id)
    if (Array.isArray(records)) return records
  }
  return undefined
}

function readViaSessions(sessions, id) {
  if (!sessions || typeof sessions.get !== 'function') return undefined
  try {
    const session = sessions.get(id)
    if (!session || typeof session.snapshotEvents !== 'function') return undefined
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : undefined
  } catch {
    return undefined
  }
}

function normalizeAll(events) {
  const out = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const copy = { ...event }
    if (copy.payload === undefined) {
      const body = copy.data !== undefined ? copy.data : copy.body
      if (body !== undefined) copy.payload = body
    }
    if (copy.timestamp === undefined && copy.time !== undefined) copy.timestamp = copy.time
    out.push(copy)
  }
  return out
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function warnOnce(ctx, text) {
  if (warned) return
  warned = true
  try {
    const logger = typeof ctx.logger === 'function'
      ? ctx.logger('product-subagents')
      : ctx.logger
    if (logger && typeof logger.warn === 'function') {
      logger.warn(text)
      return
    }
  } catch {
    // fall through to console
  }
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[product-subagents] ${text}`)
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
