import { recoverRemoteSessionId } from './bindings.js'
import { stripProductSessionTag } from './relay-contract.js'

/**
 * Fold the tail of one child session's durable events into a compact progress
 * snapshot: last turn, step count, the latest product_submit task, the latest
 * answer text, last activity time, whether (and when) the last turn closed, and
 * the pinned product/remote session id (from the PRODUCT_SESSION marker the
 * bridge tool echoes in every result).
 *
 * Takes a session-like `{ events }`; callers get that from
 * `loadEvents(ctx, childId)` (lib/session-events.js), never from the live
 * `Session` object — the real one has no `events` property (issue #41).
 * Real events carry their body in `data`, so `payload` is read with a `data`
 * fallback as well.
 * Schema-tolerant: unknown event shapes are skipped, never thrown on.
 */
export function foldProgress(session) {
  const events = session && session.events
  if (!Array.isArray(events)) return null
  const out = {
    turn: undefined,
    stepCount: 0,
    lastTask: undefined,
    lastAnswer: undefined,
    lastActivityAt: undefined,
    endedAt: undefined,
    turnOpen: false,
  }
  const start = Math.max(0, events.length - 150)
  for (let i = start; i < events.length; i += 1) {
    const event = events[i]
    if (!event || typeof event.type !== 'string') continue
    const ts = event.timestamp ?? event.time ?? undefined
    const payload = payloadOf(event)
    switch (event.type) {
      case 'turn/start': {
        if (typeof payload.turn === 'number') out.turn = payload.turn
        if (ts !== undefined) out.lastActivityAt = ts
        out.turnOpen = true
        break
      }
      case 'turn/end': {
        if (ts !== undefined) {
          out.lastActivityAt = ts
          out.endedAt = ts
        }
        out.turnOpen = false
        break
      }
      case 'step/start': {
        out.stepCount += 1
        if (ts !== undefined) out.lastActivityAt = ts
        break
      }
      case 'assistant/message': {
        const text = messageText(payload)
        if (text) {
          out.lastAnswer = displayAnswer(text)
          if (ts !== undefined) out.lastActivityAt = ts
        }
        break
      }
      case 'tool/call': {
        const task = submittedTask(payload)
        if (task) out.lastTask = task.slice(0, 300)
        if (ts !== undefined) out.lastActivityAt = ts
        break
      }
      case 'tool/result': {
        const text = toolResultText(payload)
        if (text) {
          out.lastAnswer = displayAnswer(text)
          if (ts !== undefined) out.lastActivityAt = ts
        }
        break
      }
      default:
        break
    }
  }
  const marker = recoverRemoteSessionId(session)
  if (marker) {
    out.product = marker.product
    out.remoteSessionId = marker.sessionId
  }
  return out
}

/**
 * One answer as `subagent_progress` displays it: the machine tag
 * `product_submit` appends is stripped first, so the marker never shows up in
 * model-visible progress output (only `product_wait` may read it, to verify).
 */
function displayAnswer(text) {
  return stripProductSessionTag(text).slice(0, 300)
}

/**
 * The latest answer text of one child session, UNTRUNCATED. Same tail scan and
 * same precedence as `foldProgress().lastAnswer` (a later `assistant/message`
 * or `tool/result` overwrites an earlier one), but without the 300-character
 * display cap — `product_wait` returns this as the child's real answer.
 */
export function lastAnswerFull(session) {
  const events = session && session.events
  if (!Array.isArray(events)) return undefined
  let answer
  const start = Math.max(0, events.length - 150)
  for (let i = start; i < events.length; i += 1) {
    const event = events[i]
    if (!event || typeof event.type !== 'string') continue
    const payload = payloadOf(event)
    if (event.type === 'assistant/message') {
      const text = messageText(payload)
      if (text) answer = text
    } else if (event.type === 'tool/result') {
      const text = toolResultText(payload)
      if (text) answer = text
    }
  }
  return answer
}

/**
 * Fold the tail of a child session's durable events into a compact internal
 * trace: the most recent turn/step boundaries, tool calls (product_submit with
 * the submitted task), and relayed answers, newest last. `assistant/chunk`
 * stream events are skipped so the trace stays readable.
 */
export function foldTrace(session, max = 12) {
  const events = session && session.events
  if (!Array.isArray(events)) return []
  const trace = []
  for (let i = events.length - 1; i >= 0 && trace.length < max; i -= 1) {
    const event = events[i]
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'assistant/chunk') continue
    trace.unshift(compactEvent(event))
  }
  return trace
}

function compactEvent(event) {
  const timestamp = event.timestamp ?? event.time
  const payload = payloadOf(event)
  let brief
  switch (event.type) {
    case 'turn/start':
      brief = `turn ${payload.turn} start`
      break
    case 'turn/end':
      brief = `turn ${payload.turn} end`
      break
    case 'step/start':
      brief = `step ${payload.turn}.${payload.step}`
      break
    case 'tool/call': {
      const task = submittedTask(payload)
      if (task) {
        brief = `product_submit: ${task.slice(0, 80)}`
      } else {
        brief = `tool ${payload.name || '?'}`
      }
      break
    }
    case 'assistant/message': {
      const text = messageText(payload)
      brief = text ? `answer: ${text.slice(0, 120)}` : 'assistant message'
      break
    }
    default:
      brief = event.type
  }
  return { at: timestamp !== undefined ? new Date(timestamp).toISOString() : undefined, event: event.type, brief }
}

/** Best-effort token usage fold from assistant/message payloads. */
export function foldTokenUsage(session) {
  const events = session && session.events
  if (!Array.isArray(events)) return undefined
  let input = 0
  let output = 0
  let cacheRead = 0
  const start = Math.max(0, events.length - 150)
  for (let i = start; i < events.length; i += 1) {
    const event = events[i]
    if (!event || event.type !== 'assistant/message') continue
    const payload = payloadOf(event)
    const message = payload.message || payload
    const usage = message.usage || payload.usage
    if (!usage || typeof usage !== 'object') continue
    if (typeof usage.input_tokens === 'number') input += usage.input_tokens
    if (typeof usage.output_tokens === 'number') output += usage.output_tokens
    if (typeof usage.cache_read_input_tokens === 'number') cacheRead += usage.cache_read_input_tokens
  }
  if (input === 0 && output === 0 && cacheRead === 0) return undefined
  return { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead }
}

function payloadOf(event) {
  if (!event) return {}
  if (event.payload !== undefined && event.payload !== null) return event.payload
  if (event.data !== undefined && event.data !== null) return event.data
  if (event.body !== undefined && event.body !== null) return event.body
  return {}
}

function messageText(payload) {
  const message = (payload && payload.message) || payload
  const content = message && message.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
  return text || undefined
}

/**
 * The task text of a `product_submit` tool call, or undefined for any other
 * call. Real `tool/call` events carry `{ name, arguments }` where `arguments`
 * is the JSON-encoded argument object; older fixtures nest `{ args: { task } }`.
 */
function submittedTask(payload) {
  if (!payload || payload.name !== 'product_submit') return undefined
  const raw = payload.args !== undefined ? payload.args : payload.arguments
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      args = undefined
    }
  }
  return extractString(args, 'task') || extractString(payload, 'task')
}

/**
 * The text of a `tool/result` event. Real results carry `data.message` with the
 * usual content blocks; scanning arbitrary leaves would otherwise return the
 * message id instead of the text.
 */
function toolResultText(payload) {
  if (!payload) return undefined
  const message = payload.message
  if (message && typeof message === 'object') return messageText({ message })
  return extractString(payload, 'text')
}

function extractString(value, key) {
  if (!value || typeof value !== 'object') return undefined
  if (typeof value[key] === 'string') return value[key]
  for (const k of Object.keys(value)) {
    const v = value[k]
    if (v && typeof v === 'object') {
      const result = extractString(v, key)
      if (result) return result
    }
  }
  return undefined
}
