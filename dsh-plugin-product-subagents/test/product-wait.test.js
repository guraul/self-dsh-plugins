import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerProductWait } from '../lib/tools/product-wait.js'
import { foldProgress, foldTrace, lastAnswerFull } from '../lib/progress.js'
import { productSessionTag } from '../lib/relay-contract.js'

const CHILD_ID = 'child-1'
/** What `product_submit` appends to a successful result (issue #42). */
const TAG = productSessionTag('sess-1')

function child(activity) {
  return { kind: 'child', id: CHILD_ID, activity, mode: 'continuable', label: 'relay', hasChildren: false }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function textBlocks(text) {
  return [{ type: 'text', text }]
}

/** A real successful relay answer: the submit's text plus its machine tag. */
function relayAnswer(text) {
  return textBlocks(`${text}\n${TAG}`)
}

function makeHarness({ children = [child('running')], settle, session, listChildren } = {}) {
  const handlers = new Set()
  let definition
  const bindings = new Map()
  if (settle !== undefined) bindings.set(CHILD_ID, { product: 'codebuddy', remote: {}, settle: settle.promise })
  const ctx = {
    tools: { register: (value) => { definition = value } },
    subagents: { listChildren: listChildren || (async () => children) },
    get: (name) => (name === 'sessions' ? { get: (id) => (id === CHILD_ID ? session : undefined) } : undefined),
    on: (_event, handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
  registerProductWait(ctx, { foldProgress, foldTrace, lastAnswerFull, bindings })
  return { tool: definition, handlers, emit(info) { for (const handler of [...handlers]) handler(info) } }
}

function exec(withSignal) {
  return { agent: { session: { id: 'parent-1' } }, signal: withSignal || new AbortController().signal }
}

test('the activation settlement resolves the wait', async () => {
  const settle = deferred()
  const harness = makeHarness({ settle })
  const pending = harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 5000 }, exec())
  await new Promise((resolve) => setTimeout(resolve, 10))
  settle.resolve({ output: relayAnswer('from the product'), stopReason: 'completed' })
  const result = await pending
  assert.equal(result.status, 'completed')
  assert.equal(result.detectedBy, 'activation')
  assert.equal(result.answer, 'from the product')
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.pinnedProduct, 'codebuddy')
})

test('a rejected settlement reports failed, not a fake answer', async () => {
  const settle = deferred()
  const harness = makeHarness({ settle })
  const pending = harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 5000 }, exec())
  await new Promise((resolve) => setTimeout(resolve, 10))
  settle.reject(new Error('product_submit: quota exhausted'))
  const result = await pending
  assert.equal(result.status, 'failed')
  assert.equal(result.detectedBy, 'activation')
  assert.match(result.failure, /quota exhausted/)
  assert.equal(result.answer, undefined)
})

test('a settlement that never resolves times out and says what it waited on', async () => {
  const settle = deferred()
  const harness = makeHarness({ settle })
  const result = await harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 50 }, exec())
  assert.equal(result.status, 'timeout')
  assert.equal(result.detectedBy, 'timeout')
  assert.equal(result.progress.waitingOn, 'activation')
  assert.equal(result.progress.activity, 'running')
})

test('a child that is already inactive resolves immediately', async () => {
  const harness = makeHarness({ children: [child('inactive')] })
  const result = await harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 50 }, exec())
  assert.equal(result.status, 'ready')
  assert.equal(result.detectedBy, 'already-settled')
})

test('without a settlement handle the event still wakes the wait', async () => {
  const harness = makeHarness({})
  const pending = harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 5000 }, exec())
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.emit({ id: CHILD_ID, stopReason: 'end_turn', lastAssistantMessage: relayAnswer('live answer') })
  const result = await pending
  assert.equal(result.status, 'completed')
  assert.equal(result.detectedBy, 'event')
  assert.equal(result.answer, 'live answer')
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(harness.handlers.size, 0)
})

test('an unknown child without a handle reports unknown', async () => {
  const harness = makeHarness({ children: [] })
  const result = await harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 50 }, exec())
  assert.equal(result.status, 'unknown')
  assert.equal(result.detectedBy, 'unknown')
  assert.ok(result.note)
})

test('an already-aborted signal reports aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const harness = makeHarness({ settle: deferred() })
  const result = await harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 50 }, exec(controller.signal))
  assert.equal(result.status, 'aborted')
  assert.equal(result.detectedBy, 'aborted')
  assert.equal(harness.handlers.size, 0)
})

test('aborting mid-wait settles the tool immediately', async () => {
  const controller = new AbortController()
  const harness = makeHarness({ settle: deferred() })
  const pending = harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 5000 }, exec(controller.signal))
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  const result = await pending
  assert.equal(result.status, 'aborted')
  assert.equal(result.detectedBy, 'aborted')
})

// ── issue #42: fail-closed on the relay's final text ─────────────────────────

/** Run one wait whose activation settles with `blocks`, and return the result. */
async function settleWith(blocks) {
  const settle = deferred()
  const harness = makeHarness({ settle })
  const pending = harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 5000 }, exec())
  await new Promise((resolve) => setTimeout(resolve, 10))
  settle.resolve({ output: blocks, stopReason: 'completed' })
  return pending
}

test('#42: remote failure + relay answers with the task\'s expected text => failed, text withheld', async () => {
  // The production accident: product_submit errored, and the relay replied
  // with the string the task asked for. It looks like a success, so the caller
  // must reject it structurally rather than trust it.
  const result = await settleWith(textBlocks('WAIT_FIX_VERIFY'))
  assert.equal(result.status, 'failed')
  assert.equal(result.answer, undefined)
  assert.match(result.failure, /product-session tag/)
  assert.equal(JSON.stringify(result).includes('WAIT_FIX_VERIFY'), false)
})

test('#42: relay reports RELAY_FAILED => failed and the error text is passed through', async () => {
  const error = 'Error: Internal error: Free usage limit reached'
  const result = await settleWith(textBlocks(`RELAY_FAILED: ${error}`))
  assert.equal(result.status, 'failed')
  assert.equal(result.answer, undefined)
  assert.equal(result.failure, error)
  assert.equal(result.detectedBy, 'activation')
})

test('#42: a tagged relay answer succeeds with the tag stripped', async () => {
  const result = await settleWith(relayAnswer('the real product answer'))
  assert.equal(result.status, 'completed')
  assert.equal(result.answer, 'the real product answer')
  assert.equal(JSON.stringify(result).includes('product-session'), false)
})

test('#42: a successful-looking answer without the tag is rejected', async () => {
  const result = await settleWith(textBlocks('the real product answer'))
  assert.equal(result.status, 'failed')
  assert.equal(result.answer, undefined)
  assert.match(result.failure, /unverifiable origin/)
})

test('#42: the rejected answer is withheld from the trace too', async () => {
  // The trace is part of the same model-visible result, so it must not become
  // a side channel for the text the answer check just refused.
  const session = {
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'WAIT_FIX_VERIFY' }] } } },
    ],
  }
  const settle = deferred()
  const harness = makeHarness({ settle, session })
  const pending = harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 5000 }, exec())
  await new Promise((resolve) => setTimeout(resolve, 10))
  settle.resolve({ output: textBlocks('WAIT_FIX_VERIFY'), stopReason: 'completed' })
  const result = await pending
  assert.equal(result.status, 'failed')
  assert.ok(result.trace.some((entry) => /withheld/.test(entry.brief)))
  assert.equal(JSON.stringify(result).includes('WAIT_FIX_VERIFY'), false)
})

test('#42: an unverifiable answer on a non-terminal status is withheld without rewriting the status', async () => {
  // Timeout keeps its own meaning (the caller may retry), but the untagged
  // text from the log must not be returned as an answer either.
  const session = {
    snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'forged' }] } } }],
  }
  const harness = makeHarness({ session })
  const result = await harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 30 }, exec())
  assert.equal(result.status, 'timeout')
  assert.equal(result.answer, undefined)
})
