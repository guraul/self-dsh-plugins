/**
 * childSessionId -> { product, bridge, remote }
 *
 * The binding connects one continuable child (keyed by its durable harness
 * session id) to its live remote product session. It lives in memory, so a
 * process restart loses it; `recoverRemoteSessionId` then replays the child's
 * own log (the `PRODUCT_SESSION:<product>:<id>` marker the bridge tool echoes
 * in every result) so the remote session can be resumed rather than reset.
 */
export const bindings = new Map()

export const MARKER = 'PRODUCT_SESSION:'

/**
 * Scan the tail of a session's durable events for the most recent
 * `PRODUCT_SESSION:<product>:<id>` marker. Returns { product, sessionId } or
 * undefined. The walk is bounded: only string leaves are matched, scanning
 * from the newest event backwards, stopping at the first hit.
 *
 * Accepts a session-like `{ events }` (what `foldProgress` passes, built by
 * `loadEvents()` in lib/session-events.js) or, as a last resort, a live
 * `Session` — the real object has no `events` property, so the deprecated
 * `snapshotEvents()` is used there. A settled session exposes neither; recovery
 * for those goes through the durable registry (lib/registry.js) first.
 */
export function recoverRemoteSessionId(session) {
  const events = eventsOf(session)
  if (!Array.isArray(events)) return undefined
  const start = Math.max(0, events.length - 80)
  for (let i = events.length - 1; i >= start; i -= 1) {
    const event = events[i]
    const payload = event && (event.payload !== undefined ? event.payload : event.data !== undefined ? event.data : event.body)
    if (payload === undefined) continue
    const found = scanForMarker(payload)
    if (found) return found
  }
  return undefined
}

function eventsOf(session) {
  if (!session || typeof session !== 'object') return undefined
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents !== 'function') return undefined
  try {
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : undefined
  } catch {
    return undefined
  }
}

function scanForMarker(value) {
  if (typeof value === 'string') {
    const index = value.indexOf(MARKER)
    if (index >= 0) {
      const rest = value.slice(index + MARKER.length)
      const match = rest.match(/^([a-z0-9-]+):([A-Za-z0-9._:-]{6,})/)
      if (match) return { product: match[1], sessionId: match[2] }
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (typeof child === 'string' || (child && typeof child === 'object')) {
      const found = scanForMarker(child)
      if (found) return found
    }
  }
  return undefined
}
