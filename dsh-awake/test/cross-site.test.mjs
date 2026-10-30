import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertPluginRequest,
  hasPluginHeader,
  isPluginRequest,
  isSameOriginOrEmpty,
} from '../lib/host/cross-site.js'
import { RequestError } from '../lib/host/http.js'
import { isLoopbackRequest } from '../lib/host/loopback.js'
import { CODE } from '../lib/host/protocol.js'

/**
 * 造一个够用的假请求。
 * @param {Record<string, any>} headers 请求头。
 * @param {string} [remoteAddress] socket 远端地址。
 * @returns {any} 假请求。
 */
function req(headers, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } }
}

test('hasPluginHeader: 只认 x-dsh-plugin: awake', () => {
  assert.equal(hasPluginHeader(req({ 'x-dsh-plugin': 'awake' })), true)
  assert.equal(hasPluginHeader(req({ 'x-dsh-plugin': ' AWake ' })), true)
  assert.equal(hasPluginHeader(req({ 'x-dsh-plugin': 'other' })), false)
  assert.equal(hasPluginHeader(req({})), false)
  assert.equal(hasPluginHeader(req({ 'x-dsh-plugin': ['awake', 'other'] })), false)
})

test('isSameOriginOrEmpty: 空 Origin 通过，同 authority 通过，其余一律否', () => {
  assert.equal(isSameOriginOrEmpty(req({ host: '127.0.0.1:3080' })), true, '没有 Origin（非浏览器 / 同源导航）')
  assert.equal(isSameOriginOrEmpty(req({ host: '127.0.0.1:3080', origin: '' })), true)
  assert.equal(isSameOriginOrEmpty(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), true)
  assert.equal(isSameOriginOrEmpty(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' })), false, '端口不同不是同源')
  assert.equal(isSameOriginOrEmpty(req({ host: '127.0.0.1:3080', origin: 'https://evil.example' })), false)
  assert.equal(isSameOriginOrEmpty(req({ host: '127.0.0.1:3080', origin: 'null' })), false, '沙箱 iframe 的 null 源算跨站')
  assert.equal(isSameOriginOrEmpty(req({ host: '127.0.0.1:3080', origin: 'not a url' })), false)
  assert.equal(isSameOriginOrEmpty(req({ origin: 'http://127.0.0.1:3080' })), false, '没有 Host 就没法比')
})

test('isPluginRequest 要求两条同时成立', () => {
  const base = { host: '127.0.0.1:3080' }
  assert.equal(isPluginRequest(req({ ...base, 'x-dsh-plugin': 'awake' })), true)
  assert.equal(isPluginRequest(req({ ...base })), false, '缺头')
  assert.equal(isPluginRequest(req({ ...base, 'x-dsh-plugin': 'awake', origin: 'https://evil.example' })), false, '头齐但跨站')
})

test('assertPluginRequest 抛 403 E_FORBIDDEN', () => {
  assert.throws(
    () => assertPluginRequest(req({ host: '127.0.0.1:3080' })),
    (error) => {
      assert.ok(error instanceof RequestError)
      assert.equal(error.status, 403)
      assert.equal(error.code, CODE.FORBIDDEN)
      return true
    },
  )
  assert.doesNotThrow(() => assertPluginRequest(req({ host: '127.0.0.1:3080', 'x-dsh-plugin': 'awake' })))
})

test('loopback 围栏：socket 为准，Host / sec-fetch-site / Origin 都要过', () => {
  assert.equal(isLoopbackRequest(req({ host: '127.0.0.1:3080' })), true)
  assert.equal(isLoopbackRequest(req({ host: 'localhost:3080' }, '::1')), true)
  assert.equal(isLoopbackRequest(req({ host: '[::1]:3080' }, '::1')), true)
  assert.equal(isLoopbackRequest(req({ host: '127.0.0.1:3080' }, '192.168.1.9')), false, 'LAN 来源')
  assert.equal(isLoopbackRequest(req({ host: '192.168.1.9:3080' })), false, 'Host 不是本机名')
  assert.equal(isLoopbackRequest(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isLoopbackRequest(req({ host: '127.0.0.1:3080', origin: 'https://evil.example' })), false)
  assert.equal(isLoopbackRequest(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' })), true)
})
