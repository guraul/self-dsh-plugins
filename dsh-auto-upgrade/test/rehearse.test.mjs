import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aggregatePreflight, blockedPluginNames } from '../lib/host/preflight-run.js'
import {
  REHEARSAL_DONE,
  REHEARSAL_MARKER,
  REHEARSAL_TARGET_DIR,
  REHEARSAL_TIMEOUT_MS,
  buildRehearsalArgs,
  expectedEntries,
  installTargetDsh,
  judgeRehearsal,
  parseRehearsalMarkers,
  parseWebUrlLine,
  prepareRehearsalProfile,
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

/**
 * 假的预演子进程句柄：输出固定，kill 时兑现 exit。
 * @param {string} log 输出。
 * @param {{pending?:boolean, code?:number|null}} [options] 选项。
 * @returns {object} 句柄。
 */
function fakeHandle(log, options = {}) {
  let finish
  const exited = new Promise((resolve) => {
    finish = resolve
    if (options.pending !== true) resolve({ code: options.code ?? 0, signal: null })
  })
  const handle = {
    output: () => log,
    exited,
    killed: false,
    kill: () => {
      handle.killed = true
      finish?.({ code: null, signal: 'SIGTERM' })
    },
  }
  return handle
}

/** 预演成功时的日志：URL + 探针标记 + done。 */
function successfulLog(entries = ['plugin-a']) {
  return [
    'dsh web: http://127.0.0.1:43210/?token=secret-token',
    ...entries.map((name) => `${REHEARSAL_MARKER} ${name} active`),
    REHEARSAL_DONE,
  ].join('\n')
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

test('judgeRehearsal：没拿到可访问端口 → launch=failed（区分「起得来」与「没起来」）', () => {
  const p3 = judgeRehearsal({ exitCode: 0, ready: false, log: 'no url', entries: ['plugin-a'] })
  assert.equal(p3.ok, false)
  assert.equal(p3.launch, 'failed')
  assert.match(p3.error, /web 端口/)
})

test('judgeRehearsal：收到 done 时忽略被 kill 的退出码', () => {
  const p3 = judgeRehearsal({ exitCode: null, ready: true, log: successfulLog(), entries: ['plugin-a'] })
  assert.equal(p3.launch, 'ok')
  assert.equal(p3.ok, true)
})

test('探针与 overlay：标记前缀稳定，overlay 指向探针文件，探针不依赖 appExit', () => {
  assert.equal(REHEARSAL_MARKER, '[dsh-rehearsal]')
  assert.equal(REHEARSAL_DONE, '[dsh-rehearsal] done')
  assert.match(rehearsalProbeSource(), /ctx\.appReady\.onReady/)
  assert.match(rehearsalProbeSource(), /entry\.fiber\?\.state === 2/)
  assert.match(rehearsalProbeSource(), /\[dsh-rehearsal\] done/)
  assert.doesNotMatch(rehearsalProbeSource(), /appExit/)
  assert.match(rehearsalPatchSource(), /id: dsh-auto-upgrade-rehearsal/)
  assert.match(rehearsalPatchSource(), /\.dsh-rehearsal-probe\.mjs/)
})

test('parseRehearsalMarkers / expectedEntries：只认探针行，包名去重', () => {
  const states = parseRehearsalMarkers([
    'noise',
    `${REHEARSAL_MARKER} plugin-a active`,
    `  ${REHEARSAL_MARKER} plugin-b inactive  `,
    REHEARSAL_DONE,
  ].join('\n'))
  assert.deepEqual([...states.entries()], [['plugin-a', 'active'], ['plugin-b', 'inactive']])
  assert.deepEqual(expectedEntries(['a', 'b', 'a', '', 'c']), ['a', 'b', 'c'])
})

test('parseWebUrlLine：从 dsh web 行取端口，返回的 origin 不带 token', () => {
  const parsed = parseWebUrlLine([
    'noise',
    'dsh web: http://127.0.0.1:43210/?token=super-secret',
    'more noise',
  ].join('\n'))
  assert.deepEqual(parsed, { origin: 'http://127.0.0.1:43210', port: 43210 })
  assert.doesNotMatch(JSON.stringify(parsed), /super-secret/)
})

test('parseWebUrlLine：缺行 / 没有端口 / 不可解析 → null', () => {
  assert.equal(parseWebUrlLine(''), null)
  assert.equal(parseWebUrlLine('dsh web: opening the default browser; pass --no-open to disable'), null)
  assert.equal(parseWebUrlLine('dsh web: http://127.0.0.1/?token=x'), null)
  assert.equal(parseWebUrlLine('dsh web: not-a-url'), null)
})

test('buildRehearsalArgs：web app 必须 port 0 + no-open，且 launcher 参数在前', () => {
  assert.deepEqual(
    buildRehearsalArgs('probe', '/tmp/p.yml'),
    ['--profile', 'probe', '--patch', '/tmp/p.yml', '--port', '0', '--no-open'],
  )
})

test('prepareRehearsalProfile：补 base + web-app，保留依赖与已有插件 bundle', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-rehearse-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const profileDir = join(home, 'profiles', 'probe')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-probe',
    dependencies: { 'plugin-a': 'link:/tmp/plugin-a' },
    dsh: { profile: { bundles: ['plugin-a'], patchReload: 'live' } },
  }))

  const manifest = await prepareRehearsalProfile(profileDir)
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'plugin-a'])
  assert.equal(manifest.dsh.profile.patchReload, 'live')
  assert.deepEqual(manifest.dependencies, { 'plugin-a': 'link:/tmp/plugin-a' })

  // 幂等：再跑一次不会把 base/web-app 重复插进去。
  const again = await prepareRehearsalProfile(profileDir)
  assert.deepEqual(again.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'plugin-a'])
})

test('installTargetDsh：只用 npm --prefix 装到临时目录，bin 不存在算失败', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-install-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  let called = null
  const failed = await installTargetDsh({
    version: '0.2.2-rc.3',
    dir: join(home, 'target'),
    npmBin: '/fake/npm',
    run: async (command, args, options) => {
      called = { command, args, options }
      return { status: 1, stdout: '', stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found' }
    },
  })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /0\.2\.2-rc\.3/)
  assert.match(failed.error, /E404/)
  assert.equal(called.command, '/fake/npm')
  assert.deepEqual(called.args, [
    'install', '--prefix', join(home, 'target'), '--no-audit', '--no-fund', '--loglevel', 'error',
    '@deepseek-ai/dsh@0.2.2-rc.3',
  ])

  const missing = await installTargetDsh({
    version: '0.2.2-rc.3',
    dir: join(home, 'target2'),
    run: async () => ({ status: 0, stdout: '', stderr: '' }),
  })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /找不到可执行文件/)

  const target = join(home, 'target3')
  await mkdir(join(target, 'node_modules', '.bin'), { recursive: true })
  await writeFile(join(target, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), '')
  const ok = await installTargetDsh({
    version: '0.2.2-rc.3',
    dir: target,
    run: async () => ({ status: 0, stdout: '', stderr: '' }),
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.dshBin, join(target, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'))
})

test('installTargetDsh：非法版本号直接拒绝，不跑 npm', async () => {
  let called = false
  const result = await installTargetDsh({
    version: '^0.2.2',
    dir: '/tmp/unused',
    run: async () => { called = true; return { status: 0 } },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /精确版本号/)
  assert.equal(called, false)
})

test('runRehearsal：装目标版本、用目标二进制启动、就绪后收标记并清理', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-rehearse-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  let launched = null
  const targetBin = join(home, REHEARSAL_TARGET_DIR, 'node_modules', '.bin', 'dsh')
  const p3 = await runRehearsal({
    targetVersion: '0.2.2-rc.3',
    dshHome: home,
    profileName: 'probe',
    entries: ['plugin-a'],
    install: async () => ({ ok: true, dshBin: targetBin }),
    launch: async (command, args, options) => {
      launched = { command, args, options }
      return fakeHandle(successfulLog(['plugin-a']))
    },
    checkReady: async (port) => ({ ok: port === 43210 }),
  })

  assert.notEqual(launched, null)
  assert.equal(launched.command, targetBin)
  assert.deepEqual(launched.args, [
    '--profile', 'probe', '--patch', join(home, 'profiles', 'probe', '.dsh-rehearsal.patch.yml'),
    '--port', '0', '--no-open',
  ])
  assert.equal(launched.options.env.DSH_HOME, home)
  assert.equal(launched.options.timeoutMs, REHEARSAL_TIMEOUT_MS)
  assert.equal(p3.ok, true)
  assert.equal(p3.launch, 'ok')
  assert.deepEqual(p3.entries, { 'plugin-a': 'active' })

  const manifest = JSON.parse(await readFile(join(home, 'profiles', 'probe', 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  await assert.rejects(stat(join(home, 'profiles', 'probe', '.dsh-rehearsal-probe.mjs')))
  await assert.rejects(stat(join(home, 'profiles', 'probe', '.dsh-rehearsal.patch.yml')))
})

test('runRehearsal：装不上目标版本 → launch=failed，且不回退到当前 dsh', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-rehearse-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  let launched = 0
  const p3 = await runRehearsal({
    targetVersion: '0.2.2-rc.3',
    dshHome: home,
    profileName: 'probe',
    entries: ['plugin-a'],
    install: async () => ({ ok: false, error: '安装目标版本 0.2.2-rc.3 失败（npm 退出码 1）' }),
    launch: async () => { launched += 1; return fakeHandle('') },
  })
  assert.equal(p3.ok, false)
  assert.equal(p3.launch, 'failed')
  assert.match(p3.error, /安装目标版本/)
  assert.deepEqual(p3.entries, { 'plugin-a': 'inactive' })
  assert.equal(launched, 0)
})

test('runRehearsal：默认安装器失败时也不启动（接线级不回退）', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-rehearse-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  let launched = 0
  const p3 = await runRehearsal({
    targetVersion: '0.2.2-rc.3',
    dshHome: home,
    profileName: 'probe',
    entries: ['plugin-a'],
    run: async () => ({ status: 1, stdout: '', stderr: 'npm ERR! network' }),
    launch: async () => { launched += 1; return fakeHandle('') },
  })
  assert.equal(p3.launch, 'failed')
  assert.match(p3.error, /安装目标版本/)
  assert.equal(launched, 0)
})

test('runRehearsal：启动器抛错折成 launch=failed，不把异常抛给 /preflight', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-rehearse-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const p3 = await runRehearsal({
    targetVersion: '0.2.2-rc.3',
    dshHome: home,
    profileName: 'probe',
    entries: ['plugin-a'],
    install: async () => ({ ok: true, dshBin: '/fake/dsh' }),
    launch: async () => { throw new Error('spawn ENOENT') },
  })
  assert.equal(p3.ok, false)
  assert.equal(p3.launch, 'failed')
  assert.match(p3.error, /spawn ENOENT/)
  assert.deepEqual(p3.entries, { 'plugin-a': 'inactive' })
})

test('runRehearsal：进程早退但没打印 URL → 失败（不会把「没起来」当通过）', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-rehearse-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const handle = fakeHandle('missing app argument', { code: 1 })
  const p3 = await runRehearsal({
    targetVersion: '0.2.2-rc.3',
    dshHome: home,
    profileName: 'probe',
    entries: ['plugin-a'],
    install: async () => ({ ok: true, dshBin: '/fake/dsh' }),
    launch: async () => handle,
    checkReady: async () => ({ ok: false }),
  })
  assert.equal(p3.launch, 'failed')
  assert.match(p3.error, /退出码 1/)
})

test('runRehearsal：有 URL 但探针一直没跑完 → 90s 预算用尽算超时', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-rehearse-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const handle = fakeHandle('dsh web: http://127.0.0.1:43210/?token=x', { pending: true })
  const p3 = await runRehearsal({
    targetVersion: '0.2.2-rc.3',
    dshHome: home,
    profileName: 'probe',
    entries: ['plugin-a'],
    timeoutMs: 60,
    install: async () => ({ ok: true, dshBin: '/fake/dsh' }),
    launch: async () => handle,
    checkReady: async () => ({ ok: true }),
  })
  assert.equal(p3.launch, 'failed')
  assert.match(p3.error, /超时（60ms）/)
  assert.equal(handle.killed, true)
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
