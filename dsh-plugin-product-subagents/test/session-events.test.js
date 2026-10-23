import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadEvents } from '../lib/session-events.js'

const ID = 'child-1'

function realEvents() {
  return [
    { type: 'turn/start', seq: 0, time: 1792749439000, data: { turn: 1 } },
    {
      type: 'tool/call',
      seq: 1,
      time: 1792749439100,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'product_submit', arguments: '{"task":"do thing"}' },
    },
    {
      type: 'tool/result',
      seq: 2,
      time: 1792749439103,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'result-1', role: 'tool', content: [{ type: 'text', text: 'PRODUCT_SESSION:acp:sess-123' }] },
      },
    },
  ]
}

function ctxWith(services) {
  return { get: (name) => services[name] }
}

test('listEvents records carrying data are normalized to payload + timestamp', async () => {
  const query = { listEvents: async (id) => (id === ID ? realEvents() : []) }
  const events = await loadEvents(ctxWith({ sessionQuery: query }), ID)
  assert.equal(events.length, 3)
  assert.deepEqual(events[1].payload, realEvents()[1].data)
  assert.equal(events[1].timestamp, realEvents()[1].time)
  assert.equal(events[1].type, 'tool/call')
  assert.deepEqual(events[1].data, realEvents()[1].data)
})

test('readSession is preferred when the service exposes it', async () => {
  let listed = false
  const query = {
    readSession: async () => ({ events: realEvents() }),
    listEvents: async () => {
      listed = true
      return []
    },
  }
  const events = await loadEvents(ctxWith({ sessionQuery: query }), ID)
  assert.equal(events.length, 3)
  assert.equal(listed, false)
})

test('without sessionQuery it falls back to the live session snapshotEvents()', async () => {
  const session = { snapshotEvents: () => realEvents() }
  const events = await loadEvents(ctxWith({ sessions: { get: (id) => (id === ID ? session : undefined) } }), ID)
  assert.equal(events.length, 3)
  assert.deepEqual(events[2].payload, realEvents()[2].data)
})

test('a throwing sessionQuery degrades to [] and never throws', async () => {
  const warnings = []
  const query = { listEvents: async () => { throw new Error('SESSION_QUERY_NOT_FOUND') } }
  const ctx = { get: (name) => (name === 'sessionQuery' ? query : undefined), logger: { warn: (text) => warnings.push(text) } }
  const events = await loadEvents(ctx, ID)
  assert.deepEqual(events, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /SESSION_QUERY_NOT_FOUND/)
})

test('a hanging sessionQuery times out to [] and never throws', async () => {
  const query = { listEvents: () => new Promise(() => {}) }
  const events = await loadEvents(ctxWith({ sessionQuery: query }), ID, { timeoutMs: 20 })
  assert.deepEqual(events, [])
})

test('a throwing live snapshot degrades to []', async () => {
  const session = { snapshotEvents: () => { throw new Error('settled') } }
  const events = await loadEvents(ctxWith({ sessions: { get: () => session } }), ID)
  assert.deepEqual(events, [])
})

test('no service, no id, or an array passed directly', async () => {
  assert.deepEqual(await loadEvents({ get: () => undefined }, ID), [])
  assert.deepEqual(await loadEvents({ get: () => undefined }, ''), [])
  assert.deepEqual(await loadEvents(undefined, ID), [])
  const direct = await loadEvents({}, { events: realEvents() })
  assert.equal(direct.length, 3)
  assert.equal(direct[0].payload.turn, 1)
})
