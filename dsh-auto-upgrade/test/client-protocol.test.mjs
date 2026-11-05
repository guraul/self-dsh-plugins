import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { API } from '../lib/host/protocol.js'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('浏览器半边与本文件的路由表一致（无构建 = 靠测试保证）', () => {
  // 只在宿主侧用、浏览器半边还没接入的路由（#300 的 probe 属 P1 后端，P1b 接 UI 后删掉）。
  const HOST_ONLY = new Set([API.probe])
  const expected = Object.values(API).filter((path) => !HOST_ONLY.has(path))
  const found = new Set(client.match(/\/api\/dsh-auto-upgrade[\w/-]*/g) ?? [])
  assert.deepEqual([...found].sort(), expected.sort())
  for (const path of expected) {
    assert.ok(client.includes(`'${path}'`), `client is missing ${path}`)
  }
  for (const path of HOST_ONLY) {
    assert.ok(!client.includes(`'${path}'`), `${path} 已接进 client，请从 HOST_ONLY 删掉`)
  }
})

test('客户端入口契约：ModuleLoader + exports.apply/inject', () => {
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(client, /id: 'dsh-plugin-auto-upgrade'/)
  assert.match(client, /exports\.apply = apply/)
  assert.match(client, /exports\.inject = \['slots'\]/)
  assert.match(client, /shell\.overlay/)
  assert.match(client, /settings\.section/)
})
