import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  PROBE_CACHE_SCHEMA,
  PROBE_TTL_MS,
  idsFromDump,
  probeCacheEntries,
  buildProbeCommands,
  entryCandidates,
  pluginIdFromSource,
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
    // 差集为空 → 没进 profile
    [{ addExit: 0, dumpExit: 0, dumpText: '- id: other\n', pluginName: 'x', beforeIds: new Set(['other']), afterIds: new Set(['other']) }, false, /没有新增插件/],
    // 差集非空 → 通过
    [{ addExit: 0, dumpExit: 0, dumpText: '- id: other\n- id: dsh-awake\n', pluginName: 'x', beforeIds: new Set(['other']), afterIds: new Set(['other', 'dsh-awake']) }, true, /装配通过/],
    // 没有基线 → 不下结论
    [{ addExit: 0, dumpExit: 0, dumpText: '- id: dsh-awake\n', pluginName: 'dsh-awake' }, false, /无法判定/],
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
  assert.deepEqual(hit.results, [{ name: 'p', id: 'p', idFallback: true, ok: true, detail: '装配通过', cached: true }])

  const miss = await runProbes({
    targets: [{ name: 'p', path: '/x/p', mtimeMs: 42 }], targetVersion: 'v', dshBin: '/dsh',
    profileName: 'probe', dshHome: '/tmp/h', cache: { [stale]: { at: now, ok: true, detail: '旧结论' } },
    now, run,
  })
  assert.equal(calls.length, 3, 'mtime 变了必须重跑：add 前 dump + add + add 后 dump')
  assert.equal(miss.results[0].cached, false)
})

test('runProbes：add 失败就不再 dump，且成功失败都进缓存', async () => {
  const now = 1_000_000
  // dump 要能体现「add 前后」：装之前只有 other，装之后多出 good（差集判据）。
  let added = false
  const { run, calls } = fakeRunner((args) => {
    if (args[0] === 'plugin') {
      if (args[args.length - 1].endsWith('bad')) return { status: 1, stdout: '' }
      added = true
      return { status: 0, stdout: '' }
    }
    return { status: 0, stdout: added ? '- id: other\n- id: good\n' : '- id: other\n' }
  })
  const { results, cache } = await runProbes({
    targets: [{ name: 'good', path: '/x/good', mtimeMs: 1 }, { name: 'bad', path: '/x/bad', mtimeMs: 2 }],
    targetVersion: 'v', dshBin: '/dsh', profileName: 'probe', dshHome: '/tmp/h', cache: {}, now, run,
  })
  assert.equal(calls.length, 5, 'good: dump+add+dump；bad: dump+add（add 失败就不再 dump）')
  assert.equal(calls[0].env.DSH_HOME, '/tmp/h', '每条命令都必须带一次性 DSH_HOME')
  assert.deepEqual(results.map((item) => item.ok), [true, false])
  assert.match(results[1].detail, /plugin add 退出码 1/)
  assert.equal(Object.keys(cache).length, 2, '失败也缓存，避免反复重试同一个坏插件')
})

test('探针路由用到的助手都已导入（漏了 `run` 会静默失效——#300 的真实 blocker）', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // `cacheHit` 在 #359 之后不再由 index.js 直接用（改走 `probeCacheEntries`），列表跟着换。
  // #421 起试装执行器搬进 `preflight-run.js`，与 index 的接线分别校验。
  for (const name of ['run', 'probeCacheEntries']) {
    assert.match(source, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./host/`), `缺少 ${name} 的导入`)
  }
  const runner = await readFile(new URL('../lib/host/preflight-run.js', import.meta.url), 'utf8')
  for (const name of ['runProbes', 'linkTargets', 'runProbeWithProfile']) {
    assert.match(runner, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./`), `缺少 ${name} 的导入`)
  }
})

test('#346 插件 id 从模块导出的 name 解析：覆盖常见导出写法，且先剥注释', () => {
  const cases = [
    ["export const name = 'a'", 'a'],
    ['export const name = "b"', 'b'],
    ["module.exports.name = 'c'", 'c'],
    ["exports['name'] = 'd'", 'd'],
    ["module.exports = { name: 'e' }", 'e'],
    ['export default { name: "f" }', 'f'],
    ["definePlugin({ name: 'g' })", 'g'],
    ["// module.exports.name = 'old'\nexport const name = 'real'", 'real', '注释里的旧写法不能抢先命中'],
  ]
  for (const [source, expected, why] of cases) {
    assert.equal(pluginIdFromSource(source), expected, why ?? source)
  }
  assert.equal(pluginIdFromSource('export const other = 1'), undefined, '没写 name 就是没写')
  assert.equal(pluginIdFromSource(undefined), undefined)
})

test('#346 真实插件入口能解析出 id（不是循环自证：读的是仓库里真文件）', async () => {
  const root = join(import.meta.dirname, '..', '..')
  const cases = [
    ['dsh-auto-upgrade/lib/index.js', 'dsh-auto-upgrade'],
    ['dsh-awake/lib/index.js', 'dsh-awake'],
    ['dsh-im-bridge-workspaces/src/index.ts', 'im-bridge'],
  ]
  for (const [file, expected] of cases) {
    const source = await readFile(join(root, file), 'utf8')
    assert.equal(pluginIdFromSource(source), expected, `${file} 的 id 应是 ${expected}`)
  }
})

test('#346 入口候选按 exports → main → 约定路径，且认 import/require 条件', () => {
  assert.equal(entryCandidates({ exports: './dist/index.js' })[0], './dist/index.js')
  assert.equal(entryCandidates({ exports: { '.': './lib/main.mjs' } })[0], './lib/main.mjs')
  assert.equal(entryCandidates({ exports: { '.': { default: './dist/x.js' } } })[0], './dist/x.js')
  assert.equal(entryCandidates({ exports: { '.': { import: './esm.mjs' } } })[0], './esm.mjs')
  assert.equal(entryCandidates({ exports: { '.': { require: './cjs.js' } } })[0], './cjs.js')
  assert.equal(entryCandidates({ main: 'lib/index.js' })[0], 'lib/index.js')
  assert.ok(entryCandidates({}).includes('lib/index.js'), '没有声明也要有约定路径兜底')
})

test('#346 缓存 key 带 schema 版本：判定逻辑一改，旧结论全部失效', () => {
  const key = probeKey({ targetVersion: 'v', name: 'p', mtimeMs: 1 })
  assert.ok(key.startsWith(`${PROBE_CACHE_SCHEMA}|`), 'key 必须以 schema 版本开头')
  assert.notEqual(key, `v|p|1`, '旧的「版本|包名|mtime」key 不能再命中')
})

test('#346 解析不到 id 时不再静默：结果标 idFallback，失败文案点明仅供参考', async () => {
  const result = await runProbes({
    targetVersion: 'v', dshBin: 'dsh', profileName: 't', dshHome: '/tmp/x', cache: {}, now: 1,
    targets: [{ name: 'p', path: '/p', mtimeMs: 1 }],
    run: async () => ({ status: 0, stdout: '- id: something-else\n' }),
  })
  assert.equal(result.results[0].idFallback, true)
  assert.match(result.results[0].detail, /未能从入口解析插件 id/)
})

test('#361 判据是 add 前后的 dump 差集：多出来的 id 才算装进去', async () => {
  let dumps = 0
  const result = await runProbes({
    targetVersion: '0.2.2-rc.1', dshBin: 'dsh', profileName: 't', dshHome: '/tmp/x', cache: {}, now: 1,
    targets: [{ name: 'dsh-usage-panel', id: 'dsh-usage-panel', path: '/p', mtimeMs: 1 }],
    run: async (bin, args) => {
      if (!args.includes('--dump-config')) return { status: 0, stdout: '' }
      dumps += 1
      // 第一次 dump（add 之前）没有它，第二次有——但 id 是 `usage-stats`，与包名/解析出的 id 都不同。
      return { status: 0, stdout: dumps === 1 ? '- id: other\n' : '- id: other\n- id: usage-stats\n' }
    },
  })
  assert.equal(result.results[0].ok, true, '差集判定不依赖「插件 id 叫什么」，猜错也能判对')
  assert.match(result.results[0].detail, /新增 usage-stats/)
  assert.equal(result.results[0].name, 'dsh-usage-panel', '显示仍用包名')
})

test('#361 差集为空 = 装了但没进 profile；基线拿不到时回落按 id 比对', async () => {
  const same = async (bin, args) => (args.includes('--dump-config') ? { status: 0, stdout: '- id: other\n' } : { status: 0, stdout: '' })
  const empty = await runProbes({
    targetVersion: 'v', dshBin: 'dsh', profileName: 't', dshHome: '/tmp/x', cache: {}, now: 1,
    targets: [{ name: 'p', id: 'p', path: '/x/p', mtimeMs: 1 }], run: same,
  })
  assert.equal(empty.results[0].ok, false)
  assert.match(empty.results[0].detail, /没有新增插件/)

  // 第一次 dump 失败 → 没有基线 → **不下结论**（不再拿猜出来的 id 兜底）
  let n = 0
  const fallback = await runProbes({
    targetVersion: 'v', dshBin: 'dsh', profileName: 't', dshHome: '/tmp/x', cache: {}, now: 1,
    targets: [{ name: 'p', id: 'p', path: '/x/p', mtimeMs: 1 }],
    run: async (bin, args) => {
      if (!args.includes('--dump-config')) return { status: 0, stdout: '' }
      n += 1
      // #373 起基线失败会**重试一次**：要连续两次都失败才走到「无法判定」。
      return n <= 2 ? { status: 1, stdout: '' } : { status: 0, stdout: '- id: p\n' }
    },
  })
  assert.equal(fallback.results[0].ok, false)
  assert.match(fallback.results[0].detail, /无法判定/, '要明确说「无法判定」，不能假装是「没进 profile」')

  // spawn 失败（status 为 null）也不能被当成「空基线」，否则既有 id 会全被算成新增
  let m = 0
  const spawnFail = await runProbes({
    targetVersion: 'v', dshBin: 'dsh', profileName: 't', dshHome: '/tmp/x', cache: {}, now: 1,
    targets: [{ name: 'p', id: 'p', path: '/x/p', mtimeMs: 1 }],
    run: async (bin, args) => {
      if (!args.includes('--dump-config')) return { status: 0, stdout: '' }
      m += 1
      // spawn 失败两次（基线 + 重试）才算「拿不到基线」；一次失败会被重试救回来。
      return m <= 2 ? { status: null, stdout: '' } : { status: 0, stdout: '- id: p\n' }
    },
  })
  assert.match(spawnFail.results[0].detail, /无法判定/, 'status 为 null 不能当成功')
})

test('#359 缓存键解析：旧格式键丢弃、schema 不匹配丢弃、新键解析出正确的版本与包名', () => {
  const now = 1_000_000
  const fresh = { at: now - 1000, ok: true, detail: '装配通过' }
  const cache = {
    // 0.9.2 之前的三段键：解析出来会把版本号当插件名，必须丢
    '0.2.2-rc.1|dsh-plugin-auto-upgrade|123': { at: now - 1000, ok: false, detail: '旧结论' },
    // schema 不匹配：旧判定逻辑的结论，必须丢
    '1|0.2.2-rc.1|dsh-plugin-awake|123': { at: now - 1000, ok: false, detail: '更旧的结论' },
    // 当前 schema：保留
    [`${PROBE_CACHE_SCHEMA}|0.2.2-rc.1|dsh-plugin-awake|123`]: fresh,
  }
  const entries = probeCacheEntries(cache, now)
  assert.equal(entries.length, 1, '只应留下当前 schema 的那条')
  assert.equal(entries[0].version, '0.2.2-rc.1', '版本不能被写成 schema 号')
  assert.equal(entries[0].name, 'dsh-plugin-awake', '名字不能被写成版本号')
  assert.equal(entries[0].ok, true)
  assert.equal(entries[0].stale, false)
})

test('#359 缓存键解析：过期的结论要标 stale，空缓存返回空数组', () => {
  const now = 10 * 24 * 60 * 60 * 1000
  const entries = probeCacheEntries({ [`${PROBE_CACHE_SCHEMA}|v|p|1`]: { at: 0, ok: false } }, now)
  assert.equal(entries[0].stale, true, '超出有效期要标 stale')
  assert.deepEqual(probeCacheEntries({}, now), [])
  assert.deepEqual(probeCacheEntries(undefined, now), [])
})

test('#359 同一插件的多个键只留最新那条（插件更新后旧键不会被删）', () => {
  const now = 1_000_000
  const cache = {
    [`${PROBE_CACHE_SCHEMA}|0.2.2-rc.1|p|100`]: { at: now - 5000, ok: false, detail: '旧 mtime 的结论' },
    [`${PROBE_CACHE_SCHEMA}|0.2.2-rc.1|p|200`]: { at: now - 1000, ok: true, detail: '新 mtime 的结论' },
    [`${PROBE_CACHE_SCHEMA}|0.2.2-rc.1|q|100`]: { at: now - 1000, ok: true },
  }
  const entries = probeCacheEntries(cache, now)
  assert.equal(entries.length, 2, 'p 只留一条、q 一条')
  const p = entries.find((entry) => entry.name === 'p')
  assert.equal(p.ok, true, '要留 mtime 更大的那条')
  assert.equal(p.detail, '新 mtime 的结论')
})

test('#361 idsFromDump 只收顶层 `- id:` 列表项，不吃嵌套 config 的 id，也认行尾注释', () => {
  const dump = [
    '- id: timer',
    '  name: \'@deepseek-ai/cordis-plugin-timer\'',
    '  config:',
    '    id: nested-provider-id',
    '    servers:',
    '      - id: nested-mcp-id',
    '- id: "quoted-id"',
    '- id: with-comment   # 这是注释',
  ].join('\n')
  const ids = idsFromDump(dump)
  assert.equal(ids.has('timer'), true)
  assert.equal(ids.has('quoted-id'), true, '引号要去掉')
  assert.equal(ids.has('with-comment'), true, '行尾注释要剥掉')
  assert.equal(ids.has('nested-provider-id'), false, '嵌套 config 的 id 不算插件')
  assert.equal(ids.has('nested-mcp-id'), false)
})

test('#373 基线 dump 偶发失败要重试（真因是 profile 不存在，见 #392）', async () => {
  let dumps = 0
  let added = false
  const result = await runProbes({
    targetVersion: 'v', dshBin: 'dsh', profileName: 't', dshHome: '/tmp/x', cache: {}, now: 1,
    targets: [{ name: 'first', id: 'first', path: '/x/first', mtimeMs: 1 }],
    run: async (bin, args) => {
      if (!args.includes('--dump-config')) {
        added = true
        return { status: 0, stdout: '' }
      }
      dumps += 1
      // 第 1 次（基线）偶发失败 → 重试成功；第 3 次是装后 dump。
      if (dumps === 1) return { status: 1, stdout: '' }
      return { status: 0, stdout: added ? '- id: first\n' : '' }
    },
  })
  assert.equal(result.results[0].ok, true, '重试拿到基线后应判为通过，而不是「无法判定」')
  assert.match(result.results[0].detail, /新增 first/)
})
