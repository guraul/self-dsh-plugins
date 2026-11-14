/**
 * `smoke.mjs` 的自测：保证冒烟本身不会因为夹具/断言写坏而静默变绿。
 *
 * 纯断言在任何机器上都要跑；`host-load` 需要本机安装的 dsh，CI 上没有就跳过——
 * 冒烟只在宿主进程里跑，那里 `ctx.dshDir` 一定可见。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { run } from '../smoke.mjs'

/**
 * 找本机全局安装的 dsh 包目录；找不到返回 undefined（CI）。
 * @returns {string | undefined} `@deepseek-ai/dsh` 包目录。
 */
function findDshDir() {
  try {
    const bin = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
    let dir = dirname(bin)
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    return undefined
  }
  return undefined
}

const dshDir = findDshDir()
const dshVersion = dshDir === undefined ? undefined : JSON.parse(readFileSync(join(dshDir, 'package.json'), 'utf8')).version

test('smoke：start / stop 幂等与路由形状通过', async () => {
  const { checks } = await run()
  const byName = new Map(checks.map((item) => [item.name, item]))
  for (const name of ['start-idempotent', 'stop-idempotent', 'route-shape']) {
    assert.equal(byName.get(name)?.ok, true, byName.get(name)?.detail)
  }

  // 没有宿主事实时 host-load 必须红着说清楚，不能假装验过。
  assert.equal(byName.get('host-load')?.ok, false)
  assert.match(byName.get('host-load')?.detail ?? '', /ctx\.dshDir/)
})

test('smoke：用本机 dsh 真的加载插件', { skip: dshDir === undefined }, async () => {
  const { ok, checks } = await run({ dshDir, dshVersion })
  assert.equal(ok, true, JSON.stringify(checks, null, 2))
  assert.deepEqual(checks.map((item) => item.name), ['start-idempotent', 'stop-idempotent', 'route-shape', 'host-load'])
})
