import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerProductWait } from '../lib/tools/product-wait.js'
import { foldProgress, foldTrace } from '../lib/progress.js'

const CHILD_ID = 'child-1'

function child(activity) {
  return { kind: 'child', id: CHILD_ID, activity, mode: 'continuable', label: 'relay', hasChildren: false }
}

function events(list) {
  return list.map((e, i) => ({ seq: i + 1, ...e }))
}

function makeHarness({ children = [child('running')], log, listChildren } = {}) {
  const handlers = new Set()
  const session = log === undefined ? undefined : { events: events(log) }
  let definition
  const ctx = {
    tools: { register: (value) => { definition = value } },
    subagents: { listChildren: listChildren || (async () => children) },
    get: (name) => (name === 'sessions' ? { get: (id) => (id === CHILD_ID ? session : undefined) } : undefined),
    on: (_event, handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
  registerProductWait(ctx, { foldProgress, foldTrace })
  return {
    tool: definition,
    handlers,
    emit(info) { for (const handler of [...handlers]) handler(info) },
  }
}

function exec(withSignal) {
  return { agent: { session: { id: 'parent-1' } }, signal: withSignal || new AbortController().signal }
}

function closedLog(now, text) {
  return [
    { type: 'turn/start', timestamp: now - 5000, payload: { turn: 1 } },
    { type: 'assistant/message', timestamp: now - 4000, payload: { message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', timestamp: now - 3000, payload: { turn: 1 } },
  ]
}

test('an event emitted before the subscription is recovered from the session log', async () => {
  const harness = makeHarness({ log: closedLog(Date.now(), 'done early') })
  harness.emit({ id: CHILD_ID, stopReason: 'end_turn' })
  const result = await harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 1000 }, exec())
  assert.equal(result.status, 'completed')
  assert.equal(result.detectedBy, 'session-log')
  assert.equal(result.answer, 'done early')
  assert.equal(harness.handlers.size, 0)
})

test('an event emitted after the subscription resolves the wait', async () => {
  const harness = makeHarness({ log: [{ type: 'turn/start', timestamp: Date.now(), payload: { turn: 1 } }] })
  const pending = harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 1000 }, exec())
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.emit({ id: CHILD_ID, stopReason: 'end_turn', lastAssistantMessage: [{ type: 'text', text: 'live answer' }] })
  const result = await pending
  assert.equal(result.status, 'completed')
  assert.equal(result.detectedBy, 'event')
  assert.equal(result.answer, 'live answer')
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(harness.handlers.size, 0)
})

test('a closed turn in the log wakes the wait when no event ever arrives', async () => {
  const harness = makeHarness({ log: closedLog(Date.now(), 'from the log') })
  const result = await harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 1000 }, exec())
  assert.equal(result.status, 'completed')
  assert.equal(result.detectedBy, 'session-log')
  assert.equal(result.answer, 'from the log')
  assert.equal(harness.handlers.size, 0)
})

test('a turn that never closes times out and reports progress', async () => {
  const now = Date.now()
  const harness = makeHarness({ log: [
    { type: 'turn/start', timestamp: now - 1000, payload: { turn: 1 } },
    { type: 'tool/call', timestamp: now - 500, payload: { name: 'product_submit', args: { task: 'slow task' } } },
  ] })
  const result = await harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 1000 }, exec())
  assert.equal(result.status, 'timeout')
  assert.equal(result.detectedBy, 'timeout')
  assert.ok(result.progress)
  assert.equal(result.progress.lastTask, 'slow task')
  assert.equal(result.progress.receivedChars, 0)
  assert.ok(result.progress.lastActivityAt)
  assert.equal(harness.handlers.size, 0)
})

test('a child that is already inactive resolves immediately', async () => {
  const harness = makeHarness({ children: [child('inactive')] })
  const result = await harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 1000 }, exec())
  assert.equal(result.status, 'ready')
  assert.equal(result.detectedBy, 'already-settled')
  assert.equal(harness.handlers.size, 0)
})

test('an already-aborted signal reports aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const harness = makeHarness()
  const result = await harness.tool.execute({ subagent_id: CHILD_ID, timeout_ms: 1000 }, exec(controller.signal))
  assert.equal(result.status, 'aborted')
  assert.equal(result.detectedBy, undefined)
  assert.equal(harness.handlers.size, 0)
})
