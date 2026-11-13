import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SMOKE_TIMEOUT_MS,
  collectLoaderNames,
  createInjectResolver,
  fallbackChecks,
  normalizeSmoke,
  officialInjectSeeds,
  platformSeedsFromStaticModules,
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

test('fallbackChecks：启用优先看运行中的 Loader，缺省回退 profile bundles', () => {
  // cordis.patch.yml insert 的行不在 bundles 里，但 Loader 里活着——必须算通过。
  const inserted = fallbackChecks({
    name: 'p', bundles: [], enabled: ['p'], pluginDirExists: true, inject: [], resolvable: resolvableAll,
  })
  assert.equal(inserted[0].ok, true)
  assert.match(inserted[0].detail, /运行中 Loader 里已启用/)

  // Set 也接受。
  const fromSet = fallbackChecks({
    name: 'p', bundles: [], enabled: new Set(['p']), pluginDirExists: true, inject: [], resolvable: resolvableAll,
  })
  assert.equal(fromSet[0].ok, true)

  // Loader 里没有 = 真没启用，即便 bundles 里写着也要红。
  const disabled = fallbackChecks({
    name: 'p', bundles: ['p'], enabled: [], pluginDirExists: true, inject: [], resolvable: resolvableAll,
  })
  assert.equal(disabled[0].ok, false)
  assert.match(disabled[0].detail, /未在运行中的 Loader 里启用/)

  // 没给 enabled 时行为与旧版一致。
  const fallback = fallbackChecks({
    name: 'p', bundles: ['p'], pluginDirExists: true, inject: [], resolvable: resolvableAll,
  })
  assert.equal(fallback[0].ok, true)
  assert.match(fallback[0].detail, /dsh\.profile\.bundles 里启用/)
})

test('fallbackChecks：注入项解析不出时，种子表不可读只降级为「未判定」', () => {
  const unknown = fallbackChecks({
    name: 'p', bundles: ['p'], pluginDirExists: true, inject: ['ui-slots'],
    resolvable: () => 'unknown',
  })
  assert.equal(unknown[2].ok, true)
  assert.match(unknown[2].detail, /未解析到 ui-slots/)
  assert.match(unknown[2].detail, /未判定/)

  const missing = fallbackChecks({
    name: 'p', bundles: ['p'], pluginDirExists: true, inject: ['gone'],
    resolvable: () => false,
  })
  assert.equal(missing[2].ok, false)
})

test('collectLoaderNames：函数形 entries（真实 dsh 0.2.2-rc.2 的 generator 形态）', () => {
  // cordis-plugin-loader 的 EntryTree.*entries() 是 generator；对接线本身做单测。
  const loader = {
    entries() {
      return (function* () {
        yield { options: { name: 'a' } }
        yield { options: { name: 'b' } }
      })()
    },
  }
  assert.deepEqual(collectLoaderNames(loader), ['a', 'b'])
})

test('collectLoaderNames：数组形 / 可迭代 entries 也能取（兼容性兜底）', () => {
  assert.deepEqual(
    collectLoaderNames({ entries: [{ options: { name: 'arr' } }] }),
    ['arr'],
  )
  assert.deepEqual(
    collectLoaderNames({ entries: new Set([{ options: { name: 'set' } }]) }),
    ['set'],
  )
  assert.deepEqual(
    collectLoaderNames({ entries: [{ options: { name: 'iter' } }][Symbol.iterator]() }),
    ['iter'],
  )
})

test('collectLoaderNames：缺 loader / 缺 entries / entries 抛错——都返回 undefined', () => {
  assert.equal(collectLoaderNames(undefined), undefined)
  assert.equal(collectLoaderNames(null), undefined)
  assert.equal(collectLoaderNames('loader'), undefined)
  assert.equal(collectLoaderNames({}), undefined)
  assert.equal(collectLoaderNames({ entries: 42 }), undefined)
  assert.equal(collectLoaderNames({
    entries() {
      throw new Error('loader 服务坏了')
    },
  }), undefined)
  // 迭代到一半抛错也不能漏出来。
  assert.equal(collectLoaderNames({
    entries: {
      [Symbol.iterator]() {
        throw new Error('坏了')
      },
    },
  }), undefined)
})

test('collectLoaderNames：空列表返回 undefined（回退 bundles，不能当成全部未启用）', () => {
  assert.equal(collectLoaderNames({ entries: () => [] }), undefined)
  assert.equal(collectLoaderNames({ entries: [] }), undefined)
})

test('collectLoaderNames：过滤 disabled 与没有 name 的条目', () => {
  const loader = {
    entries: [
      { options: { name: 'on' } },
      { options: { name: 'off' }, disabled: true },
      { options: { name: 'also-on' }, disabled: false },
      { options: {} },
      { options: { name: '' } },
      { options: { name: 42 } },
      { },
      null,
    ],
  }
  assert.deepEqual(collectLoaderNames(loader), ['on', 'also-on'])
})

test('platformSeedsFromStaticModules：从 staticModules 表里取出平台内置模块名', () => {
  const fixture = [
    'function WJ(){return{react:rS,"react/jsx-runtime":aS,"react-dom":fS,"react-dom/client":mS,',
    '"@deepseek-ai/cordis":jC,zod:tN,"@tanstack/react-virtual":cN,',
    '"@deepseek-ai/dsh-client-ui-slots":RN,"@deepseek-ai/dsh-client-ui-primitives":MK}}',
  ].join('')
  const seeds = platformSeedsFromStaticModules(fixture)
  assert.deepEqual(seeds, [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    'zod',
    '@tanstack/react-virtual',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ])
})

test('platformSeedsFromStaticModules：锚点缺失 / 花括号不配对时返回 undefined，不抛错', () => {
  assert.equal(platformSeedsFromStaticModules('const x = {"zod": z}'), undefined)
  assert.equal(platformSeedsFromStaticModules('{ "react-dom/client": m '), undefined)
  assert.equal(platformSeedsFromStaticModules(undefined), undefined)
})

test('platformSeedsFromStaticModules：锚点在、但缺 react / react-dom/client 时按没解析到处理', () => {
  // 打包产物里 `"react-dom/client":` 不止一处；撞到别的对象时不能置 seedsKnown=true。
  assert.equal(platformSeedsFromStaticModules('{"react-dom/client":mS,"zod":tN}'), undefined)
  assert.equal(platformSeedsFromStaticModules('{"react":rS,"zod":tN}'), undefined)
})

test('officialInjectSeeds：只认官方行，自定义行自己 inject 的未知名字不能变种子', () => {
  // 安装树里真实存在的包（ui-slots / ui-primitives 这类种子模块不在 npm 安装树里）。
  const installTree = new Set([
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-modules',
  ])
  const official = (pkg) => installTree.has(pkg)
  const graph = [
    { id: '@deepseek-ai/dsh-client-ui-renderer', inject: ['@deepseek-ai/dsh-client-ui-slots', 'react', '@deepseek-ai/dsh-client-modules'] },
    { id: 'my-plugin', inject: ['custom-internal-name'] },
  ]
  const seeds = officialInjectSeeds(graph, official)
  assert.deepEqual(seeds, ['@deepseek-ai/dsh-client-ui-slots', 'react'])
})

test('createInjectResolver：图行 / 包 / 种子 / unknown / 真缺失', () => {
  const packageExists = (pkg) => pkg === 'installed-pkg'
  const resolver = createInjectResolver({
    graphIds: ['graph-row'],
    packageExists,
    seeds: ['platform-seed'],
    seedsKnown: false,
  })
  assert.equal(resolver('graph-row'), true)
  assert.equal(resolver('installed-pkg'), true)
  assert.equal(resolver('platform-seed'), true)
  assert.equal(resolver('mystery'), 'unknown')

  const known = createInjectResolver({
    graphIds: [],
    packageExists,
    seeds: [],
    seedsKnown: true,
  })
  assert.equal(known('mystery'), false)
})

test('createInjectResolver：安装树 ∪ profile 的组合谓词（真实临时目录）', async (t) => {
  const installDir = await mkdtemp(join(tmpdir(), 'dsh-au-install-'))
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-au-profile-'))
  t.after(async () => {
    await rm(installDir, { recursive: true, force: true })
    await rm(profileDir, { recursive: true, force: true })
  })
  await mkdir(join(installDir, 'node_modules', 'only-in-install'), { recursive: true })
  await mkdir(join(profileDir, 'node_modules', '@scope', 'only-in-profile'), { recursive: true })

  // 与 lib/index.js 里的 packageExists 同形：安装树 ∪ profile。
  const packageExists = (pkg) =>
    existsSync(join(installDir, 'node_modules', pkg)) || existsSync(join(profileDir, 'node_modules', pkg))
  const resolver = createInjectResolver({ graphIds: [], packageExists, seeds: [], seedsKnown: true })

  assert.equal(resolver('only-in-install'), true, '只装在安装树的包必须能解析')
  assert.equal(resolver('@scope/only-in-profile'), true, '只装在 profile 的包必须能解析')
  assert.equal(resolver('nowhere'), false, '两处都没有的包在 seedsKnown=true 时判缺失')
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
