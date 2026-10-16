import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { API } from '../lib/host/protocol.js'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('浏览器半边与本文件的路由表一致（无构建 = 靠测试保证）', () => {
  const found = new Set(client.match(/\/api\/dsh-auto-upgrade[\w/-]*/g) ?? [])
  assert.deepEqual([...found].sort(), Object.values(API).sort())
  for (const path of Object.values(API)) {
    assert.ok(client.includes(`'${path}'`), `client is missing ${path}`)
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
