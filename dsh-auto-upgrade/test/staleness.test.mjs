import test from 'node:test'
import assert from 'node:assert/strict'

import { STALE_REASON, checkStaleness } from '../lib/host/staleness.js'

/** 当前事实：检测结论只有在这两个值都没变时才算新鲜。 */
const NOW = { installed: '0.2.2-alpha.2', channel: 'alpha' }

test('已装版本变了 → stale / installed-changed（升级成功后的现场）', () => {
  assert.deepEqual(
    checkStaleness({ installed: '0.2.1-rc.5', channel: 'alpha' }, NOW),
    { stale: true, staleReason: STALE_REASON.INSTALLED_CHANGED },
  )
})

test('发布渠道变了 → stale / channel-changed（换渠道后缓存失效）', () => {
  assert.deepEqual(
    checkStaleness({ installed: '0.2.2-alpha.2', channel: 'latest' }, NOW),
    { stale: true, staleReason: STALE_REASON.CHANNEL_CHANGED },
  )
})

test('两项都变 → 优先报 installed-changed', () => {
  assert.deepEqual(
    checkStaleness({ installed: '0.2.1-rc.5', channel: 'latest' }, NOW),
    { stale: true, staleReason: STALE_REASON.INSTALLED_CHANGED },
  )
})

test('两项都一致 → 不 stale', () => {
  assert.deepEqual(
    checkStaleness({ installed: '0.2.2-alpha.2', channel: 'alpha' }, NOW),
    { stale: false, staleReason: null },
  )
})

test('没有上次结论 → 不 stale（没有「过期结论」这回事）', () => {
  assert.deepEqual(checkStaleness(null, NOW), { stale: false, staleReason: null })
  assert.deepEqual(checkStaleness(undefined, NOW), { stale: false, staleReason: null })
})

test('实时已装版本取不到时不做已装版本比较（不虚报过期）', () => {
  assert.deepEqual(
    checkStaleness({ installed: '0.2.2-alpha.2', channel: 'alpha' }, { installed: null, channel: 'alpha' }),
    { stale: false, staleReason: null },
  )
})

test('缓存缺 installed 字段 → 前提无法确认，按 installed-changed 判过期', () => {
  assert.deepEqual(
    checkStaleness({ channel: 'alpha' }, NOW),
    { stale: true, staleReason: STALE_REASON.INSTALLED_CHANGED },
  )
})
