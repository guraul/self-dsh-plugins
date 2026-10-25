import { defineTool } from '@deepseek-ai/dsh-tools'
import { stripUndefined } from '../lossless.js'
import { findChildEntry } from '../children.js'
import { verifyRelayAnswer } from '../relay-contract.js'
import { loadEvents } from '../session-events.js'

const DEFAULT_TIMEOUT_MS = 300000
const MAX_TIMEOUT_MS = 600000

/**
 * Wait tool: block until the given product child settles, then return its final
 * answer.
 *
 * Primary signal is the activation's own settlement promise, captured by
 * `product_delegate` when it starts the child (`startActivation()` resolves to
 * `{ childId, result, dispose }`, where `result` settles exactly when the
 * activation ends). No events, no session reads.
 *
 * Why not the alternatives (measured on DSH 0.2.1-rc.2, issue #40):
 * - `ctx.on('subagent/end')` is a parent-scoped emit; a listener registered on
 *   the plugin's own context never observed it for a real child.
 * - Reading the child's session log was tried in 0.4.4 and never fired there
 *   (issue #40): `sessions.get()` serves only *live* sessions and
 *   `foldProgress()` needed `session.events`, which the real Session object does
 *   not expose. The log is readable now — through `sessionQuery`
 *   (lib/session-events.js, issue #41) — but it stays a *supplement* here
 *   (`answer` fallback, `trace`, timeout `progress`), never the wake-up signal.
 *
 * A bare `subagent/end` listener is kept as a best-effort bonus only when no
 * settlement handle exists (e.g. a child started by an earlier process).
 */
export function registerProductWait(ctx, deps) {
  const { foldProgress, foldTrace, lastAnswerFull, bindings } = deps
  ctx.tools.register(defineTool({
    name: 'product_wait',
    description: 'Block until the given product subagent finishes (or the timeout elapses), then return its final answer, stop reason, and latest trace. Attaches to a background subagent id returned by product_delegate. `detectedBy` reports which signal woke the call: "activation" (the child activation settled — the normal path), "already-settled", "event", "timeout", "aborted" or "unknown".',
    parameters: {
      subagent_id: { type: 'string', required: true, description: 'The continuable child session id returned by product_delegate.' },
      timeout_ms: { type: 'number', description: 'Max milliseconds to wait (default 300000, capped 600000).' },
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

      if (signal && signal.aborted) {
        return stripUndefined({ childId, status: 'aborted', detectedBy: 'aborted' })
      }

      // The child's log is read through sessionQuery (lib/session-events.js), so
      // a settled child still yields its events; it feeds the trace and the
      // answer fallback only, never the wake-up signal (issue #41).
      const foldNow = async () => {
        const sessionLike = { events: await loadEvents(ctx, childId) }
        return { sessionLike, fold: foldProgress(sessionLike) }
      }

      const record = bindings ? bindings.get(childId) : undefined
      const settle = record && record.settle

      let activity = 'unknown'
      try {
        const children = await ctx.subagents.listChildren(parent.session.id, signal)
        const me = findChildEntry(children, childId)
        activity = me ? me.activity : 'unknown'
      } catch {
        activity = 'unknown'
      }

      const waitForActivation = () => new Promise((resolve) => {
        let done = false
        let timer
        const cleanup = () => {
          clearTimeout(timer)
          if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort)
          }
        }
        const finish = (value) => {
          if (done) return
          done = true
          cleanup()
          resolve(value)
        }
        function onAbort() { finish({ status: 'aborted', detectedBy: 'aborted' }) }
        timer = setTimeout(() => finish({ status: 'timeout', detectedBy: 'timeout' }), timeoutMs)
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true })
        }
        settle.then(
          (terminal) => finish({ status: 'completed', detectedBy: 'activation', terminal }),
          (error) => finish({
            status: 'failed',
            detectedBy: 'activation',
            failure: error instanceof Error ? error.message : String(error),
          }),
        )
      })

      const waitForEvent = () => new Promise((resolve) => {
        let done = false
        let timer
        const off = ctx.on('subagent/end', (info) => {
          if (info && info.id === childId) finish({ status: 'completed', detectedBy: 'event', info })
        })
        const cleanup = () => {
          off()
          clearTimeout(timer)
          if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort)
          }
        }
        const finish = (value) => {
          if (done) return
          done = true
          cleanup()
          resolve(value)
        }
        function onAbort() { finish({ status: 'aborted', detectedBy: 'aborted' }) }
        timer = setTimeout(() => finish({ status: 'timeout', detectedBy: 'timeout' }), timeoutMs)
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true })
        }
      })

      let outcome
      if (activity === 'inactive') {
        outcome = { status: 'ready', detectedBy: 'already-settled' }
      } else if (settle !== undefined && typeof settle.then === 'function') {
        outcome = await waitForActivation()
      } else if (activity === 'unknown') {
        outcome = {
          status: 'unknown',
          detectedBy: 'unknown',
          note: 'no such subagent under this parent, and no settlement handle is known for it (it may have been started by an earlier process)',
        }
      } else {
        outcome = await waitForEvent()
      }

      const { sessionLike, fold } = await foldNow()

      const blocks = outcome.terminal && Array.isArray(outcome.terminal.output)
        ? outcome.terminal.output
        : (outcome.info && outcome.info.lastAssistantMessage)
      const rawAnswer = Array.isArray(blocks)
        ? blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
        : (lastAnswerFull(sessionLike) || (fold ? fold.lastAnswer : undefined))

      const stopReason = outcome.terminal
        ? outcome.terminal.stopReason
        : (outcome.info ? outcome.info.stopReason : undefined)

      // Fail-closed on the relay's final text (issue #42). A relay whose
      // `product_submit` failed used to be able to answer on its own, so a
      // completed child is not proof of a product answer: only `product_submit`
      // mints the product-session tag, and an answer without one is rejected
      // instead of being handed to the caller as the result. The rejected text
      // is never returned — passing it on would defeat the check.
      let status = outcome.status
      let failure = outcome.failure
      let answer = rawAnswer
      if (rawAnswer !== undefined) {
        const verified = verifyRelayAnswer(rawAnswer)
        if (verified.ok) {
          answer = verified.text
        } else {
          answer = undefined
          // A terminal answer that fails verification is a failed run. A
          // non-terminal status (timeout / aborted / unknown) keeps its own
          // meaning and simply withholds the unverifiable text.
          if (status === 'completed' || status === 'ready') {
            status = 'failed'
            failure = verified.failure
          }
        }
      }

      return stripUndefined({
        childId,
        status,
        detectedBy: outcome.detectedBy,
        note: outcome.note,
        failure,
        stopReason,
        answer: answer || undefined,
        pinnedProduct: (record && record.product) || (fold ? fold.product : undefined),
        remoteSessionId: (record && record.remote && (record.remote.sessionId || record.remote.threadId)) || (fold ? fold.remoteSessionId : undefined),
        progress: outcome.status === 'timeout' ? {
          activity,
          waitingOn: settle !== undefined ? 'activation' : 'event',
          lastActivityAt: fold && fold.lastActivityAt ? new Date(fold.lastActivityAt).toISOString() : undefined,
          receivedChars: fold && fold.lastAnswer ? fold.lastAnswer.length : 0,
          lastTask: fold ? fold.lastTask : undefined,
        } : undefined,
        trace: sessionLike.events.length > 0 ? foldTrace(sessionLike) : undefined,
      })
    },
  }))
}
