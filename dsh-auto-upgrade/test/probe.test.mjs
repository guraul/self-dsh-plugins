import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  PROBE_TTL_MS,
  buildProbeCommands,
  cacheHit,
  judgeProbe,
  linkTargets,
  probeHasPlugin,
  probeKey,
  runProbes,
} from '../lib/host/probe.js'

test('linkTargets 只挑 link:/file:，npm 装的不进试装清单', () => {
  assert.deepEqual(linkTargets({
    'a-plugin': 'link:/repo/a',
    'b-plugin': 'file:./b',
    'npm-one': '^1.2.3',
  }), [{ name: 'a-plugin', path: '/repo/a' }, { name: 'b-plugin', path: './b' }])
})

test('buildProbeCommands 用 argv 形态，不拼 shell 字符串', () => {
  const commands = buildProbeCommands({ dshBin: '/opt/dsh', pluginPath: '/repo/a', profileName: 'probe' })
  assert.deepEqual(commands.add, ['/opt/dsh', 'plugin', '--profile', 'probe', 'add', '/repo/a'])
  assert.deepEqual(commands.dump, ['/opt/dsh', '--profile', 'probe', '--dump-config'])
})

test('probeHasPlugin 只认 id 行，不被前缀或顺序 add 骗到', () => {
  const dump = 'plugins:\n  - id: dsh-awake\n  - id: dsh-awake-extras\n'
  assert.equal(probeHasPlugin(dump, 'dsh-awake'), true)
  assert.equal(probeHasPlugin(dump, 'dsh-awak'), false, '前缀不算命中')
  assert.equal(probeHasPlugin(dump, 'dsh-plugin-auto-upgrade'), false)
  assert.equal(probeHasPlugin('', 'dsh-awake'), false)
  assert.equal(probeHasPlugin('  - id: "dsh-awake"\n', 'dsh-awake'), true, '带引号也算')
})

test('judgeProbe：两条判据都过才算装配通过（表驱动）', () => {
  const cases = [
    [{ addExit: 1, dumpExit: 0, dumpText: 'x', pluginName: 'dsh-awake' }, false, /plugin add 退出码 1/],
    [{ addExit: 0, dumpExit: 2, dumpText: '', pluginName: 'dsh-awake' }, false, /--dump-config 退出码 2/],
    [{ addExit: 0, dumpExit: 0, dumpText: 'plugins:\n  - id: other\n', pluginName: 'dsh-awake' }, false, /没有该插件/],
    [{ addExit: 0, dumpExit: 0, dumpText: '- id: dsh-awake\n', pluginName: 'dsh-awake' }, true, /装配通过/],
  ]
  for (const [input, ok, detail] of cases) {
    const verdict = judgeProbe(input)
    assert.equal(verdict.ok, ok, JSON.stringify(input))
    assert.match(verdict.detail, detail)
  }
})

test('cacheHit 按 TTL 判定，过期与未来时间戳都不算新鲜', () => {
  const now = 1_000_000_000
  assert.equal(cacheHit(undefined, now), false)
  assert.equal(cacheHit({ at: now - 1000, ok: true }, now), true)
  assert.equal(cacheHit({ at: now - PROBE_TTL_MS - 1, ok: false }, now), false, '过期')
  assert.equal(cacheHit({ at: now + 5000, ok: true }, now), false, '未来时间戳（时钟被改）')
  assert.equal(cacheHit({ at: Number.NaN, ok: true }, now), false, '坏条目')
})

/** 造一个只关心「跑了几次 / 返回什么」的执行器。 */
function fakeRunner(respond) {
  const calls = []
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options.env })
    return respond(args)
  }
  return { calls, run }
}

test('runProbes：命中缓存不重新试装（mtime 变了才重跑）', async () => {
  const now = 1_000_000
  const fresh = probeKey({ targetVersion: 'v', name: 'p', mtimeMs: 42 })
  const stale = probeKey({ targetVersion: 'v', name: 'p', mtimeMs: 41 })
  const { run, calls } = fakeRunner(() => ({ status: 0, stdout: '- id: p\n' }))

  const hit = await runProbes({
    targets: [{ name: 'p', path: '/x/p', mtimeMs: 42 }], targetVersion: 'v', dshBin: '/dsh',
    profileName: 'probe', dshHome: '/tmp/h', cache: { [fresh]: { at: now, ok: true, detail: '装配通过' } },
    now, run,
  })
  assert.equal(calls.length, 0, '缓存命中时不许再 spawn')
  assert.deepEqual(hit.results, [{ name: 'p', ok: true, detail: '装配通过', cached: true }])

  const miss = await runProbes({
    targets: [{ name: 'p', path: '/x/p', mtimeMs: 42 }], targetVersion: 'v', dshBin: '/dsh',
    profileName: 'probe', dshHome: '/tmp/h', cache: { [stale]: { at: now, ok: true, detail: '旧结论' } },
    now, run,
  })
  assert.equal(calls.length, 2, 'mtime 变了必须重跑（改过 bundler 配置不能当旧的）')
  assert.equal(miss.results[0].cached, false)
})

test('runProbes：add 失败就不再 dump，且成功失败都进缓存', async () => {
  const now = 1_000_000
  const { run, calls } = fakeRunner((args) => (args[0] === 'plugin'
    ? { status: args[args.length - 1].endsWith('bad') ? 1 : 0, stdout: '' }
    : { status: 0, stdout: '- id: good\n' }))
  const { results, cache } = await runProbes({
    targets: [{ name: 'good', path: '/x/good', mtimeMs: 1 }, { name: 'bad', path: '/x/bad', mtimeMs: 2 }],
    targetVersion: 'v', dshBin: '/dsh', profileName: 'probe', dshHome: '/tmp/h', cache: {}, now, run,
  })
  assert.equal(calls.length, 3, 'good 两条命令 + bad 只有 add')
  assert.equal(calls[0].env.DSH_HOME, '/tmp/h', '每条命令都必须带一次性 DSH_HOME')
  assert.deepEqual(results.map((item) => item.ok), [true, false])
  assert.match(results[1].detail, /plugin add 退出码 1/)
  assert.equal(Object.keys(cache).length, 2, '失败也缓存，避免反复重试同一个坏插件')
})

test('宿主侧助手不能漏导入（漏了 `run` 会静默失效——#300 的真实 blocker）', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  const names = (module) => {
    const matched = new RegExp(`import \\{([^}]*)\\} from '\\./host/${module}\\.js'`).exec(source)
    assert.ok(matched, `必须从 ${module}.js 导入`)
    return matched[1].split(',').map((item) => item.trim())
  }
  assert.ok(names('toolchain').includes('run'), 'probe 路由要用 run 执行 dsh')
  assert.ok(names('probe').includes('cacheHit'), 'GET 要用 cacheHit 标 stale')
  assert.ok(names('probe').includes('runProbes'), 'POST 要用 runProbes 驱动')
})
