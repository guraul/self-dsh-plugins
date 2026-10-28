import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { API } from '../lib/host/http.js'
import { fakeClientContext, loadClientBundle, translator } from './client-harness.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const { id, exports, react } = loadClientBundle()
const client = exports.__internals

test('浏览器半边以包名注册模块，并导出 apply / inject', () => {
  assert.equal(id, 'dsh-plugin-zhihu-sidebar')
  assert.equal(id, pkg.name)
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote'])
})

test('package.json 的客户端 inject 是包名，且不含不存在的 slots 包', () => {
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
  ])
  assert.equal(
    pkg.dsh.client.inject.some((name) => name.includes('dsh-client-ui-slots')),
    false,
  )
})

test('两段式注册：tab 类型与正文用同一个 id 作键', () => {
  const { ctx, calls } = fakeClientContext()
  exports.apply(ctx)

  assert.deepEqual(calls.effects, ['zhihu: dictionaries', 'zhihu: type', 'zhihu: body'])
  assert.equal(calls.dictionaries.length, 1)
  assert.equal(calls.dictionaries[0].namespace, client.NS)
  assert.equal(calls.bound, client.NS)

  assert.equal(calls.tabs.length, 1)
  const definition = calls.tabs[0]
  assert.equal(definition.id, client.TAB_ID)
  assert.equal(definition.kind, 'zhihu')
  assert.equal(definition.priority, 'extension')

  assert.deepEqual(calls.slotInjections, ['sidebar.right.pane.tab'])
  assert.equal(calls.slots.length, 1)
  assert.equal(calls.slots[0].definition.name, 'sidebar.right.pane.tab')
  assert.equal(calls.slots[0].definition.key, definition.id)
  assert.equal(calls.slots[0].definition.locale, client.NS)
  assert.equal(calls.slots[0].component, client.ZhihuTabBody)
})

test('引导页只有一张卡片，点它按 kind 打开一个 tab（不是三个）', () => {
  const { ctx, calls } = fakeClientContext()
  exports.apply(ctx)
  const definition = calls.tabs[0]

  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].id, 'zhihu')
  assert.equal(definition.guide[0].order, 120)
  assert.equal(typeof definition.guide[0].title, 'function')
  assert.equal(typeof definition.guide[0].description, 'function')
  assert.deepEqual(client.VIEWS, ['hot', 'search', 'contents'])
})

test('标题与引导文案是 thunk：换语言后重新读，不需要重新注册', () => {
  let language = 'zh'
  const translate = (key) => `${language}:${key}`
  const { ctx, calls } = fakeClientContext({ translate })
  exports.apply(ctx)
  const definition = calls.tabs[0]

  assert.equal(definition.title(), 'zh:tab.title')
  assert.equal(definition.guide[0].title(), 'zh:guide.title')
  language = 'en'
  assert.equal(definition.title(), 'en:tab.title')
  assert.equal(definition.guide[0].description(), 'en:guide.description')
  assert.equal(calls.tabs.length, 1)
})

test('取数路径与宿主 API 常量逐条一致', () => {
  assert.equal(client.ROUTES.hot, API.hot.slice(1))
  assert.equal(client.ROUTES.search, API.search.slice(1))
  assert.equal(client.ROUTES.contents, API.contents.slice(1))
  assert.equal(client.ROUTES.hot.startsWith('/'), false)
})

test('请求 URL：默认条数、空值跳过、关键词编码', () => {
  assert.deepEqual(client.hotRequest(), { view: 'hot', url: 'api/dsh-zhihu-sidebar/hot?limit=30' })
  assert.equal(client.hotRequest(5).url, 'api/dsh-zhihu-sidebar/hot?limit=5')
  assert.deepEqual(client.contentsRequest(), {
    view: 'contents',
    url: 'api/dsh-zhihu-sidebar/contents?limit=20',
  })
  assert.equal(client.searchRequest('  AI Agent  ').url, 'api/dsh-zhihu-sidebar/search?q=AI%20Agent&count=10')
  assert.equal(client.searchRequest('   ').url, 'api/dsh-zhihu-sidebar/search?count=10')
  assert.equal(client.searchRequest('a&b').query, 'a&b')
  assert.equal(client.withQuery('x', { a: undefined, b: null, c: '', d: 0 }), 'x?d=0')
})

test('子视图切换：只有三个，未知值落回暖榜', () => {
  assert.equal(client.normalizeView('search'), 'search')
  assert.equal(client.normalizeView('contents'), 'contents')
  assert.equal(client.normalizeView('hot'), 'hot')
  assert.equal(client.normalizeView('settings'), 'hot')
  assert.equal(client.normalizeView(undefined), 'hot')
  assert.equal(client.normalizeView(null), 'hot')
  assert.equal(client.DEFAULT_VIEW, 'hot')
})

test('readResult：成功保留 stale / cached / fetchedAt', () => {
  const fresh = client.readResult({ ok: true, cached: false, fetchedAt: 1761000000000, data: { items: [] } })
  assert.equal(fresh.kind, 'ok')
  assert.equal(fresh.cached, false)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.fetchedAt, 1761000000000)
  assert.deepEqual(fresh.data, { items: [] })

  const cached = client.readResult({ ok: true, cached: true, fetchedAt: 1, data: { items: [] } })
  assert.equal(cached.cached, true)

  const stale = client.readResult({
    ok: true,
    stale: true,
    reason: 'rate_limited',
    retryAfterMs: 120000,
    fetchedAt: 1,
    data: { items: [] },
  })
  assert.equal(stale.kind, 'ok')
  assert.equal(stale.stale, true)
  assert.equal(stale.retryAfterMs, 120000)
})

test('readResult：auth_required 给申请入口，其它原因不给', () => {
  const withUrl = client.readResult({ ok: false, reason: 'auth_required', actionUrl: 'https://example.test/key' })
  assert.equal(withUrl.kind, 'auth')
  assert.equal(withUrl.actionUrl, 'https://example.test/key')

  const withoutUrl = client.readResult({ ok: false, reason: 'auth_required' })
  assert.equal(withoutUrl.actionUrl, client.AUTH_CONSOLE_URL)

  const other = client.readResult({ ok: false, reason: 'invalid_argument', actionUrl: 'https://example.test/key' })
  assert.equal(other.actionUrl, null)
})

test('readResult：rate_limited 带冷却，quota_exhausted 带剩余额度', () => {
  const rate = client.readResult({ ok: false, reason: 'rate_limited', retryAfterMs: 45000 })
  assert.equal(rate.kind, 'rate')
  assert.equal(rate.retryAfterMs, 45000)

  const quota = client.readResult({
    ok: false,
    reason: 'quota_exhausted',
    quota: { source: 'server', limit: 100, used: 100, remaining: 0 },
  })
  assert.equal(quota.kind, 'quota')
  assert.equal(quota.remaining, 0)

  const unknownQuota = client.readResult({ ok: false, reason: 'quota_exhausted' })
  assert.equal(unknownQuota.remaining, null)
})

test('readResult：其余原因归普通错误，非对象响应归 parse_error', () => {
  for (const reason of ['invalid_argument', 'business_error', 'unknown', 'network_error', 'brand_new_reason']) {
    const result = client.readResult({ ok: false, reason, message: 'm' })
    assert.equal(result.kind, 'error', reason)
    assert.equal(result.reason, reason)
    assert.equal(result.message, 'm')
  }

  const missingReason = client.readResult({ ok: false })
  assert.equal(missingReason.kind, 'error')
  assert.equal(missingReason.reason, 'unknown')

  for (const body of [undefined, null, 'text', 42, []]) {
    assert.equal(client.readResult(body).reason, 'parse_error')
  }
})

test('fetchView：用文档相对 URL 取数，带上 same-origin 与 accept', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { status: 200, json: async () => ({ ok: true, fetchedAt: 7, data: { items: [] } }) }
  }
  const result = await client.fetchView(fetchImpl, client.hotRequest())

  assert.equal(result.kind, 'ok')
  assert.equal(result.fetchedAt, 7)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'api/dsh-zhihu-sidebar/hot?limit=30')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.deepEqual(calls[0].init.headers, { accept: 'application/json' })
})

test('fetchView：网络异常与不可解析响应都不抛错', async () => {
  const thrown = await client.fetchView(async () => {
    throw new Error('boom')
  }, client.hotRequest())
  assert.equal(thrown.kind, 'error')
  assert.equal(thrown.reason, 'network_error')
  assert.equal(thrown.message, 'boom')

  const broken = await client.fetchView(
    async () => ({
      status: 502,
      json: async () => {
        throw new SyntaxError('not json')
      },
    }),
    client.hotRequest(),
  )
  assert.equal(broken.reason, 'parse_error')
  assert.equal(broken.message, 'HTTP 502')
})

test('热榜冷却：没取过就放行，冷却中给倒计时，到点放行', () => {
  const now = 1000000
  assert.deepEqual(client.refreshPlan(null, now), { deadline: null, remaining: 0, ready: true })

  const cooling = client.refreshPlan(now, now + 1)
  assert.equal(cooling.ready, false)
  assert.equal(cooling.deadline, now + client.HOT_REFRESH_INTERVAL_MS)
  assert.equal(cooling.remaining, client.HOT_REFRESH_INTERVAL_MS - 1)
  assert.equal(client.formatDuration(cooling.remaining), '30:00')

  assert.equal(client.refreshPlan(now, now + client.HOT_REFRESH_INTERVAL_MS - 1).ready, false)
  assert.equal(client.refreshPlan(now, now + client.HOT_REFRESH_INTERVAL_MS).ready, true)
  assert.equal(client.formatDuration(client.refreshPlan(now, now + 1).remaining), '30:00')
})

test('冷却剩余按响应时刻逐秒递减，到点归零', () => {
  const at = 1000000
  const rate = client.readResult({ ok: false, reason: 'rate_limited', retryAfterMs: 5000 })

  assert.equal(client.remainingRetry(rate, at, at), 5000)
  assert.equal(client.remainingRetry(rate, at, at + 2000), 3000)
  assert.equal(client.remainingRetry(rate, at, at + 4999), 1)
  assert.equal(client.remainingRetry(rate, at, at + 5000), 0)
  assert.equal(client.remainingRetry(rate, at, at + 9000), 0)
  assert.equal(client.remainingRetry(null, at, at), 0)
  assert.equal(client.remainingRetry(rate, undefined, at), 0)
})

test('倒计时格式化：向上取整到秒，负数夹到 0:00', () => {
  assert.equal(client.formatDuration(0), '0:00')
  assert.equal(client.formatDuration(1), '0:01')
  assert.equal(client.formatDuration(45000), '0:45')
  assert.equal(client.formatDuration(59999), '1:00')
  assert.equal(client.formatDuration(60000), '1:00')
  assert.equal(client.formatDuration(300000), '5:00')
  assert.equal(client.formatDuration(-5000), '0:00')
})

test('本地时刻格式化成 HH:MM', () => {
  assert.equal(client.formatClock(new Date(2026, 0, 2, 9, 5).getTime()), '09:05')
  assert.equal(client.formatClock(new Date(2026, 11, 31, 23, 59).getTime()), '23:59')
})

test('创作时间：Unix 秒级时间戳换算成相对时间', () => {
  const now = 1800000000000
  const at = (secondsAgo) => now / 1000 - secondsAgo

  assert.deepEqual(client.describeAge(at(0), now), { unit: 'justNow', count: 0 })
  assert.deepEqual(client.describeAge(at(59), now), { unit: 'justNow', count: 0 })
  assert.deepEqual(client.describeAge(at(60), now), { unit: 'minute', count: 1 })
  assert.deepEqual(client.describeAge(at(3599), now), { unit: 'minute', count: 59 })
  assert.deepEqual(client.describeAge(at(3600), now), { unit: 'hour', count: 1 })
  assert.deepEqual(client.describeAge(at(86400), now), { unit: 'day', count: 1 })
  assert.deepEqual(client.describeAge(at(30 * 86400), now), { unit: 'month', count: 1 })
  assert.deepEqual(client.describeAge(at(365 * 86400), now), { unit: 'year', count: 1 })
  assert.deepEqual(client.describeAge(at(-10), now), { unit: 'justNow', count: 0 })
  assert.equal(client.describeAge(null, now), null)
  assert.equal(client.describeAge('1793161647', now), null)
})

test('总数只给知道总数的视图：搜索永远没有总数', () => {
  assert.equal(client.totalOf('hot', { total: 30, pageSize: 30, items: [] }), 30)
  assert.equal(client.totalOf('contents', { total: 12, pageSize: 12, items: [] }), 12)
  assert.equal(client.totalOf('search', { pageSize: 5, hasMore: true, items: [] }), null)
  assert.equal(client.totalOf('contents', { total: null, pageSize: 0, items: [] }), null)
  assert.equal(client.totalOf('hot', null), null)

  assert.equal(client.pageSizeOf({ pageSize: 3 }), 3)
  assert.equal(client.pageSizeOf({}), 0)
  assert.equal(client.pageSizeOf(undefined), 0)
})

test('热榜行：保留缩略图，缺链接时用序号做键', () => {
  const rows = client.hotRows({
    total: 2,
    pageSize: 2,
    items: [
      {
        title: '合成热榜条目',
        url: 'https://example.test/a',
        thumbnailUrl: 'https://example.test/a.png',
        summary: '合成摘要',
      },
      { title: '无链接热榜条目', url: '', thumbnailUrl: '', summary: '' },
    ],
  })

  assert.deepEqual(rows[0], {
    key: 'https://example.test/a',
    title: '合成热榜条目',
    url: 'https://example.test/a',
    summary: '合成摘要',
    thumbnailUrl: 'https://example.test/a.png',
  })
  assert.equal(rows[1].key, 'item-1')
  assert.deepEqual(client.hotRows(null), [])
  assert.deepEqual(client.hotRows({ items: 'nope' }), [])
})

test('搜索行：带作者与摘要', () => {
  const rows = client.searchRows({
    pageSize: 1,
    hasMore: true,
    items: [
      {
        title: '合成搜索标题',
        url: 'https://example.test/b',
        author: '合成作者',
        summary: '合成搜索摘要',
      },
    ],
  })
  assert.deepEqual(rows, [
    {
      key: 'https://example.test/b',
      title: '合成搜索标题',
      url: 'https://example.test/b',
      author: '合成作者',
      summary: '合成搜索摘要',
    },
  ])
  assert.deepEqual(client.searchRows(undefined), [])
})

test('创作行：带类型与相对时间', () => {
  const now = 1800000000000
  const rows = client.contentRows(
    {
      total: 1,
      pageSize: 1,
      hasMore: false,
      nextOffset: null,
      items: [
        {
          title: '合成创作标题',
          url: 'https://example.test/c',
          type: 'answer',
          createdAt: now / 1000 - 3 * 86400,
          summary: '合成创作摘要',
        },
      ],
    },
    now,
  )
  assert.deepEqual(rows, [
    {
      key: 'https://example.test/c',
      title: '合成创作标题',
      url: 'https://example.test/c',
      type: 'answer',
      summary: '合成创作摘要',
      age: { unit: 'day', count: 3 },
    },
  ])
  assert.equal(client.contentRows({ items: [{ title: 't', url: 'u', type: '', createdAt: null }] }, now)[0].age, null)
})

test('创作类型标签：认识的翻译，不认识的原样显示', () => {
  const t = translator()
  assert.equal(client.contentLabel('answer', t), 'type.answer')
  assert.equal(client.contentLabel('Article', t), 'type.article')
  assert.equal(client.contentLabel('zvideo', t), 'type.video')
  assert.equal(client.contentLabel('something-new', t), 'something-new')
  assert.equal(client.contentLabel('', t), '')
  assert.equal(client.contentLabel(undefined, t), '')
})

test('失败态展示：auth 给按钮 / rate 给倒计时 / quota 给额度 / 其它给消息', () => {
  const t = translator()

  const auth = client.describeFailureUi(
    client.readResult({ ok: false, reason: 'auth_required', message: 'no access secret' }),
    t,
  )
  assert.equal(auth.tone, 'warning')
  assert.equal(auth.message, 'error.auth')
  assert.equal(auth.detail, 'no access secret')
  assert.deepEqual(auth.action, { label: 'error.authAction', url: client.AUTH_CONSOLE_URL })

  const rate = client.describeFailureUi(
    client.readResult({ ok: false, reason: 'rate_limited', retryAfterMs: 90000 }),
    t,
  )
  assert.equal(rate.tone, 'warning')
  assert.equal(rate.message, 'error.rate{"time":"1:30"}')
  assert.equal(rate.action, null)

  const quota = client.describeFailureUi(
    client.readResult({ ok: false, reason: 'quota_exhausted', quota: { remaining: 0 } }),
    t,
  )
  assert.equal(quota.message, 'error.quota{"count":"0"}')

  const quotaUnknown = client.describeFailureUi(client.readResult({ ok: false, reason: 'quota_exhausted' }), t)
  assert.equal(quotaUnknown.message, 'error.quotaUnknown')

  const invalid = client.describeFailureUi(
    client.readResult({ ok: false, reason: 'invalid_argument', message: 'q is required' }),
    t,
  )
  assert.equal(invalid.tone, 'error')
  assert.equal(invalid.message, 'error.invalid_argument')
  assert.equal(invalid.detail, 'q is required')
  assert.equal(invalid.action, null)

  const generic = client.describeFailureUi(client.readResult({ ok: false, reason: 'brand_new_reason' }), t)
  assert.equal(generic.message, 'error.generic')
})

test('中英文案键一一对应，占位符一致', () => {
  assert.deepEqual(Object.keys(client.zh).sort(), Object.keys(client.en).sort())
  for (const key of Object.keys(client.zh)) {
    const zhVars = (client.zh[key].match(/\{\w+\}/g) ?? []).sort()
    const enVars = (client.en[key].match(/\{\w+\}/g) ?? []).sort()
    assert.deepEqual(enVars, zhVars, key)
  }
})

test('代码里引用的文案键都真实存在', () => {
  for (const key of Object.values(client.ERROR_KEYS)) assert.ok(Object.hasOwn(client.zh, key), key)
  for (const key of Object.values(client.CONTENT_TYPES)) assert.ok(Object.hasOwn(client.zh, key), key)
  for (const key of Object.values(client.IDLE_KEYS)) assert.ok(Object.hasOwn(client.zh, key), key)
  for (const key of Object.values(client.FAILURE_KIND)) {
    assert.ok(Object.hasOwn(client.zh, `error.${key}`), key)
  }
  for (const view of client.VIEWS) assert.ok(Object.hasOwn(client.zh, `view.${view}`), view)
  for (const unit of ['justNow', 'minute', 'hour', 'day', 'month', 'year']) {
    assert.ok(Object.hasOwn(client.zh, `age.${unit}`), unit)
  }
})

test('正文组件是函数，取数入口可注入', () => {
  assert.equal(typeof client.ZhihuTabBody, 'function')
  assert.equal(typeof react.createElement, 'function')
})

test('首次渲染：三个分段 + 热榜加载按钮 + 空闲提示，不显示任何结果', () => {
  const element = client.ZhihuTabBody({ t: translator() })

  assert.equal(element.type, 'div')
  const bar = element.children[0]
  const segments = bar.children[0]
  assert.deepEqual(
    segments.map((segment) => segment.children[0]),
    ['view.hot', 'view.search', 'view.contents'],
  )
  assert.equal(segments[0].props.style.fontWeight, 600)
  assert.equal(bar.children[2].children[0], 'hot.load')

  const body = element.children[2]
  assert.equal(body.type, 'p')
  assert.equal(body.children[0], 'hot.idle')
  assert.equal(element.children[1], null)
})
