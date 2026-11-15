import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FORCE_AUDIT_FILE,
  PREFLIGHT_FILE,
  PREFLIGHT_SCHEMA,
  aggregatePreflight,
  appendForceAudit,
  blockedPluginNames,
  buildForceAuditEntry,
  decidePreflightGate,
  judgeP1,
  readPreflight,
  runProbePass,
  writePreflight,
} from '../lib/host/preflight-run.js'
import { probeKey } from '../lib/host/probe.js'
import { REHEARSAL_DONE, REHEARSAL_MARKER, runRehearsal } from '../lib/host/rehearse.js'

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
    ...over,
  }
}

test('judgeP1：只有 ok / incompatible 两态，只看官方声明范围', () => {
  assert.deepEqual(judgeP1(plugin()), { ok: true, verdict: 'ok' })

  const requirements = judgeP1(plugin({
    compatible: false,
    peers: { '@deepseek-ai/dsh-tools': '^0.3.0' },
  }))
  assert.equal(requirements.ok, false)
  assert.equal(requirements.verdict, 'incompatible')
  assert.deepEqual(requirements.requirements, { '@deepseek-ai/dsh-tools': '^0.3.0' })

  // manifest 读不到：信息不足不是不兼容，不阻断。
  assert.deepEqual(judgeP1(plugin({ known: false, detail: 'package.json not found' })), {
    ok: true, verdict: 'ok',
  })

  // 已禁用 / 已豁免插件不阻断升级（新宿主不会加载 / 官方已放行）。
  assert.deepEqual(judgeP1(plugin({ enabled: false, compatible: false })), { ok: true, verdict: 'ok' })
  assert.deepEqual(judgeP1(plugin({ compatible: false, exempted: true })), { ok: true, verdict: 'ok' })

  // P1 的两态是封闭集合：不存在 pending / unverified / requirements。
  const verdicts = new Set([
    judgeP1(plugin()).verdict,
    requirements.verdict,
    judgeP1(plugin({ enabled: false, compatible: false })).verdict,
  ])
  assert.deepEqual([...verdicts].sort(), ['incompatible', 'ok'])
})

test('judgeP1 不读兼容台账：dshReleases / dshDepth 带什么 verdict 都不影响 P1（#438）', () => {
  // `evaluatePlugins()` 会把自述矩阵与验证深度挂在条目上；P1 必须完全无视它们。
  const declaredIncompatible = judgeP1(plugin({
    declared: { verdict: 'incompatible', source: 'self-declared' },
    depth: 'L1',
  }))
  assert.deepEqual(declaredIncompatible, { ok: true, verdict: 'ok' }, '自述 incompatible 不许改变 P1')
  assert.equal('declared' in declaredIncompatible, false)
  assert.equal('depth' in declaredIncompatible, false)

  const declaredUnverified = judgeP1(plugin({
    declared: { verdict: 'unverified', source: 'self-declared' },
    depth: undefined,
  }))
  assert.deepEqual(declaredUnverified, { ok: true, verdict: 'ok' }, '没写台账 / 没记深度不许降级成 pending')

  // 反方向：台账写 compatible 也不能把官方不兼容洗成 ok。
  assert.equal(judgeP1(plugin({
    compatible: false,
    peers: { '@deepseek-ai/dsh': '^0.5.0' },
    declared: { verdict: 'compatible', source: 'self-declared' },
    depth: 'L4',
  })).verdict, 'incompatible')
})

test('aggregatePreflight：P1 声明不覆盖 + P2 装不上都算阻断，台账不产生任何 warning', () => {
  const result = aggregatePreflight({
    target: '9.9.9',
    at: 1_700_000_000_000,
    evaluated: {
      plugins: [
        plugin({ name: 'ok-plugin' }),
        plugin({
          name: 'needs-upgrade',
          compatible: false,
          peers: { '@deepseek-ai/dsh-tools': '>=0.4.0' },
        }),
        plugin({
          name: 'probe-fails',
          declared: { verdict: 'unverified', source: 'self-declared' },
        }),
        plugin({
          name: 'never-verified',
          declared: { verdict: 'unverified', source: 'self-declared' },
        }),
        plugin({
          name: 'declared-incompatible',
          declared: { verdict: 'incompatible', source: 'self-declared' },
        }),
        plugin({ name: 'assembly-only', depth: 'L1' }),
      ],
    },
    probes: [
      { name: 'ok-plugin', ok: true, detail: '装配通过（新增 ok-plugin）' },
      { name: 'probe-fails', ok: false, detail: 'plugin add 退出码 1' },
    ],
  })

  assert.equal(result.schema, PREFLIGHT_SCHEMA)
  assert.equal(result.at, 1_700_000_000_000)
  assert.equal(result.target, '9.9.9')
  assert.equal(result.blocked, true)
  assert.deepEqual(blockedPluginNames(result), ['needs-upgrade', 'probe-fails'])

  const byName = new Map(result.plugins.map((item) => [item.name, item]))
  assert.deepEqual(byName.get('ok-plugin').p1, { ok: true, verdict: 'ok' })
  assert.deepEqual(byName.get('ok-plugin').p2, { ok: true, reason: '装配通过（新增 ok-plugin）' })
  assert.equal(byName.get('needs-upgrade').p1.verdict, 'incompatible')
  assert.deepEqual(byName.get('probe-fails').p2, { ok: false, reason: 'plugin add 退出码 1' })

  // 台账（自述 / 深度）完全不影响 P1：这些插件一律 ok、不阻断。
  for (const name of ['never-verified', 'declared-incompatible', 'assembly-only']) {
    assert.deepEqual(byName.get(name).p1, { ok: true, verdict: 'ok' }, `${name} 不该被台账影响`)
  }
  assert.deepEqual(byName.get('never-verified').p2, { ok: true, skipped: true, reason: '未试装（不是 link:/file: 依赖）' })

  // 唯一的 warnings 来源不再包含台账：没有 p1-unverified / declared-incompatible。
  assert.deepEqual(result.warnings.map((item) => item.kind), [])
})

test('aggregatePreflight：台账未验证 / 自述不兼容都不置 blocked；清单读取失败进 warnings', () => {
  const result = aggregatePreflight({
    target: '9.9.9',
    evaluated: {
      plugins: [
        plugin({ name: 'never-verified', declared: { verdict: 'unverified', source: 'self-declared' } }),
        plugin({ name: 'declared-incompatible', declared: { verdict: 'incompatible', source: 'self-declared' } }),
      ],
    },
    probes: [],
    inventoryError: '读取 profile 插件清单失败：EACCES',
  })
  assert.equal(result.blocked, false)
  assert.deepEqual(blockedPluginNames(result), [])
  assert.deepEqual(result.warnings.map((item) => item.kind), ['inventory'])
  assert.equal(result.warnings[0].plugin, null)
})

test('decidePreflightGate：缺失 / blocked / force 三种判定', () => {
  assert.deepEqual(decidePreflightGate({ result: null, force: false }), {
    allowed: false, reason: 'missing', blocked: [],
  })
  assert.deepEqual(decidePreflightGate({ result: null, force: true }), {
    allowed: true, reason: 'missing', blocked: [],
  })

  const blocked = {
    blocked: true,
    plugins: [{
      name: 'bad',
      enabled: true,
      p1: { ok: false, verdict: 'incompatible', requirements: { x: '^1' } },
      p2: { ok: true, skipped: true, reason: '未试装（不是 link:/file: 依赖）' },
    }],
  }
  assert.deepEqual(decidePreflightGate({ result: blocked, force: false }), {
    allowed: false, reason: 'blocked', blocked: ['bad'],
  })
  assert.deepEqual(decidePreflightGate({ result: blocked, force: true }), {
    allowed: true, reason: 'blocked', blocked: ['bad'],
  })

  assert.deepEqual(decidePreflightGate({ result: { blocked: false, plugins: [] } }), {
    allowed: true, reason: null, blocked: [],
  })
})

test('结果文件：原子写入后可读，缺失或损坏返回 null', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-au-preflight-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  assert.equal(await readPreflight(dir), null, '缺失不是错误')

  const result = aggregatePreflight({ target: '9.9.9', at: 123, evaluated: { plugins: [] } })
  await writePreflight(dir, result)
  assert.deepEqual(await readPreflight(dir), result)

  const raw = JSON.parse(await readFile(join(dir, PREFLIGHT_FILE), 'utf8'))
  assert.equal(raw.schema, PREFLIGHT_SCHEMA)
  assert.equal(raw.target, '9.9.9')

  await writeFile(join(dir, PREFLIGHT_FILE), '{ not json')
  assert.equal(await readPreflight(dir), null, '损坏文件不许抛错')
})

test('force-audit.jsonl：一行一条 JSON，含 at / from / to / blocked / reason', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-au-force-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const blocked = {
    blocked: true,
    plugins: [{
      name: 'bad',
      enabled: true,
      p1: { ok: false, verdict: 'incompatible', requirements: { x: '^1' } },
      p2: { ok: true, skipped: true, reason: '未试装（不是 link:/file: 依赖）' },
    }],
  }
  const first = buildForceAuditEntry({ from: '0.2.1-rc.5', to: '9.9.9', result: blocked, reason: 'blocked', at: 0 })
  assert.equal(first.at, '1970-01-01T00:00:00.000Z')
  assert.equal(first.from, '0.2.1-rc.5')
  assert.equal(first.to, '9.9.9')
  assert.deepEqual(first.blocked, ['bad'])
  assert.equal(first.reason, 'blocked')

  await appendForceAudit(dir, first)
  await appendForceAudit(dir, buildForceAuditEntry({ from: null, to: '9.9.9', result: null, reason: 'missing' }))

  const lines = (await readFile(join(dir, FORCE_AUDIT_FILE), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  const second = JSON.parse(lines[1])
  assert.equal(second.from, null)
  assert.deepEqual(second.blocked, [])
  assert.equal(second.reason, 'missing')
})

test('#425 预检 P2 不吃 /probe 缓存：缓存命中也要真装，P3 才不是全 inactive', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-au-preflight-cache-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const now = 1_700_000_000_000
  const cachePath = join(home, 'probe-cache.json')
  // 预置一条**新鲜**的命中记录：旧实现会让 runProbes 直接回放它、跳过 plugin add。
  const key = probeKey({ targetVersion: '9.9.9', name: 'plugin-a', mtimeMs: 42 })
  await writeFile(cachePath, `${JSON.stringify({ [key]: { at: now, ok: false, detail: '缓存里的旧结论' } })}\n`)

  let adds = 0
  let installed = false
  const run = async (_command, args) => {
    if (args.includes('--dump-config')) {
      return { status: 0, stdout: installed ? '- id: plugin-a\n' : '' }
    }
    adds += 1
    installed = true
    return { status: 0, stdout: '' }
  }

  const { results } = await runProbePass({
    targets: [{ name: 'plugin-a', id: 'plugin-a', path: '/x/plugin-a', mtimeMs: 42 }],
    targetVersion: '9.9.9',
    dshBin: '/fake/dsh',
    profileName: 'probe',
    cachePath,
    run,
    now,
    home,
    ensure: async () => {},
    useCache: false,
  })
  assert.equal(adds, 1, '缓存命中也不能跳过 plugin add：一次性 HOME 的 profile 是空的')
  assert.equal(results[0].cached, false, '预检结论不能标成 cached')
  assert.equal(results[0].ok, true, '真装之后差集判据应通过')

  // P3 在同一个 HOME 上启动：只有真装过，条目才会 active；全 inactive 正是 review 抓到的误报。
  const log = installed
    ? [
      'dsh web: http://127.0.0.1:43210/?token=x',
      `${REHEARSAL_MARKER} plugin-a active`,
      REHEARSAL_DONE,
    ].join('\n')
    : ''
  const handle = {
    output: () => log,
    exited: Promise.resolve({ code: 0, signal: null }),
    kill: () => {},
  }
  const p3 = await runRehearsal({
    targetVersion: '9.9.9',
    dshHome: home,
    profileName: 'probe',
    entries: ['plugin-a'],
    install: async () => ({ ok: true, dshBin: '/fake/dsh' }),
    launch: async () => handle,
    checkReady: async () => ({ ok: true }),
  })
  assert.equal(p3.launch, 'ok')
  assert.equal(p3.ok, true)
  assert.deepEqual(p3.entries, { 'plugin-a': 'active' })
})

test('#425 接线：预检 P2 显式禁用缓存；没有 link:/file: 目标时 P3 是 skipped 不是 ok', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /executeProbeTargets\(targets, target, home \?\? undefined, \{ useCache: false \}\)/,
    '预检 P2 必须传 useCache:false（命中缓存会跳过真装，P3 在空 profile 上全 inactive）',
  )
  assert.match(source, /launch: 'skipped'/, '无 link:/file: 目标时不能把 P3 报成 launch:ok')
})
