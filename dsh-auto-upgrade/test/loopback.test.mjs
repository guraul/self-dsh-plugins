import test from 'node:test'
import assert from 'node:assert/strict'

import { createRoute } from '../lib/host/http.js'
import { isIPv4Loopback, isLoopbackAddress, isLoopbackRequest } from '../lib/host/loopback.js'

/**
 * 造一个假请求。
 * @param {{address?:string, host?:string, site?:string, origin?:string}} options 字段。
 * @returns {any} 假请求。
 */
function fakeReq(options = {}) {
  const headers = {}
  if (options.host !== null) headers.host = options.host ?? '127.0.0.1:3080'
  if (options.site !== undefined) headers['sec-fetch-site'] = options.site
  if (options.origin !== undefined) headers.origin = options.origin
  return {
    method: 'GET',
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    headers,
    url: '/',
  }
}

test('地址判定：127/8、::1、IPv4 映射回环', () => {
  assert.equal(isIPv4Loopback('127.0.0.1'), true)
  assert.equal(isIPv4Loopback('127.1.2.3'), true)
  assert.equal(isIPv4Loopback('128.0.0.1'), false)
  assert.equal(isIPv4Loopback('127.0.0.256'), false)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.4'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

test('围栏：只放行本机 socket + 本机 Host + 同源标记', () => {
  assert.equal(isLoopbackRequest(fakeReq()), true)
  assert.equal(isLoopbackRequest(fakeReq({ address: '10.0.0.9' })), false)
  assert.equal(isLoopbackRequest(fakeReq({ host: 'example.com' })), false)
  assert.equal(isLoopbackRequest(fakeReq({ host: null })), false)
  assert.equal(isLoopbackRequest(fakeReq({ site: 'cross-site' })), false)
  assert.equal(isLoopbackRequest(fakeReq({ site: 'same-origin' })), true)
  assert.equal(isLoopbackRequest(fakeReq({ origin: 'https://example.com' })), false)
  assert.equal(isLoopbackRequest(fakeReq({ origin: 'http://127.0.0.1:3080' })), true)
})

test('createRoute：围栏拒绝 403、方法不允许 405、异常翻成信封', async () => {
  const handlers = {
    GET: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    },
  }
  const deny = createRoute(handlers, () => false)
  const allow = createRoute(handlers, () => true)
  const calls = []
  const res = {
    writeHead(status, headers) {
      calls.push({ status, headers })
      return this
    },
    end(body) {
      calls.push({ body: String(body) })
      return this
    },
  }
  await deny(fakeReq(), res)
  assert.equal(calls[0].status, 403)

  calls.length = 0
  await allow({ ...fakeReq(), method: 'POST' }, res)
  assert.equal(calls[0].status, 405)

  calls.length = 0
  const throwing = createRoute({ GET: async () => { throw new Error('boom') } }, () => true)
  await throwing(fakeReq(), res)
  assert.equal(calls[0].status, 500)
  assert.match(calls[1].body, /boom/)
})
