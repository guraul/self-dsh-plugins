import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aggregatePreflight, blockedPluginNames } from '../lib/host/preflight-run.js'
import {
  REHEARSAL_MARKER,
  REHEARSAL_TIMEOUT_MS,
  expectedEntries,
  judgeRehearsal,
  parseRehearsalMarkers,
  rehearsalPatchSource,
  rehearsalProbeSource,
  runRehearsal,
} from '../lib/host/rehearse.js'

/** 一个 `evaluatePlugins()` 形状的插件条目。 */
function plugin(over = {}) {
  return {
    name: 'plugin-a',
    version: '1.0.0',
    enabled: true,
    compatible: true,
    known: true,
    exempted: false,
    peers: {},
    declared: { verdict: 'compatible', source: 'self-declared' },
    ...over,
  }
}

test('judgeRehearsal：进程退出码非 0 → launch=failed，条目全 inactive', () => {
  const p3 = judgeRehearsal({
    exitCode: 1,
    log: 'boom',
    entries: ['plugin-a', 'plugin-b'],
  })
  assert.equal(p3.ok, false)
  assert.equal(p3.launch, 'failed')
  assert.match(p3.error, /退出码 1/)
  assert.deepEqual(p3.entries, { 'plugin-a': 'inactive', 'plugin-b': 'inactive' })
})

test('judgeRehearsal：日志出现 StartupError → 失败（即使退出码是 0）', () => {
  const p3 = judgeRehearsal({
    exitCode: 0,
    log: 'StartupError: plugin plugin-a failed to mount',
    entries: ['plugin-a'],
  })
  assert.equal(p3.ok, false)
  assert.equal(p3.launch, 'failed')
  assert.match(p3.error, /StartupError/)
  assert.deepEqual(p3.entries, { 'plugin-a': 'inactive' })
})

test('judgeRehearsal：某条目 inactive 只影响 p3.ok，不抛错', () => {
  const log = [
    `${REHEARSAL_MARKER} plugin-a active`,
    `${REHEARSAL_MARKER} plugin-b inactive`,
  ].join('\n')
  const p3 = judgeRehearsal({ exitCode: 0, log, entries: ['plugin-a', 'plugin-b'] })
  assert.equal(p3.launch, 'ok')
  assert.equal(p3.ok, false)
  assert.deepEqual(p3.entries, { 'plugin-a': 'active', 'plugin-b': 'inactive' })
  assert.equal(p3.error, undefined)
})

test('judgeRehearsal：全部 active → ok=true；没有标记的条目按 inactive 处理', () => {
  const log = [
    `${REHEARSAL_MARKER} plugin-a active`,
    `${REHEARSAL_MARKER} plugin-b active`,
  ].join('\n')
  const p3 = judgeRehearsal({ exitCode: 0, log, entries: ['plugin-a', 'plugin-b'] })
  assert.equal(p3.ok, true)
  assert.equal(p3.launch, 'ok')
  assert.deepEqual(p3.entries, { 'plugin-a': 'active', 'plugin-b': 'active' })

  const partial = judgeRehearsal({ exitCode: 0, log, entries: ['plugin-a', 'plugin-c'] })
  assert.deepEqual(partial.entries, { 'plugin-a': 'active', 'plugin-c': 'inactive' })
})

test('judgeRehearsal：超时优先于退出码，错误文案带超时上限', () => {
  const p3 = judgeRehearsal({
    exitCode: null,
    timedOut: true,
    log: '',
    entries: ['plugin-a'],
    timeoutMs: 1234,
  })
  assert.equal(p3.ok, false)
  assert.equal(p3.launch, 'failed')
  assert.match(p3.error, /超时（1234ms）/)
  assert.deepEqual(p3.entries, { 'plugin-a': 'inactive' })
})

test('探针与 overlay：标记前缀稳定，overlay 指向探针文件', () => {
  assert.equal(REHEARSAL_MARKER, '[dsh-rehearsal]')
  assert.match(rehearsalProbeSource(), /ctx\.appReady\.onReady/)
  assert.match(rehearsalProbeSource(), /entry\.fiber\?\.state === 2/)
  assert.match(rehearsalPatchSource(), /id: dsh-auto-upgrade-rehearsal/)
  assert.match(rehearsalPatchSource(), /\.dsh-rehearsal-probe\.mjs/)
})

test('parseRehearsalMarkers / expectedEntries：只认探针行，包名去重', () => {
  const states = parseRehearsalMarkers([
    'noise',
    `${REHEARSAL_MARKER} plugin-a active`,
    `  ${REHEARSAL_MARKER} plugin-b inactive  `,
    `${REHEARSAL_MARKER} done`,
  ].join('\n'))
  assert.deepEqual([...states.entries()], [['plugin-a', 'active'], ['plugin-b', 'inactive']])
  assert.deepEqual(expectedEntries(['a', 'b', 'a', '', 'c']), ['a', 'b', 'c'])
})

test('runRehearsal：注入假启动器，复用 HOME、写探针/overlay 并在结束后清理', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-rehearse-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  let called = null
  const p3 = await runRehearsal({
    dshBin: '/fake/dsh',
    dshHome: home,
    profileName: 'probe',
    entries: ['plugin-a'],
    run: async (command, args, options) => {
      called = { command, args, options }
      const patch = args[args.indexOf('--patch') + 1]
      const overlay = await readFile(patch, 'utf8')
      assert.match(overlay, /dsh-auto-upgrade-rehearsal/)
      assert.equal(options.env.DSH_HOME, home)
      assert.equal(options.timeoutMs, REHEARSAL_TIMEOUT_MS)
      return { status: 0, stdout: `${REHEARSAL_MARKER} plugin-a active`, stderr: '' }
    },
  })

  assert.notEqual(called, null)
  assert.equal(called.command, '/fake/dsh')
  assert.deepEqual(called.args.slice(0, 2), ['--profile', 'probe'])
  assert.equal(p3.ok, true)
  assert.deepEqual(p3.entries, { 'plugin-a': 'active' })
  await assert.rejects(stat(join(home, 'profiles', 'probe', '.dsh-rehearsal-probe.mjs')))
  await assert.rejects(stat(join(home, 'profiles', 'probe', '.dsh-rehearsal.patch.yml')))
})

test('runRehearsal：启动器抛错折成 launch=failed，不把异常抛给 /preflight', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-rehearse-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const p3 = await runRehearsal({
    dshBin: '/fake/dsh',
    dshHome: home,
    profileName: 'probe',
    entries: ['plugin-a'],
    run: async () => { throw new Error('spawn ENOENT') },
  })
  assert.equal(p3.ok, false)
  assert.equal(p3.launch, 'failed')
  assert.match(p3.error, /spawn ENOENT/)
  assert.deepEqual(p3.entries, { 'plugin-a': 'inactive' })
})

test('P3 失败只进 warnings，不改变 blocked', () => {
  const p3 = judgeRehearsal({ exitCode: 1, log: 'exit 1', entries: ['plugin-a'] })

  const healthy = aggregatePreflight({
    target: '9.9.9',
    evaluated: { plugins: [plugin({ name: 'plugin-a' })] },
    probes: [{ name: 'plugin-a', ok: true }],
    p3,
  })
  assert.equal(healthy.blocked, false)
  assert.deepEqual(blockedPluginNames(healthy), [])
  assert.equal(healthy.p3.launch, 'failed')
  assert.deepEqual(healthy.warnings.map((item) => item.kind), ['p3-failed'])
  assert.equal(healthy.warnings[0].plugin, null)

  // 已有阻断项时 P3 不改变它，只追加警告。
  const blocked = aggregatePreflight({
    target: '9.9.9',
    evaluated: { plugins: [plugin({ name: 'plugin-a', compatible: false, peers: { x: '^2' } })] },
    probes: [],
    p3,
  })
  assert.equal(blocked.blocked, true)
  assert.deepEqual(blockedPluginNames(blocked), ['plugin-a'])
  assert.deepEqual(blocked.warnings.map((item) => item.kind), ['p3-failed'])
})

test('P3 的 inactive 条目逐个进 warnings；active 不进', () => {
  const result = aggregatePreflight({
    target: '9.9.9',
    evaluated: { plugins: [plugin({ name: 'plugin-a' }), plugin({ name: 'plugin-b' })] },
    probes: [],
    p3: {
      ok: false,
      launch: 'ok',
      entries: { 'plugin-a': 'active', 'plugin-b': 'inactive' },
    },
  })
  assert.equal(result.blocked, false)
  assert.deepEqual(result.p3.entries, { 'plugin-a': 'active', 'plugin-b': 'inactive' })
  assert.deepEqual(result.warnings.map((item) => [item.kind, item.plugin]), [['p3-inactive', 'plugin-b']])
})
