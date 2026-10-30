import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'

import { apply } from '../lib/index.js'
import { API, CODE, PLUGIN_HEADER, PLUGIN_HEADER_VALUE } from '../lib/host/protocol.js'

/**
 * 假子进程（与 service 测试同形，故意不共享：两份测试不该互相依赖）。
 */
class FakeChild extends EventEmitter {
  /**
   * @param {number} pid 进程号。
   */
  constructor(pid) {
    super()
    this.pid = pid
    this.signals = []
  }

  /**
   * @param {string} signal 信号。
   * @returns {boolean} 恒 true。
   */
  kill(signal) {
    this.signals.push(signal)
    return true
  }
}

/**
 * 起一个只跑本插件路由的最小宿主。
 * @param {object} [options] 选项。
 * @returns {Promise<object>} 宿主句柄。
 */
async function startHost(options = {}) {
  const routes = []
  const children = []
  const spawnCalls = []
  const effects = []
  let nextPid = 5000

  const spawn = (command, args, spawnOptions) => {
    spawnCalls.push({ command, args, spawnOptions })
    const child = new FakeChild(nextPid)
    nextPid += 1
    children.push(child)
    return child
  }

  const ctx = {
    inject: (_deps, callback) => {
      callback({
        webServer: {
          register: (route) => {
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index !== -1) routes.splice(index, 1)
            }
          },
          port: 3080,
          protocol: 'http:',
        },
      })
    },
    // 与 cordis 一致：effect 回调立刻执行，返回的清理函数在 dispose 时调用。
    effect: (fn) => {
      effects.push(fn())
    },
  }

  apply(ctx, { spawn, wait: async () => {}, platform: 'darwin', now: () => 1700000000000, ...options.patch })

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const route = routes.find((candidate) => candidate.path === pathname)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":"no route"}')
      return
    }
    return route.handler(req, res)
  })
  server.on('error', () => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    paths: () => routes.map((route) => route.path).sort(),
    children,
    spawnCalls,
    effects,
    /** 模拟宿主卸载：关服务前先跑一遍 effect 的清理函数。 */
    close: async () => {
      for (const dispose of effects.splice(0)) dispose()
      await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) })
    },
  }
}

/**
 * 发一个请求，返回状态码与 JSON。
 * @param {string} url 完整 URL。
 * @param {object} [options] 选项。
 * @returns {Promise<{status:number, body:any}>} 结果。
 */
async function call(url, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  const response = await fetch(url, { method: options.method ?? 'GET', headers, body: options.body })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

test('三条路由都注册成精确路径', async () => {
  const host = await startHost()
  try {
    assert.deepEqual(host.paths(), [API.start, API.status, API.stop].sort())
  } finally {
    await host.close()
  }
})

test('GET status 返回 inactive 信封', async () => {
  const host = await startHost()
  try {
    const { status, body } = await call(`${host.base}${API.status}`)
    assert.equal(status, 200)
    assert.deepEqual(body, { ok: true, active: false, pid: null, startedAt: null })
  } finally {
    await host.close()
  }
})

test('POST start 不带 X-DSH-Plugin → 403，且不 spawn', async () => {
  const host = await startHost()
  try {
    const { status, body } = await call(`${host.base}${API.start}`, { method: 'POST' })
    assert.equal(status, 403)
    assert.equal(body.code, CODE.FORBIDDEN)
    assert.equal(host.spawnCalls.length, 0)
  } finally {
    await host.close()
  }
})

test('POST start 带外站 Origin → 403（loopback 围栏先挡）', async () => {
  const host = await startHost()
  try {
    const { status, body } = await call(`${host.base}${API.start}`, {
      method: 'POST',
      headers: { [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE, origin: 'https://evil.example' },
    })
    assert.equal(status, 403)
    assert.equal(body.code, CODE.LOOPBACK_ONLY)
    assert.equal(host.spawnCalls.length, 0)
  } finally {
    await host.close()
  }
})

test('POST start 带「本机别的端口」的 Origin → 403 E_FORBIDDEN（跨站防护挡）', async () => {
  const host = await startHost()
  try {
    // 同 loopback 主机、不同端口：loopback 围栏放行，跨站防护必须拦下。
    const port = new URL(host.base).port
    const { status, body } = await call(`${host.base}${API.start}`, {
      method: 'POST',
      headers: { [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE, origin: `http://127.0.0.1:${Number(port) + 1}` },
    })
    assert.equal(status, 403)
    assert.equal(body.code, CODE.FORBIDDEN)
    assert.equal(host.spawnCalls.length, 0)
  } finally {
    await host.close()
  }
})

test('POST start 带同源 Origin + 头 → 200，只 spawn 一次（单实例）', async () => {
  const host = await startHost()
  try {
    const origin = host.base
    const first = await call(`${host.base}${API.start}`, {
      method: 'POST',
      headers: { [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE, origin },
    })
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { ok: true, active: true, pid: 5000, startedAt: 1700000000000 })

    const second = await call(`${host.base}${API.start}`, {
      method: 'POST',
      headers: { [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE },
    })
    assert.equal(second.status, 200)
    assert.equal(second.body.pid, 5000)
    assert.equal(host.spawnCalls.length, 1, '再点一次不许叠加第二个 caffeinate')

    const status = await call(`${host.base}${API.status}`)
    assert.deepEqual(status.body, { ok: true, active: true, pid: 5000, startedAt: 1700000000000 })
  } finally {
    await host.close()
  }
})

test('POST stop 不带 → 403 且仍 active；带 → 200 且 SIGTERM', async () => {
  const host = await startHost()
  try {
    await call(`${host.base}${API.start}`, { method: 'POST', headers: { [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE } })

    const denied = await call(`${host.base}${API.stop}`, { method: 'POST' })
    assert.equal(denied.status, 403)
    assert.equal((await call(`${host.base}${API.status}`)).body.active, true)
    assert.deepEqual(host.children[0].signals, [])

    const ok = await call(`${host.base}${API.stop}`, { method: 'POST', headers: { [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE } })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { ok: true, active: false, pid: null, startedAt: null })
    assert.deepEqual(host.children[0].signals, ['SIGTERM'])
  } finally {
    await host.close()
  }
})

test('POST 带 body → 400（本端点不吃 body）', async () => {
  const host = await startHost()
  try {
    const { status, body } = await call(`${host.base}${API.start}`, {
      method: 'POST',
      headers: { [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE, 'content-type': 'application/json' },
      body: '{"duration":600}',
    })
    assert.equal(status, 400)
    assert.equal(body.code, CODE.BAD_REQUEST)
    assert.equal(host.spawnCalls.length, 0)
  } finally {
    await host.close()
  }
})

test('方法围栏：GET start / POST status 都是 405', async () => {
  const host = await startHost()
  try {
    assert.equal((await call(`${host.base}${API.start}`)).status, 405)
    assert.equal((await call(`${host.base}${API.status}`, { method: 'POST' })).status, 405)
  } finally {
    await host.close()
  }
})

test('卸载 effect：摘掉全部路由、杀掉子进程、摘掉 exit 兜底', async () => {
  const before = process.listenerCount('exit')
  const host = await startHost()
  try {
    assert.equal(process.listenerCount('exit'), before + 1, '宿主卸载的兜底钩子已挂上')
    await call(`${host.base}${API.start}`, { method: 'POST', headers: { [PLUGIN_HEADER]: PLUGIN_HEADER_VALUE } })
    assert.equal(host.effects.length, 1)

    const dispose = host.effects[0]
    assert.equal(typeof dispose, 'function', 'effect 回调返回清理函数')
    dispose()

    assert.deepEqual(host.paths(), [])
    assert.deepEqual(host.children[0].signals, ['SIGTERM'])
    assert.equal(process.listenerCount('exit'), before, '兜底钩子随卸载摘掉，不泄漏监听器')
  } finally {
    await host.close()
  }
})

test('非 loopback 的 Host 头被围栏挡在 403 E_LOOPBACK_ONLY', async () => {
  const host = await startHost()
  try {
    const url = new URL(`${host.base}${API.status}`)
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        // fetch 禁止改 `Host`，只有原始 http 请求能演这个场景。
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { host: 'example.com' } },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }))
        },
      )
      request.on('error', reject)
      request.end()
    })
    assert.equal(response.status, 403)
    assert.equal(response.body.code, CODE.LOOPBACK_ONLY)
  } finally {
    await host.close()
  }
})
