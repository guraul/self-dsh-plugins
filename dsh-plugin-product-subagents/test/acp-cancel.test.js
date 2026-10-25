import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAcpBridge } from '../lib/bridges/acp.js'

/**
 * Stopping a relay child must stop the REMOTE turn (issue #12).
 *
 * `product_submit` runs inside the relay child's turn, so its `exec.signal`
 * aborts when the child is interrupted (`agent.cancel()` → the loop's phase
 * abort). The ACP bridge used to drop that signal: `prompt()` stayed open until
 * the agent answered on its own, and killing the client was not enough because
 * a v2 agent runs the turn in a resident backend. The bridge now translates the
 * abort into `session/cancel`.
 *
 * The fake remote carries only the surface `submit()`/`dispose()` touch, so no
 * ACP process is spawned and no product CLI is needed.
 */
function fakeRemote({ prompt, cancel }) {
  return {
    kind: 'acp',
    sessionId: 'ses_0123456789',
    connection: {
      prompt,
      cancel,
      setSessionConfigOption: async () => {},
      closeSession: async () => {},
    },
    proc: { exitCode: null, signalCode: null, kill() {} },
    drainText: () => 'partial answer',
  }
}

/** A prompt that stays open until the test settles it. */
function pendingPrompt() {
  const box = { settle: undefined, reject: undefined, calls: [] }
  box.prompt = (params) => {
    box.calls.push(params)
    return new Promise((resolve, reject) => {
      box.settle = resolve
      box.reject = reject
    })
  }
  return box
}

test('interrupting the child sends session/cancel to the remote turn', async () => {
  const controller = new AbortController()
  const cancels = []
  const prompt = pendingPrompt()
  const remote = fakeRemote({
    prompt: prompt.prompt,
    cancel: (params) => {
      cancels.push(params)
      queueMicrotask(() => prompt.settle({ stopReason: 'cancelled' }))
    },
  })
  const bridge = createAcpBridge({ warn: () => {} })

  const running = bridge.submit(remote, 'long task', controller.signal, '/tmp')
  // the listener is attached before the prompt starts, so an immediate abort is
  // the same edge as a stop arriving mid-turn
  controller.abort({ kind: 'parent' })
  const out = await running

  assert.deepEqual(cancels, [{ sessionId: 'ses_0123456789' }])
  assert.equal(prompt.calls.length, 1)
  assert.equal(out.stopReason, 'cancelled')
  assert.equal(out.text, 'partial answer')
})

test('an already-aborted signal cancels before the turn is awaited', async () => {
  const cancels = []
  const prompt = pendingPrompt()
  const remote = fakeRemote({
    prompt: (params) => {
      setTimeout(() => prompt.settle({ stopReason: 'end_turn' }), 0)
      return prompt.prompt(params)
    },
    cancel: (params) => { cancels.push(params) },
  })
  const bridge = createAcpBridge({ warn: () => {} })
  const controller = new AbortController()
  controller.abort({ kind: 'disposed' })

  const out = await bridge.submit(remote, 'task', controller.signal, '/tmp')

  assert.equal(cancels.length, 1)
  assert.equal(out.stopReason, 'completed')
})

test('a failing session/cancel only warns — the turn still resolves', async () => {
  const warnings = []
  const prompt = pendingPrompt()
  const remote = fakeRemote({
    prompt: prompt.prompt,
    cancel: () => Promise.reject(new Error('method not found')),
  })
  const bridge = createAcpBridge({ warn: (text) => warnings.push(text) })
  const controller = new AbortController()

  const running = bridge.submit(remote, 'task', controller.signal, '/tmp')
  controller.abort({ kind: 'parent' })
  setImmediate(() => prompt.settle({ stopReason: 'cancelled' }))
  const out = await running

  assert.equal(out.stopReason, 'cancelled')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /session\/cancel failed: method not found/)
})

test('a session/cancel that throws synchronously also only warns', async () => {
  const warnings = []
  const prompt = pendingPrompt()
  const remote = fakeRemote({
    prompt: prompt.prompt,
    cancel: () => { throw new Error('connection closed') },
  })
  const bridge = createAcpBridge({ warn: (text) => warnings.push(text) })
  const controller = new AbortController()

  const running = bridge.submit(remote, 'task', controller.signal, '/tmp')
  controller.abort({ kind: 'parent' })
  prompt.settle({ stopReason: 'cancelled' })

  await running
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /connection closed/)
})

test('a completed turn is not cancelled retroactively', async () => {
  const cancels = []
  const remote = fakeRemote({
    prompt: async () => ({ stopReason: 'end_turn' }),
    cancel: (params) => { cancels.push(params) },
  })
  const bridge = createAcpBridge({ warn: () => {} })
  const controller = new AbortController()

  await bridge.submit(remote, 'task', controller.signal, '/tmp')
  controller.abort({ kind: 'user' })

  assert.deepEqual(cancels, [])
})

test('dispose cancels a still-running turn before closing the session', async () => {
  const order = []
  const remote = fakeRemote({
    prompt: pendingPrompt().prompt,
    cancel: () => { order.push('cancel') },
  })
  remote.connection.closeSession = async () => { order.push('closeSession') }
  remote.proc.kill = () => { order.push('kill') }
  const bridge = createAcpBridge({ warn: () => {} })

  await bridge.dispose(remote)

  assert.deepEqual(order, ['cancel', 'closeSession', 'kill'])
})
