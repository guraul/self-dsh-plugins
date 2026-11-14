/**
 * `smoke.mjs` 的自测：保证冒烟断言不会因为夹具写坏而静默变绿。
 *
 * `config-schema` 只依赖本包的构建产物，任何机器都跑；`memx-module` / `memory-dir`
 * 需要本机的 memx 仓（`lib/index.js` 里硬编码的 `MEMX_ROOT`），CI 上没有就跳过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { run } from '../smoke.mjs'

/**
 * 读出 `lib/index.js` 硬编码的 memx 仓根目录；读不到返回 undefined。
 * @returns {string | undefined} memx 仓根目录。
 */
function readMemxRoot() {
  try {
    return /const MEMX_ROOT = "([^"]+)"/.exec(readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'))?.[1]
  } catch {
    return undefined
  }
}

const memxRoot = readMemxRoot()
const hasMemx = memxRoot !== undefined && existsSync(join(memxRoot, 'src/hosts/dsh/index.ts'))

test('smoke：设置项 schema 四字段齐全且全 volatile', async () => {
  const { checks } = await run()
  const config = checks.find((item) => item.name === 'config-schema')
  assert.equal(config?.ok, true, config?.detail)
})

test('smoke：load 钩子能解析 memx 模块、记忆目录路径正确', { skip: !hasMemx }, async () => {
  const { ok, checks } = await run()
  assert.equal(ok, true, JSON.stringify(checks, null, 2))
  assert.deepEqual(checks.map((item) => item.name), ['memx-module', 'config-schema', 'memory-dir'])
})
