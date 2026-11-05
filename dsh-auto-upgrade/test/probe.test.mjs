import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROBE_TTL_MS,
  probeHasPlugin,
  buildProbeCommands,
  cacheHit,
  judgeProbe,
  linkTargets,
  probeKey,
  runProbes,
} from '../lib/host/probe.js'

test('linkTargets 只挑本机路径型插件，npm 装的不进试装清单', () => {
  const targets = linkTargets({
    'dsh-plugin-auto-upgrade': 'link:/Users/me/repo/dsh-auto-upgrade',
    'dsh-im-bridge-workspaces': 'file:./local/im-bridge',
    '@scope/npm-plugin': '^1.2.3',
    'another-npm': '1.0.0',
  })
  assert.deepEqual(targets, [
    { name: 'dsh-plugin-auto-upgrade', path: '/Users/me/repo/dsh-auto-upgrade' },
    { name: 'dsh-im-bridge-workspaces', path: './local/im-bridge' },
  ])
})

test('buildProbeCommands 用 argv 形态，不拼 shell 字符串', () => {
  const commands = buildProbeCommands({
    dshBin: '/opt/dsh/bin/dsh',
    pluginPath: '/Users/me/repo/dsh-awake',
    profileName: 'probe',
  })
  assert.deepEqual(commands.add, [
    '/opt/dsh/bin/dsh', 'plugin', '--profile', 'probe', 'add', '/Users/me/repo/dsh-awake',
  ])
  assert.deepEqual(commands.dump, ['/opt/dsh/bin/dsh', '--profile', 'probe', '--dump-config'])
})

test('judgeProbe：两条判据都过才算装配通过（表驱动）', () => {
  const cases = [
    [{ addExit: 1, dumpExit: 0, dumpText: 'x', pluginName: 'dsh-awake' }, false, /plugin add 退出码 1/],
    [{ addExit: 0, dumpExit: 2, dumpText: '', pluginName: 'dsh-awake' }, false, /--dump-config 退出码 2/],
    [{ addExit: 0, dumpExit: 0, dumpText: 'plugins: [other]', pluginName: 'dsh-awake' }, false, /没有该插件/],
    [{ addExit: 0, dumpExit: 0, dumpText: 'plugins:\n  - id: dsh-awake\n', pluginName: 'dsh-awake' }, true, /装配通过/],
  ]
  for (const [input, ok, detail] of cases) {
    const verdict = judgeProbe(input)
    assert.equal(verdict.ok, ok, JSON.stringify(input))
    assert.match(verdict.detail, detail)
  }
})

test('cacheHit 按 TTL 判定，过期就重试', () => {
  const now = 1_000_000_000
  assert.equal(cacheHit(undefined, now), false, '没有条目')
  assert.equal(cacheHit({ at: now - 1000, ok: true }, now), true, '新鲜')
  assert.equal(cacheHit({ at: now - PROBE_TTL_MS + 1, ok: true }, now), true, '刚好在有效期内')
  assert.equal(cacheHit({ at: now - PROBE_TTL_MS - 1, ok: false }, now), false, '过期')
  assert.equal(cacheHit({ at: Number.NaN, ok: true }, now), false, '坏条目不当缓存')
})

test('runProbes：命中缓存不重新试装', async () => {
  const now = 1_000_000
  const key = probeKey({ targetVersion: '0.2.2-rc.1', name: 'p', mtimeMs: 42 })
  let calls = 0
  const { results, cache } = await runProbes({
    targets: [{ name: 'p', path: '/x/p', mtimeMs: 42 }],
    targetVersion: '0.2.2-rc.1',
    dshBin: '/dsh',
    profileName: 'probe',
    dshHome: '/tmp/h',
    cache: { [key]: { at: now - 1000, ok: true, detail: '装配通过' } },
    now,
    run: async () => {
      calls += 1
      return { status: 0, stdout: '' }
    },
  })
  assert.equal(calls, 0, '缓存命中时不许再 spawn')
  assert.deepEqual(results, [{ name: 'p', ok: true, detail: '装配通过', cached: true }])
  assert.equal(cache[key].ok, true)
})

test('runProbes：未命中就真跑两条命令并写回缓存（失败也缓存）', async () => {
  const now = 1_000_000
  const seen = []
  const { results, cache } = await runProbes({
    targets: [
      { name: 'good', path: '/x/good', mtimeMs: 1 },
      { name: 'bad', path: '/x/bad', mtimeMs: 2 },
    ],
    targetVersion: '0.2.2-rc.1',
    dshBin: '/dsh',
    profileName: 'probe',
    dshHome: '/tmp/h',
    cache: {},
    now,
    run: async (command, args, options) => {
      seen.push([args.slice(0, 4).join(' '), options.env.DSH_HOME])
      // 注意：run(command, args) 的 args 不含可执行文件本身。
      const isAdd = args[0] === 'plugin'
      const which = args[args.length - 1]
      if (isAdd) return { status: which.endsWith('bad') ? 1 : 0, stdout: '' }
      return { status: 0, stdout: '- id: good\n' }
    },
  })
  assert.equal(seen.length, 3, 'good 两条命令 + bad 只有 add（add 失败不再 dump）')
  assert.equal(seen[0][1], '/tmp/h', '每条命令都必须带一次性 DSH_HOME')
  assert.deepEqual(results.map((item) => item.ok), [true, false])
  assert.equal(results[0].cached, false)
  assert.match(results[1].detail, /plugin add 退出码 1/)
  assert.equal(Object.keys(cache).length, 2, '成功与失败都进缓存，避免反复重试同一个坏插件')
  assert.equal(cache[probeKey({ targetVersion: '0.2.2-rc.1', name: 'bad', mtimeMs: 2 })].ok, false)
})

test('runProbes：插件目录 mtime 变了就重新试装（缓存键含 mtime）', async () => {
  const now = 1_000_000
  const staleKey = probeKey({ targetVersion: '0.2.2-rc.1', name: 'p', mtimeMs: 41 })
  let calls = 0
  const { results } = await runProbes({
    targets: [{ name: 'p', path: '/x/p', mtimeMs: 42 }],
    targetVersion: '0.2.2-rc.1',
    dshBin: '/dsh',
    profileName: 'probe',
    dshHome: '/tmp/h',
    cache: { [staleKey]: { at: now, ok: true, detail: '装配通过' } },
    now,
    run: async () => {
      calls += 1
      return { status: 0, stdout: '- id: p\n' }
    },
  })
  assert.equal(calls, 2, 'mtime 变了必须重跑（否则改了 bundler 配置也当旧的）')
  assert.equal(results[0].cached, false)
})

test('probeHasPlugin 只认 id 行，不被「名字是前缀」或顺序 add 骗到', () => {
  const dump = 'plugins:\n  - id: dsh-awake\n  - id: dsh-awake-extras\n'
  assert.equal(probeHasPlugin(dump, 'dsh-awake'), true)
  assert.equal(probeHasPlugin(dump, 'dsh-awak'), false, '前缀不算命中')
  assert.equal(probeHasPlugin(dump, 'dsh-plugin-auto-upgrade'), false)
  assert.equal(probeHasPlugin('', 'dsh-awake'), false)
  assert.equal(probeHasPlugin('  - id: "dsh-awake"\n', 'dsh-awake'), true, '带引号也算')
})

test('宿主侧助手不能漏导入（#300 的 blocker 回归：漏了 `run` 会静默失效）', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  const toolchain = /import \{([^}]*)\} from '\.\/host\/toolchain\.js'/.exec(source)
  const probe = /import \{([^}]*)\} from '\.\/host\/probe\.js'/.exec(source)
  assert.ok(toolchain, '必须从 toolchain.js 导入');
  assert.ok(probe, '必须从 probe.js 导入')
  const names = (match) => match[1].split(',').map((item) => item.trim())
  assert.ok(names(toolchain).includes('run'), 'probe 路由要用 run 执行 dsh')
  assert.ok(names(probe).includes('cacheHit'), 'GET 要用 cacheHit 标 stale')
  assert.ok(names(probe).includes('runProbes'), 'POST 要用 runProbes 驱动')
})
