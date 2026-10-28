import test from 'node:test'
import assert from 'node:assert/strict'

import { createCache, TTL } from '../lib/host/cache.js'
import { createClock } from './helpers.mjs'

test('TTL 内命中，过期后 get 不返回但 peek 仍可读', () => {
  const clock = createClock()
  const cache = createCache({ now: clock.now })
  cache.set('hot:30', { items: [] }, 1000)

  assert.deepEqual(cache.get('hot:30'), { at: clock.now(), payload: { items: [] } })
  clock.advance(999)
  assert.notEqual(cache.get('hot:30'), undefined)
  clock.advance(1)
  assert.equal(cache.get('hot:30'), undefined)
  assert.deepEqual(cache.peek('hot:30')?.payload, { items: [] })
})

test('invalidate 单键与全部', () => {
  const cache = createCache()
  cache.set('a', 1, 1000)
  cache.set('b', 2, 1000)
  cache.invalidate('a')
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b')?.payload, 2)
  cache.invalidate()
  assert.equal(cache.size(), 0)
})

test('set 可指定写入时刻，便于断言 fetchedAt', () => {
  const clock = createClock(4500)
  const cache = createCache({ now: clock.now })
  cache.set('k', 'v', 1000, 4000)
  assert.equal(cache.get('k')?.at, 4000)
  clock.set(5000)
  assert.equal(cache.get('k'), undefined)
})

test('TTL 表覆盖四种能力', () => {
  assert.equal(TTL.hot, 5 * 60 * 1000)
  assert.equal(TTL.search, 2 * 60 * 1000)
  assert.equal(TTL.contents, 10 * 60 * 1000)
  assert.equal(TTL.capabilities, 24 * 60 * 60 * 1000)
})
