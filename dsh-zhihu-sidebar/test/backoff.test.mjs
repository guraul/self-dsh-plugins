import test from 'node:test'
import assert from 'node:assert/strict'

import { createBackoff } from '../lib/host/backoff.js'
import { createClock } from './helpers.mjs'

test('冷却从 30s 起，指数翻倍，封顶 5 分钟', () => {
  const clock = createClock()
  const backoff = createBackoff({ now: clock.now })

  assert.equal(backoff.fail('hot').delayMs, 30_000)
  assert.equal(backoff.isCooling('hot'), true)
  assert.equal(backoff.remaining('hot'), 30_000)

  clock.advance(29_999)
  assert.equal(backoff.isCooling('hot'), true)
  clock.advance(1)
  assert.equal(backoff.isCooling('hot'), false)

  assert.equal(backoff.fail('hot').delayMs, 60_000)
  assert.equal(backoff.fail('hot').delayMs, 120_000)
  assert.equal(backoff.fail('hot').delayMs, 240_000)
  assert.equal(backoff.fail('hot').delayMs, 300_000)
  assert.equal(backoff.fail('hot').delayMs, 300_000)
  assert.equal(backoff.failures('hot'), 6)
})

test('成功一次复位', () => {
  const clock = createClock()
  const backoff = createBackoff({ now: clock.now })
  backoff.fail('hot')
  backoff.fail('hot')
  backoff.succeed('hot')
  assert.equal(backoff.isCooling('hot'), false)
  assert.equal(backoff.failures('hot'), 0)
  clock.advance(1000)
  assert.equal(backoff.fail('hot').delayMs, 30_000)
})

test('能力之间互不影响', () => {
  const clock = createClock()
  const backoff = createBackoff({ now: clock.now })
  backoff.fail('hot')
  assert.equal(backoff.isCooling('search'), false)
  assert.equal(backoff.remaining('search'), 0)
  assert.deepEqual(Object.keys(backoff.snapshot()), ['hot'])
})

test('注入的时钟决定冷却边界，不依赖真实时间', () => {
  const clock = createClock(0)
  const backoff = createBackoff({ now: clock.now, baseMs: 1000, factor: 2, maxMs: 3000 })
  backoff.fail('k')
  clock.set(999)
  assert.equal(backoff.isCooling('k'), true)
  clock.set(1000)
  assert.equal(backoff.isCooling('k'), false)
})
