import test from 'node:test'
import assert from 'node:assert/strict'

import { createQueue } from '../lib/host/queue.js'
import { fakeRuntime } from './helpers.mjs'

test('同键并发只执行一次，复用同一个 Promise', async () => {
  const queue = createQueue()
  let calls = 0
  const task = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return calls
  }

  const [a, b] = await Promise.all([queue.run('hot:30', task), queue.run('hot:30', task)])
  assert.equal(calls, 1)
  assert.equal(a, 1)
  assert.equal(b, 1)
  assert.equal(queue.stats().deduped, 1)
})

test('不同键仍然串行', async () => {
  const queue = createQueue()
  const order = []
  const task = (name, ms) => async () => {
    order.push(`start:${name}`)
    await new Promise((resolve) => setTimeout(resolve, ms))
    order.push(`end:${name}`)
    return name
  }

  const results = await Promise.all([
    queue.run('a', task('a', 20)),
    queue.run('b', task('b', 5)),
    queue.run('c', task('c', 1)),
  ])
  assert.deepEqual(results, ['a', 'b', 'c'])
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  assert.equal(queue.stats().peak, 1)
})

test('任务失败不会卡死队列，也不会污染后续任务', async () => {
  const queue = createQueue()
  await assert.rejects(queue.run('bad', async () => Promise.reject(new Error('boom'))), /boom/)
  assert.equal(await queue.run('good', async () => 'ok'), 'ok')
  assert.equal(queue.stats().active, 0)
})

test('同键失败时后续调用可以重新执行', async () => {
  const queue = createQueue()
  let calls = 0
  const failing = async () => {
    calls += 1
    throw new Error('first')
  }
  await assert.rejects(queue.run('k', failing), /first/)
  assert.equal(await queue.run('k', async () => { calls += 1; return calls }), 2)
})

test('key 为 null 时不去重', async () => {
  const queue = createQueue()
  let calls = 0
  const task = async () => {
    calls += 1
    return calls
  }
  await Promise.all([queue.run(null, task), queue.run(null, task)])
  assert.equal(calls, 2)
  assert.equal(queue.stats().deduped, 0)
})

test('真实子进程：并发调用不同键时同一时刻只有一个在跑', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'], delayMs: 40 })
  t.after(() => runtime.cleanup())
  const queue = createQueue()

  await Promise.all(
    ['hot', 'search', 'contents', 'quota'].map((key) => queue.run(key, () => runtime.cli.run(['hot']))),
  )

  const events = runtime.events()
  assert.equal(events.length, 8)
  const shape = events.map((event) => event.event)
  assert.deepEqual(shape, ['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end'])
  assert.equal(events.filter((event) => event.overlap === true).length, 0)
  assert.equal(queue.stats().peak, 1)
})

test('真实子进程：同键并发只起一个进程', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'], delayMs: 40 })
  t.after(() => runtime.cleanup())
  const queue = createQueue()

  const [a, b] = await Promise.all([
    queue.run('hot:30', () => runtime.cli.run(['hot', '--limit', '30'])),
    queue.run('hot:30', () => runtime.cli.run(['hot', '--limit', '30'])),
  ])

  assert.equal(runtime.starts().length, 1)
  assert.equal(a.stdout, b.stdout)
  assert.equal(queue.stats().deduped, 1)
})
