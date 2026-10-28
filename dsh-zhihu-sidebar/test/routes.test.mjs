import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { API, createRoute, isLoopbackRequest, RequestError } from '../lib/host/http.js'
import { fakeRuntime, scriptBin } from './helpers.mjs'

function boot(t, cliPath) {
  const routes = new Map()
  const closers = []
  const ctx = {
    inject(_deps, fn) {
      fn({
        webServer: {
          port: 3080,
          register({ path, handler }) {
            routes.set(path, handler)
            return () => routes.delete(path)
          },
        },
      })
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') closers.push(dispose)
    },
  }
  apply(ctx, { cliPath })
  t.after(() => {
    for (const close of closers) close()
  })
  return routes
}

function request(path, { method = 'GET', remote = '127.0.0.1', host = '127.0.0.1:3080', headers = {} } = {}) {
  return { method, url: path, socket: { remoteAddress: remote }, headers: { host, ...headers } }
}

function response() {
  const state = { status: 0, body: undefined, headers: undefined }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(payload) {
      state.body = JSON.parse(payload)
    },
  }
}

async function call(routes, path, options) {
  const res = response()
  await routes.get(new URL(path, 'http://127.0.0.1').pathname)(request(path, options), res)
  return res
}

test('GET /hot 返回规范化热榜', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'] })
  t.after(() => runtime.cleanup())
  const bin = scriptBin(
    runtime.dir,
    `#!/bin/sh
printf '%s' '{"Code":0,"Message":"success","Data":{"Total":1,"Items":[{"Title":"A","Url":"https://www.zhihu.com/question/1","ThumbnailUrl":"t","Summary":"s"}]}}'
exit 0
`,
  )
  const routes = boot(t, bin)
  assert.equal(routes.has(API.hot), true)

  const res = await call(routes, `${API.hot}?limit=3`)
  assert.equal(res.state.status, 200)
  assert.equal(res.state.body.ok, true)
  assert.deepEqual(res.state.body.data.items[0], {
    title: 'A',
    url: 'https://www.zhihu.com/question/1',
    thumbnailUrl: 't',
    summary: 's',
  })
})

test('非回环来源一律 403', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'] })
  t.after(() => runtime.cleanup())
  const bin = scriptBin(runtime.dir, '#!/bin/sh\nexit 0\n')
  const routes = boot(t, bin)

  const remote = await call(routes, API.hot, { remote: '192.168.1.20' })
  assert.equal(remote.state.status, 403)
  assert.equal(remote.state.body.code, 'E_LOOPBACK_ONLY')

  const foreignHost = await call(routes, API.hot, { host: 'evil.example.com' })
  assert.equal(foreignHost.state.status, 403)
})

test('非 GET 方法 405', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'] })
  t.after(() => runtime.cleanup())
  const routes = boot(t, scriptBin(runtime.dir, '#!/bin/sh\nexit 0\n'))

  const res = await call(routes, API.hot, { method: 'POST' })
  assert.equal(res.state.status, 405)
  assert.equal(res.state.body.code, 'E_METHOD_NOT_ALLOWED')
})

test('搜索缺 q 与 limit 越界都是 400', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'] })
  t.after(() => runtime.cleanup())
  const routes = boot(t, scriptBin(runtime.dir, '#!/bin/sh\nexit 0\n'))

  const missing = await call(routes, API.search)
  assert.equal(missing.state.status, 400)
  assert.equal(missing.state.body.code, 'E_BAD_REQUEST')

  const tooBig = await call(routes, `${API.hot}?limit=31`)
  assert.equal(tooBig.state.status, 400)

  const notNumber = await call(routes, `${API.hot}?limit=abc`)
  assert.equal(notNumber.state.status, 400)
})

test('鉴权失败 → 401 且带 action_url', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'] })
  t.after(() => runtime.cleanup())
  const bin = scriptBin(
    runtime.dir,
    `#!/bin/sh
printf '%s' '{"ok":false,"error":{"source":"cli","code":"AUTH_REQUIRED","message":"需要密钥","action_url":"https://developer.zhihu.com/profile"}}'
exit 3
`,
  )
  const routes = boot(t, bin)

  const res = await call(routes, API.contents)
  assert.equal(res.state.status, 401)
  assert.equal(res.state.body.reason, 'auth_required')
  assert.equal(res.state.body.actionUrl, 'https://developer.zhihu.com/profile')
})

test('限流 → 429', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'] })
  t.after(() => runtime.cleanup())
  const bin = scriptBin(
    runtime.dir,
    `#!/bin/sh
printf '%s' '{"ok":false,"error":{"source":"cli","code":"RATE_LIMITED","message":"rate limit exceeded"}}'
exit 4
`,
  )
  const routes = boot(t, bin)

  const res = await call(routes, API.hot)
  assert.equal(res.state.status, 429)
  assert.equal(res.state.body.reason, 'rate_limited')
})

test('GET /status 暴露运维状态', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'] })
  t.after(() => runtime.cleanup())
  const routes = boot(t, scriptBin(runtime.dir, '#!/bin/sh\nexit 0\n'))

  const res = await call(routes, API.status)
  assert.equal(res.state.status, 200)
  assert.equal(res.state.body.ok, true)
  assert.equal(typeof res.state.body.queue.started, 'number')
  assert.equal(typeof res.state.body.quota.used, 'object')
})

test('createRoute 把 RequestError 映射成统一错误信封', async () => {
  const handler = createRoute(
    {
      GET() {
        throw new RequestError(409, 'E_CONFLICT', 'nope', { hint: 1 })
      },
    },
    isLoopbackRequest,
  )
  const res = response()
  await handler(request('/x'), res)
  assert.equal(res.state.status, 409)
  assert.deepEqual(res.state.body, { ok: false, code: 'E_CONFLICT', error: 'nope', detail: { hint: 1 } })
})

test('createRoute 把未知异常收成 500', async () => {
  const handler = createRoute(
    {
      GET() {
        throw new Error('kaboom')
      },
    },
    isLoopbackRequest,
  )
  const res = response()
  await handler(request('/x'), res)
  assert.equal(res.state.status, 500)
  assert.equal(res.state.body.code, 'E_INTERNAL')
})
