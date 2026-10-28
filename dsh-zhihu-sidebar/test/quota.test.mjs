import test from 'node:test'
import assert from 'node:assert/strict'

import { createQuotaGuard, DEFAULT_DAILY_LIMITS, extractQuota } from '../lib/host/quota.js'
import { createClock } from './helpers.mjs'

test('本地每日上限耗尽后拒绝，且跨天自动清零', () => {
  const clock = createClock(new Date(2026, 9, 28, 10, 0, 0).getTime())
  const quota = createQuotaGuard({ now: clock.now, limits: { hot: 2 } })

  assert.deepEqual(quota.check('hot'), { ok: true })
  quota.spend('hot')
  quota.spend('hot')
  const gate = quota.check('hot')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_exhausted')
  assert.equal(gate.source, 'local')
  assert.equal(gate.used, 2)

  clock.advance(24 * 60 * 60 * 1000)
  assert.deepEqual(quota.check('hot'), { ok: true })
  assert.equal(quota.snapshot().used.hot, undefined)
})

test('服务端剩余额度为 0 时直接降级', () => {
  const quota = createQuotaGuard({ limits: { hot: 80 } })
  quota.applyRemote({ hot: { remaining: 0, total: 100 } })
  const gate = quota.check('hot')
  assert.equal(gate.ok, false)
  assert.equal(gate.source, 'remote')
  assert.equal(gate.remaining, 0)
})

test('spend 同时扣本地与服务端快照', () => {
  const quota = createQuotaGuard({ limits: { hot: 80 } })
  quota.applyRemote({ hot: { remaining: 3, total: 100 } })
  quota.spend('hot')
  assert.equal(quota.snapshot().remote.hot.remaining, 2)
  assert.equal(quota.snapshot().used.hot, 1)
  quota.spend('hot')
  quota.spend('hot')
  assert.equal(quota.check('hot').reason, 'quota_exhausted')
})

test('刷新节奏：首次要刷，30 分钟内不刷，之后要刷', () => {
  const clock = createClock()
  const quota = createQuotaGuard({ now: clock.now })
  assert.equal(quota.shouldRefresh(), true)
  quota.markRefreshed()
  assert.equal(quota.shouldRefresh(), false)
  clock.advance(29 * 60 * 1000)
  assert.equal(quota.shouldRefresh(), false)
  clock.advance(60 * 1000)
  assert.equal(quota.shouldRefresh(), true)
})

test('beginRefresh 防止并发重复查额度', () => {
  const quota = createQuotaGuard()
  assert.equal(quota.beginRefresh(), true)
  assert.equal(quota.beginRefresh(), false)
  quota.markRefreshed()
  assert.equal(quota.beginRefresh(), true)
})

test('requestRefresh 只置标记，不立即调用', () => {
  const quota = createQuotaGuard({ now: () => 1_700_000_000_000 })
  quota.markRefreshed()
  assert.equal(quota.shouldRefresh(), false)
  quota.requestRefresh()
  assert.equal(quota.shouldRefresh(), true)
  assert.equal(quota.snapshot().refreshDue, true)
})

test('extractQuota 递归识别 APIID 与 RemainingQuota', () => {
  const snapshot = extractQuota({
    ApiQuotaList: [
      { APIID: 'hot_list', TotalQuota: 100, RemainingQuota: 90 },
      { APIID: 'zhihu_search', RemainingQuota: 5000 },
      { APIID: 'user_data', RemainingQuota: 10000 },
      { nope: true },
    ],
  })
  assert.deepEqual(snapshot.hot, { remaining: 90, total: 100 })
  assert.deepEqual(snapshot.search, { remaining: 5000, total: null })
  assert.deepEqual(snapshot.contents, { remaining: 10000, total: null })
})

test('extractQuota 识别真实 quota 响应形状（Data 数组 / APIID / APIName）', () => {
  const response = {
    Code: 0,
    Message: 'success',
    Data: [
      { APIID: 'hot_list', APIName: '热榜', TotalQuota: 100, TotalUsed: 0, RemainingQuota: 100 },
      { APIID: 'zhihu_search', APIName: '搜索', TotalQuota: 5000, TotalUsed: 12, RemainingQuota: 4988 },
      { APIID: 'user_data', APIName: '用户数据', TotalQuota: 10000, TotalUsed: 3, RemainingQuota: 9997 },
    ],
  }
  const snapshot = extractQuota(response)
  assert.deepEqual(snapshot.hot, { remaining: 100, total: 100 })
  assert.deepEqual(snapshot.search, { remaining: 4988, total: 5000 })
  assert.deepEqual(snapshot.contents, { remaining: 9997, total: 10000 })
  assert.deepEqual(extractQuota(response.Data), snapshot)
})

test('extractQuota 兼容小写 / 驼峰写法', () => {
  const snapshot = extractQuota({
    list: [
      { ApiId: 'hot_list', TotalQuota: 100, RemainingQuota: 7 },
      { api_id: 'zhihu_search', remaining_quota: 8 },
      { apiId: 'user_data', remaining: 9 },
    ],
  })
  assert.deepEqual(snapshot.hot, { remaining: 7, total: 100 })
  assert.deepEqual(snapshot.search, { remaining: 8, total: null })
  assert.deepEqual(snapshot.contents, { remaining: 9, total: null })
})

test('extractQuota 认不出来时返回空表而不是假额度', () => {
  assert.deepEqual(extractQuota({ Weird: true }), {})
  assert.deepEqual(extractQuota(undefined), {})
  assert.deepEqual(extractQuota({ Items: [{ APIID: 'hot_list' }] }), {})
})

test('默认上限低于真实额度，留余量', () => {
  assert.equal(DEFAULT_DAILY_LIMITS.hot, 80)
  assert.ok(DEFAULT_DAILY_LIMITS.search < 5000)
  assert.ok(DEFAULT_DAILY_LIMITS.contents < 10000)
  assert.equal(DEFAULT_DAILY_LIMITS.capabilities, 0)
})
