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

/** 一个 `evaluatePlugins()` 形状的插件条目（默认 L2 = 行为验证过，`judgeP1` 才给 `ok`）。 */
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
    depth: 'L2',
    ...over,
  }
}

test('judgeP1：ok / requirements / unverified 三态，且 disabled 与自述矩阵不参与阻断', () => {
  assert.deepEqual(judgeP1(plugin()), {
    ok: true, verdict: 'ok', requirements: {}, declared: 'compatible', depth: 'L2',
  })

  const requirements = judgeP1(plugin({
    compatible: false,
    peers: { '@deepseek-ai/dsh-tools': '^0.3.0' },
  }))
  assert.equal(requirements.ok, false)
  assert.equal(requirements.verdict, 'requirements')
  assert.deepEqual(requirements.requirements, { '@deepseek-ai/dsh-tools': '^0.3.0' })

  // manifest 读不到：信息不足，不阻断。
  const unknown = judgeP1(plugin({ known: false, depth: undefined, detail: 'package.json not found' }))
  assert.equal(unknown.ok, true)
  assert.equal(unknown.verdict, 'unverified')
  assert.match(unknown.detail, /package\.json/)
  assert.equal('depth' in unknown, false, '没记深度就不写 depth，别编一个')

  // 门禁放行但插件自述从未验证：仍标 unverified（只警告）。
  const neverVerified = judgeP1(plugin({ declared: { verdict: 'unverified', source: 'self-declared' } }))
  assert.equal(neverVerified.ok, true)
  assert.equal(neverVerified.verdict, 'unverified')

  // 自述 incompatible 不改变门禁结论，但原样带出。
  const declaredBad = judgeP1(plugin({ declared: { verdict: 'incompatible', source: 'self-declared' } }))
  assert.equal(declaredBad.ok, true)
  assert.equal(declaredBad.verdict, 'ok')
  assert.equal(declaredBad.declared, 'incompatible')

  // 已禁用插件不阻断升级（新宿主不会加载它）。
  const disabled = judgeP1(plugin({ enabled: false, compatible: false }))
  assert.equal(disabled.ok, true)
  assert.equal(disabled.verdict, 'ok')
  assert.deepEqual(disabled.requirements, {})
})

test('judgeP1：只有 L2+ 算通过，L1 / 缺深度降级 pending 且 depth 必须带出（删掉就红）', () => {
  // L2 / L3 / L4 才算行为验证过。
  for (const depth of ['L2', 'L3', 'L4']) {
    assert.deepEqual(judgeP1(plugin({ depth })), {
      ok: true, verdict: 'ok', requirements: {}, declared: 'compatible', depth,
    }, `${depth} 必须判通过`)
  }

  // L1 只是装配通过：不是兼容，降到 pending（仍然不阻断）。
  assert.deepEqual(judgeP1(plugin({ depth: 'L1' })), {
    ok: true,
    verdict: 'pending',
    requirements: {},
    declared: 'compatible',
    depth: 'L1',
    detail: '只到 L1（可装配 · 未验证行为）',
  })

  // 没记深度同样不能算通过。
  const missing = judgeP1(plugin({ depth: undefined }))
  assert.equal(missing.ok, true)
  assert.equal(missing.verdict, 'pending')
  assert.equal('depth' in missing, false)
  assert.match(missing.detail, /没有记录验证深度/)

  // 非法深度按「没记录」处理，绝不放行成 ok。
  assert.equal(judgeP1(plugin({ depth: 'L9' })).verdict, 'pending')

  // 守护卫：`judgeP1` 必须原样保留 `evaluatePlugins()` 的 depth；
  // 去掉透传（本轮修的 bug）这条立刻红。
  assert.equal(judgeP1(plugin({ depth: 'L3' })).depth, 'L3')

  // 新增 depth / pending 是**可选字段与枚举值**：旧消费方按「不是 ok 就不算通过」读仍然正确，
  // 所以不为它们再升 schema 版本（2 是 P3 新增 p3 字段时升的，见 #425）；真要升版必须是
  // 判定口径破坏性变化。
  assert.equal(PREFLIGHT_SCHEMA, 2, '新增可选字段不该再升 schema 版本')
})

test('aggregatePreflight：P1 要求未满足 + P2 装不上都算阻断，未验证 / 仅装配只进 warnings', () => {
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
  assert.deepEqual(byName.get('ok-plugin').p1, {
    ok: true, verdict: 'ok', requirements: {}, declared: 'compatible', depth: 'L2',
  })
  assert.deepEqual(byName.get('ok-plugin').p2, { ok: true, reason: '装配通过（新增 ok-plugin）' })
  assert.equal(byName.get('needs-upgrade').p1.verdict, 'requirements')
  assert.deepEqual(byName.get('probe-fails').p2, { ok: false, reason: 'plugin add 退出码 1' })
  assert.equal(byName.get('never-verified').p1.verdict, 'unverified')
  assert.deepEqual(byName.get('never-verified').p2, { ok: true, skipped: true, reason: '未试装（不是 link:/file: 依赖）' })

  // 只到 L1 的插件：depth 落盘、verdict=pending、不进 blocked（不阻断，但也不能算通过）。
  assert.deepEqual(byName.get('assembly-only').p1, {
    ok: true,
    verdict: 'pending',
    requirements: {},
    declared: 'compatible',
    depth: 'L1',
    detail: '只到 L1（可装配 · 未验证行为）',
  })
  assert.equal(blockedPluginNames(result).includes('assembly-only'), false)

  // warnings 只放不阻断的信息：未验证 + 自述 incompatible。
  const unverified = result.warnings.filter((item) => item.kind === 'p1-unverified')
  assert.deepEqual(unverified.map((item) => item.plugin), ['probe-fails', 'never-verified'])
  assert.equal(result.warnings.some((item) => item.kind === 'p2-failed'), false, 'P2 失败已计入 blocked，不再重复警告')
})

test('aggregatePreflight：只有未验证时 blocked=false；清单读取失败进 warnings', () => {
  const result = aggregatePreflight({
    target: '9.9.9',
    evaluated: {
      plugins: [plugin({ name: 'never-verified', declared: { verdict: 'unverified', source: 'self-declared' } })],
    },
    probes: [],
    inventoryError: '读取 profile 插件清单失败：EACCES',
  })
  assert.equal(result.blocked, false)
  assert.deepEqual(blockedPluginNames(result), [])
  assert.deepEqual(result.warnings.map((item) => item.kind), ['inventory', 'p1-unverified'])
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
      p1: { ok: false, verdict: 'requirements', requirements: { x: '^1' }, declared: 'compatible' },
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
      p1: { ok: false, verdict: 'requirements', requirements: { x: '^1' }, declared: 'compatible' },
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
