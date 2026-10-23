import { defineTool } from '@deepseek-ai/dsh-tools'
import { stripUndefined } from '../lossless.js'
import { findChildEntry } from '../children.js'

const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 600000
const FALLBACK_POLL_MS = 2000

/**
 * Wait tool: attach to a continuable child and block until it settles,
 * returning its final answer.
 *
 * Two independent wake-up signals: the parent-scoped `subagent/end` event and
 * the child's own durable session log. The subscription is established BEFORE
 * the activity snapshot, so a settle that lands while `listChildren()` is in
 * flight still wakes this call; the log fallback covers the case where the
 * one-shot event was emitted before this call ever subscribed.
 */
export function registerProductWait(ctx, deps) {
  const { foldProgress, foldTrace, lastAnswerFull } = deps
  ctx.tools.register(defineTool({
    name: 'product_wait',
    description: 'Block until the given product subagent finishes (or the timeout elapses), then return its final answer, stop reason, and latest trace. Attaches to a background subagent id returned by product_delegate — no polling needed on the caller side. Returns immediately with status "ready" when the child already settled, and "timeout"/"aborted" otherwise. detectedBy reports which signal woke the call: "event", "session-log", "already-settled" or "timeout".',
    parameters: {
      subagent_id: { type: 'string', required: true, description: 'The continuable child session id returned by product_delegate.' },
      timeout_ms: { type: 'number', description: 'Max milliseconds to wait (default 120000, capped 600000).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const childId = args.subagent_id
      const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS)
      const parent = exec.agent
      const signal = exec.signal
      const sessionSvc = ctx.get('sessions')

      if (signal && signal.aborted) return stripUndefined({ childId, status: 'aborted' })

      const foldNow = () => {
        const session = sessionSvc ? sessionSvc.get(childId) : undefined
        return session ? foldProgress(session) : null
      }

      // The durable half of a settlement: the child's own log shows a closed
      // LAST turn (a resumed child opens a new turn and keeps the previous
      // turn/end in its tail) AND an answer. An answer alone is not enough — a
      // turn that is still streaming tokens has one too.
      const settledFold = () => {
        const fold = foldNow()
        return fold && fold.endedAt !== undefined && fold.turnOpen !== true && fold.lastAnswer ? fold : null
      }

      let waitDone = false
      let finishWait = () => {}
      let startFallback = () => {}
      let off = () => {}
      let timer
      let interval
      const onAbort = () => finishWait({ status: 'aborted' })
      const cleanup = () => {
        off()
        clearTimeout(timer)
        if (interval !== undefined) clearInterval(interval)
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      }

      const waitPromise = new Promise((resolve) => {
        const finish = (value) => {
          if (waitDone) return
          waitDone = true
          cleanup()
          resolve(value)
        }
        finishWait = finish

        off = ctx.on('subagent/end', (info) => {
          if (info && info.id === childId) finish({ status: 'completed', detectedBy: 'event', info })
        })

        const checkLog = () => {
          if (waitDone) return
          if (settledFold()) finish({ status: 'completed', detectedBy: 'session-log' })
        }

        startFallback = () => {
          if (waitDone) return
          checkLog()
          if (waitDone) return
          interval = setInterval(checkLog, FALLBACK_POLL_MS)
          if (typeof interval.unref === 'function') interval.unref()
        }

        timer = setTimeout(() => {
          if (settledFold()) finish({ status: 'completed', detectedBy: 'session-log' })
          else finish({ status: 'timeout', detectedBy: 'timeout' })
        }, timeoutMs)

        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true })
        }
      })

      let activity = 'unknown'
      try {
        const children = await ctx.subagents.listChildren(parent.session.id, signal)
        const me = findChildEntry(children, childId)
        activity = me ? me.activity : 'unknown'
      } catch {
        activity = 'unknown'
      }

      if (!waitDone) {
        if (activity === 'inactive') {
          finishWait({ status: 'ready', detectedBy: 'already-settled' })
        } else if (activity === 'unknown') {
          finishWait(settledFold()
            ? { status: 'completed', detectedBy: 'session-log' }
            : { status: 'unknown', note: 'no such subagent under this parent (or listing unavailable)' })
        } else {
          startFallback()
        }
      }

      const outcome = await waitPromise

      const session = sessionSvc ? sessionSvc.get(childId) : undefined
      const fold = session ? foldProgress(session) : null
      const lastAssistant = outcome.info && outcome.info.lastAssistantMessage
      // A folded answer only counts when its turn is closed — on a resumed
      // child the tail still holds the previous turn's answer while a new turn
      // is streaming, and returning that would be a silent wrong answer.
      const closed = Boolean(fold && fold.endedAt !== undefined && fold.turnOpen !== true)
      let answer
      if (lastAssistant) {
        answer = lastAssistant.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      } else if (closed || (outcome.status === 'ready' && fold && fold.turnOpen !== true)) {
        answer = lastAnswerFull(session)
      }
      return stripUndefined({
        childId,
        status: outcome.status,
        detectedBy: outcome.detectedBy,
        note: outcome.note,
        stopReason: outcome.info ? outcome.info.stopReason : undefined,
        answer: answer || undefined,
        pinnedProduct: fold ? fold.product : undefined,
        remoteSessionId: fold ? fold.remoteSessionId : undefined,
        progress: outcome.status === 'timeout' ? {
          lastActivityAt: fold && fold.lastActivityAt ? new Date(fold.lastActivityAt).toISOString() : undefined,
          receivedChars: fold && fold.lastAnswer ? fold.lastAnswer.length : 0,
          lastTask: fold ? fold.lastTask : undefined,
        } : undefined,
        trace: session ? foldTrace(session) : undefined,
      })
    },
  }))
}
