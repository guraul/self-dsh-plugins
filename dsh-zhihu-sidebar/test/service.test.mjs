import test from 'node:test'
import assert from 'node:assert/strict'

import { createQuotaGuard } from '../lib/host/quota.js'
import { createService } from '../lib/host/service.js'
import { createClock, fakeRuntime } from './helpers.mjs'

function setup(t, { modes = ['success'], delayMs = 0, limits } = {}) {
  const clock = createClock()
  const runtime = fakeRuntime({ modes, delayMs })
  t.after(() => runtime.cleanup())
  const service = createService({
    cli: runtime.cli,
    now: clock.now,
    quota:
      limits === undefined
        ? createQuotaGuard({ now: clock.now })
        : createQuotaGuard({ now: clock.now, limits }),
  })
  const starts = (name) => {
    const prefix = name === 'contents' ? 'me' : name
    return runtime.starts().filter((event) => event.args[0] === prefix)
  }
  return { clock, runtime, service, starts }
}

test('热榜：成功 → 规范化 → TTL 内命中缓存不再起进程', async (t) => {
  const { service, starts } = setup(t)
  service.internals().quota.markRefreshed()

  const first = await service.hot(2)
  assert.equal(first.ok, true)
  assert.equal(first.cached, false)
  assert.equal(first.data.items.length, 3)
  assert.deepEqual(starts('hot')[0].args, ['hot', '--limit', '2'])

  const second = await service.hot(2)
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.equal(starts('hot').length, 1)
})

test('热榜：条数越界被夹到 1–30', async (t) => {
  const { service, starts } = setup(t)
  service.internals().quota.markRefreshed()

  await service.hot(99)
  await service.hot(0)
  const args = starts('hot').map((event) => event.args[2])
  assert.deepEqual(args, ['30', '1'])
})

test('退出码 3 → auth_required，并透出 action_url', async (t) => {
  const { service } = setup(t, { modes: ['auth_required'] })
  service.internals().quota.markRefreshed()

  const result = await service.hot(5)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'auth_required')
  assert.equal(result.actionUrl, 'https://developer.zhihu.com/profile')
})

test('退出码 4 → 冷却期，后续请求不再起进程', async (t) => {
  const { service, starts } = setup(t, { modes: ['rate_limited'] })
  service.internals().quota.markRefreshed()

  const first = await service.hot(30)
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'rate_limited')
  assert.equal(first.retryAfterMs, 30_000)

  const calls = starts('hot').length
  const second = await service.hot(30)
  assert.equal(second.reason, 'rate_limited')
  assert.equal(starts('hot').length, calls)
})

test('业务码 30001（HTTP 200 里的限流）同样触发冷却', async (t) => {
  const { service, starts } = setup(t, { modes: ['business_rate_limited'] })
  service.internals().quota.markRefreshed()

  const first = await service.hot(30)
  assert.equal(first.reason, 'rate_limited')
  await service.hot(30)
  assert.equal(starts('hot').length, 1)
})

test('冷却期有旧数据 → 返回 stale 而不是失败', async (t) => {
  const { clock, runtime, service, starts } = setup(t)
  service.internals().quota.markRefreshed()

  const fresh = await service.hot(30)
  assert.equal(fresh.ok, true)

  runtime.setModes(['rate_limited'])
  clock.advance(6 * 60 * 1000)

  const failing = await service.hot(30)
  assert.equal(failing.ok, true)
  assert.equal(failing.stale, true)
  assert.equal(failing.reason, 'rate_limited')
  assert.equal(failing.data.items.length, 3)

  const again = await service.hot(30)
  assert.equal(again.stale, true)
  assert.equal(starts('hot').length, 2)
})

test('本地每日额度耗尽 → quota_exhausted，不发请求', async (t) => {
  const { service, starts } = setup(t, { limits: { hot: 1, search: 0, contents: 0, capabilities: 0 } })
  service.internals().quota.markRefreshed()

  assert.equal((await service.hot(1)).ok, true)
  const blocked = await service.hot(2)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'quota_exhausted')
  assert.equal(blocked.quota.source, 'local')
  assert.equal(starts('hot').length, 1)
})

test('服务端额度为 0 → 直接降级', async (t) => {
  const { service, starts } = setup(t)
  service.internals().quota.markRefreshed()
  service.internals().quota.applyRemote({ hot: { remaining: 0, total: 100 } })

  const result = await service.hot(10)
  assert.equal(result.reason, 'quota_exhausted')
  assert.equal(result.quota.source, 'remote')
  assert.equal(starts('hot').length, 0)
})

test('额度刷新低频：30 分钟内只查一次 quota', async (t) => {
  const { service, starts } = setup(t)

  assert.equal((await service.hot(1)).ok, true)
  assert.equal(starts('quota').length, 1)
  assert.equal((await service.hot(2)).ok, true)
  assert.equal(starts('quota').length, 1)
})

test('额度刷新发现 remaining 0 → 不发数据请求', async (t) => {
  const { service, starts } = setup(t, { modes: ['quota_zero'] })

  const result = await service.hot(10)
  assert.equal(result.reason, 'quota_exhausted')
  assert.equal(result.quota.source, 'remote')
  assert.equal(starts('hot').length, 0)
})

test('搜索：空关键词直接拒绝；同关键词命中缓存', async (t) => {
  const { service, starts } = setup(t)
  service.internals().quota.markRefreshed()

  const empty = await service.search('   ')
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'invalid_argument')
  assert.equal(starts('search').length, 0)

  const first = await service.search('AI Agent', 5)
  assert.equal(first.ok, true)
  assert.equal(first.data.items.length, 2)
  assert.deepEqual(starts('search')[0].args, ['search', 'zhihu', '--query', 'AI Agent', '--count', '5'])
  assert.equal(first.data.items[0].author, '作者甲')

  const second = await service.search('AI Agent', 5)
  assert.equal(second.cached, true)
  assert.equal(starts('search').length, 1)
})

test('我的创作：走 me contents 并规范化', async (t) => {
  const { service, starts } = setup(t)
  service.internals().quota.markRefreshed()

  const result = await service.contents(20)
  assert.equal(result.ok, true)
  assert.deepEqual(starts('contents')[0].args, ['me', 'contents', '--limit', '20'])
  assert.equal(result.data.items[0].type, 'answer')
})

test('能力清单：免额度、24h 缓存、不触发 quota 查询', async (t) => {
  const { service, starts } = setup(t)

  const first = await service.capabilities()
  assert.equal(first.ok, true)
  assert.equal(first.data.version, '0.6.1')
  assert.equal(first.data.commands[0].limit.max, 30)
  assert.equal(starts('capabilities').length, 1)
  assert.equal(starts('quota').length, 0)

  const second = await service.capabilities()
  assert.equal(second.cached, true)
  assert.equal(starts('capabilities').length, 1)
})

test('限流按能力隔离：热榜冷却不影响搜索', async (t) => {
  const { service, starts } = setup(t, { modes: ['rate_limited', 'success'] })
  service.internals().quota.markRefreshed()

  assert.equal((await service.hot(10)).reason, 'rate_limited')
  const search = await service.search('x', 3)
  assert.equal(search.ok, true)
  assert.equal(starts('search').length, 1)
})

test('status 暴露队列 / 缓存 / 冷却 / 额度', async (t) => {
  const { service } = setup(t)
  service.internals().quota.markRefreshed()
  await service.hot(3)

  const status = service.status()
  assert.equal(status.ok, true)
  assert.equal(status.queue.started, 1)
  assert.equal(status.cacheSize, 1)
  assert.equal(status.quota.used.hot, 1)
  assert.equal(typeof status.cli, 'string')
})
