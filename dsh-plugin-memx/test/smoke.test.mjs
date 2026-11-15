/**
 * `smoke.mjs` 的自测：保证冒烟断言不会因为夹具写坏而静默变绿。
 *
 * `config-schema` 只依赖本包的构建产物，任何机器都跑；`memx-module` / `memory-dir`
 * 需要本机的 memx 仓（`lib/index.js` 里硬编码的 `MEMX_ROOT`），CI 上没有就跳过。
 *
 * 「跳过」本身也要有测试：`run({ memxRoot })` 能覆盖 memx 仓位置，于是用临时目录
 * 造出「父目录不存在」（= CI）与「父目录在、入口缺失」（= 真漂移）两种环境。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

test('smoke：memx 父目录不存在（CI）→ memx-module 记 skipped 而不是失败', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'memx-smoke-absent-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  // 父目录（`<base>/no-parent`）不存在，模拟 CI 上根本没有 memx 源码的环境。
  const ghostRoot = join(base, 'no-parent', 'memx')

  const { checks } = await run({ memxRoot: ghostRoot })
  const module = checks.find((item) => item.name === 'memx-module')
  const memory = checks.find((item) => item.name === 'memory-dir')
  assert.equal(module?.ok, true, module?.detail)
  assert.match(module?.detail ?? '', /skipped/, 'detail 必须写明 skipped，不能假装验证过')
  assert.equal(memory?.ok, true, memory?.detail)
  assert.match(memory?.detail ?? '', /skipped/)
})

test('smoke：父目录在但 memx 入口缺失 → memx-module 必须红（真漂移）', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'memx-smoke-drift-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  // 父目录（`base`）存在，`<base>/memx/src/hosts/dsh/index.ts` 不存在。
  const driftRoot = join(base, 'memx')

  const { ok, checks } = await run({ memxRoot: driftRoot })
  const module = checks.find((item) => item.name === 'memx-module')
  assert.equal(module?.ok, false, '入口缺失是路径漂移，不能被当成环境缺失放行')
  assert.match(module?.detail ?? '', /漂移/)
  assert.equal(ok, false)
})
