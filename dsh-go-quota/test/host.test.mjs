import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/**
 * 造一个最小宿主上下文并抓住路由 handler。
 * @param {object} options `fetch` / `key`。
 * @returns {{call: (method?: string) => Promise<{status: number, body: any}>}}
 */
function harness(options) {
  let handler
  const ctx = {
    credentials: { resolve: async () => (options.key === null ? undefined : { value: options.key ?? 'test-key' }) },
    inject(_deps, callback) {
      callback({ webServer: { register: (route) => { handler = route.handler; return () => {} } } })
    },
    effect(run) { run() },
  }
  apply(ctx, { fetch: options.fetch, cacheMs: options.cacheMs ?? 30000 })
  const callWith = async (remoteAddress, method = 'GET') => {
    let body = ''
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      writeHead(code) { this.statusCode = code },
      end(text) { body = text },
    }
    await handler({ method, socket: { remoteAddress } }, res)
    return { status: res.statusCode, headers: res.headers, body: body === '' ? null : JSON.parse(body) }
  }
  return {
    call: (method = 'GET') => callWith('127.0.0.1', method),
    callFrom: (addr, method = 'GET') => callWith(addr, method),
  }
}

/** 一份合法的上游响应。 */
function payload(percent = { rolling: 1, weekly: 6, monthly: 3 }) {
  return {
    usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map((key) => [
      key,
      { status: 'ok', percent: percent[key], resetsAt: '2026-11-15T11:58:18.000Z' },
    ])),
  }
}

test('归一化后按 rolling/weekly/monthly 排序', async () => {
  const h = harness({ fetch: async () => ({ ok: true, status: 200, json: async () => payload() }) })
  const { status, body } = await h.call()
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.windows.map((w) => w.key), ['rolling', 'weekly', 'monthly'])
  assert.deepEqual(body.windows.map((w) => w.percent), [1, 6, 3])
})

test('上游 401 映射成 unauthorized', async () => {
  const h = harness({ fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) })
  const { status, body } = await h.call()
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'unauthorized')
})

test('缓存窗口内只发一次上游请求', async () => {
  let calls = 0
  const h = harness({
    fetch: async () => { calls += 1; return { ok: true, status: 200, json: async () => payload() } },
    cacheMs: 60000,
  })
  await h.call()
  await h.call()
  assert.equal(calls, 1)
})

test('缺窗口判定为 shape 错误', async () => {
  const broken = payload()
  delete broken.usage.monthly
  const h = harness({ fetch: async () => ({ ok: true, status: 200, json: async () => broken }) })
  const { body } = await h.call()
  assert.equal(body.ok, false)
  assert.equal(body.code, 'shape')
})

test('没有 key 时回 no-key', async () => {
  const h = harness({ key: null, fetch: async () => { throw new Error('should not fetch') } })
  const { body } = await h.call()
  assert.equal(body.code, 'no-key')
})

test('并发两次调用只打一次上游', async () => {
  let calls = 0
  const h = harness({
    fetch: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { ok: true, status: 200, json: async () => payload() }
    },
    cacheMs: 60000,
  })
  await Promise.all([h.call(), h.call()])
  assert.equal(calls, 1)
})

test('非 GET 回 405，非回环回 403', async () => {
  const h = harness({ fetch: async () => ({ ok: true, status: 200, json: async () => payload() }) })
  const post = await h.call('POST')
  assert.equal(post.status, 405)
  const remote = await h.callFrom('10.0.0.7')
  assert.equal(remote.status, 403)
})

test('失败不写缓存，下一次会重试', async () => {
  let calls = 0
  const h = harness({
    fetch: async () => {
      calls += 1
      return calls === 1
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => payload() }
    },
    cacheMs: 60000,
  })
  const first = await h.call()
  assert.equal(first.body.ok, false)
  const second = await h.call()
  assert.equal(second.body.ok, true)
  assert.equal(calls, 2)
})
