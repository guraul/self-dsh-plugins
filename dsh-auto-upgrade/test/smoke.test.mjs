import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SMOKE_TIMEOUT_MS,
  fallbackChecks,
  normalizeSmoke,
  runSmoke,
  runSmokes,
} from '../lib/host/smoke.js'

const resolvableAll = () => true

test('fallbackChecks：三项全过才算兜底通过', () => {
  const checks = fallbackChecks({
    name: 'p', bundles: ['p'], pluginDirExists: true, inject: ['a', 'b'], resolvable: resolvableAll,
  })
  assert.deepEqual(checks.map((check) => check.ok), [true, true, true])
})

test('fallbackChecks：没启用 / 目录没了 / 注入包缺——各自单独报红', () => {
  const notBundled = fallbackChecks({ name: 'p', bundles: [], pluginDirExists: true, inject: [], resolvable: resolvableAll })
  assert.equal(notBundled[0].ok, false)
  assert.match(notBundled[0].detail, /没被 profile 启用/)

  const noDir = fallbackChecks({ name: 'p', bundles: ['p'], pluginDirExists: false, inject: [], resolvable: resolvableAll })
  assert.equal(noDir[1].ok, false)

  const missing = fallbackChecks({
    name: 'p', bundles: ['p'], pluginDirExists: true, inject: ['a', 'gone'],
    resolvable: (pkg) => pkg !== 'gone',
  })
  assert.equal(missing[2].ok, false)
  assert.match(missing[2].detail, /gone/)
})

test('normalizeSmoke：脏数据一律按失败处理，不许静默当通过', () => {
  assert.equal(normalizeSmoke(null).ok, false)
  assert.equal(normalizeSmoke('ok').ok, false)
  assert.equal(normalizeSmoke({ ok: false }).ok, false)
  // ok:true 但有一项 check 失败 → 整体失败
  const inconsistent = normalizeSmoke({ ok: true, checks: [{ name: 'x', ok: false }] })
  assert.equal(inconsistent.ok, false)
  assert.match(inconsistent.detail, /有检查项失败/)
  assert.equal(normalizeSmoke({ ok: true, checks: [{ name: 'x', ok: true }] }).ok, true)
})

test('runSmoke：没写 dsh.smoke 的插件只跑兜底三项，并标 partial（不假装验过行为）', async () => {
  const result = await runSmoke({
    plugin: { name: 'p', dirExists: true, inject: [] },
    bundles: ['p'],
    resolvable: resolvableAll,
    importModule: async () => {
      throw new Error('不该被调用')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.equal(result.checks.length, 3)
  assert.match(result.detail, /没有 dsh\.smoke/)
})

test('runSmoke：自报断言与兜底三项合并，任一失败即整体失败', async () => {
  const pass = await runSmoke({
    plugin: { name: 'p', dirExists: true, inject: [], smoke: { module: './smoke.mjs' } },
    bundles: ['p'],
    resolvable: resolvableAll,
    importModule: async (_plugin, modulePath) => {
      assert.equal(modulePath, './smoke.mjs')
      return { run: async () => ({ ok: true, checks: [{ name: '行为', ok: true }] }) }
    },
  })
  assert.equal(pass.ok, true)
  assert.equal(pass.partial, false)
  assert.equal(pass.checks.length, 4)

  const fail = await runSmoke({
    plugin: { name: 'p', dirExists: true, inject: [], smoke: { module: './smoke.mjs' } },
    bundles: ['p'],
    resolvable: resolvableAll,
    importModule: async () => ({ run: async () => ({ ok: false, checks: [{ name: '行为', ok: false, detail: '坏了' }] }) }),
  })
  assert.equal(fail.ok, false)
  assert.equal(fail.checks.at(-1).detail, '坏了')
})

test('runSmoke：模块抛错 / 没有 run / 超时——都按失败记，不带崩整批', async () => {
  const broken = await runSmoke({
    plugin: { name: 'p', dirExists: true, inject: [], smoke: { module: './x.mjs' } },
    bundles: ['p'],
    resolvable: resolvableAll,
    importModule: async () => {
      throw new Error('import 失败：ENOENT')
    },
  })
  assert.equal(broken.ok, false)
  assert.match(broken.detail, /ENOENT/)

  const noRun = await runSmoke({
    plugin: { name: 'p', dirExists: true, inject: [], smoke: { module: './x.mjs' } },
    bundles: ['p'],
    resolvable: resolvableAll,
    importModule: async () => ({}),
  })
  assert.equal(noRun.ok, false)
  assert.match(noRun.detail, /没有导出 run/)

  const slow = await runSmoke({
    plugin: { name: 'p', dirExists: true, inject: [], smoke: { module: './x.mjs', timeoutMs: 20 } },
    bundles: ['p'],
    resolvable: resolvableAll,
    importModule: async () => ({ run: () => new Promise(() => {}) }),
  })
  assert.equal(slow.ok, false)
  assert.match(slow.detail, /冒烟超时/)
  assert.ok(SMOKE_TIMEOUT_MS >= 1000, '线上默认超时要给插件留出余量')
})

test('runSmokes：串行跑，顺序与入参一致', async () => {
  const order = []
  const { results } = await runSmokes({
    plugins: [{ name: 'a', dirExists: true, inject: [] }, { name: 'b', dirExists: true, inject: [] }],
    bundles: ['a', 'b'],
    resolvable: resolvableAll,
    importModule: async () => ({}),
  })
  order.push(...results.map((item) => item.name))
  assert.deepEqual(order, ['a', 'b'])
  assert.deepEqual(results.map((item) => item.partial), [true, true])
})
