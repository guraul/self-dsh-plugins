import test from 'node:test'
import assert from 'node:assert/strict'

import { createCli, minimalEnv } from '../lib/host/cli.js'
import { fakeRuntime, scriptBin } from './helpers.mjs'

test('成功路径：退出码 0，stdout 原样交出', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'] })
  t.after(() => runtime.cleanup())

  const result = await runtime.cli.run(['hot', '--limit', '3'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(result.timedOut, false)
  assert.equal(JSON.parse(result.stdout).Code, 0)
})

test('鉴权缺失：退出码 3 原样返回，不在这一层解释', async (t) => {
  const runtime = fakeRuntime({ modes: ['auth_required'] })
  t.after(() => runtime.cleanup())

  const result = await runtime.cli.run(['hot', '--limit', '3'])
  assert.equal(result.code, 3)
  assert.match(result.stdout, /AUTH_REQUIRED/)
})

test('stderr 与退出码都保留', async (t) => {
  const runtime = fakeRuntime({ modes: ['stderr'] })
  t.after(() => runtime.cleanup())

  const result = await runtime.cli.run(['hot'])
  assert.equal(result.code, 6)
  assert.equal(result.stderr, 'boom\n')
})

test('超时由 libuv 杀进程', async (t) => {
  const runtime = fakeRuntime({ modes: ['hang'], timeoutMs: 250 })
  t.after(() => runtime.cleanup())

  const started = Date.now()
  const result = await runtime.cli.run(['hot'])
  assert.equal(result.code, null)
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 3000)
})

test('二进制不存在：code 为 null，spawnError 带 ENOENT', async () => {
  const cli = createCli({ binPath: '/nonexistent/zhihu-cli-for-test' })
  const result = await cli.run(['version'])
  assert.equal(result.code, null)
  assert.match(result.spawnError, /ENOENT/)
})

test('环境变量是白名单：不出现任何密钥类变量', async (t) => {
  const runtime = fakeRuntime({ modes: ['env'] })
  t.after(() => runtime.cleanup())
  process.env.ZHIHU_ACCESS_SECRET = 'should-not-leak'

  try {
    const result = await runtime.cli.run(['capabilities'])
    assert.equal(result.code, 0)
    const dump = runtime.envDump()
    assert.deepEqual(dump.secretLike, [])
    assert.equal(dump.keys.includes('ZHIHU_ACCESS_SECRET'), false)
    assert.equal(dump.keys.includes('ZHIHU_FAKE_DIR'), true)
    assert.equal(dump.keys.includes('PATH'), true)
  } finally {
    delete process.env.ZHIHU_ACCESS_SECRET
  }
})

test('minimalEnv 只挑白名单并保证 PATH', () => {
  const env = minimalEnv({ HOME: '/Users/x', SECRET: 's', PATH: '/bin' })
  assert.deepEqual(env, { HOME: '/Users/x', PATH: '/bin' })
  assert.equal(minimalEnv({}).PATH.includes('/usr/bin'), true)
})

test('从固定脚本读取：退出码与 payload 一致', async (t) => {
  const runtime = fakeRuntime({ modes: ['success'] })
  t.after(() => runtime.cleanup())
  const bin = scriptBin(runtime.dir, '#!/bin/sh\nprintf \'%s\' \'{"Code":0,"Data":{"ok":true}}\'\nexit 0\n')
  const cli = createCli({ binPath: bin })
  const result = await cli.run(['hot'])
  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout), { Code: 0, Data: { ok: true } })
})
