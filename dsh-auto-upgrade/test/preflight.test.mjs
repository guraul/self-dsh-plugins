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
  writePreflight,
} from '../lib/host/preflight-run.js'

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

test('judgeP1：ok / requirements / unverified 三态，且 disabled 与自述矩阵不参与阻断', () => {
  assert.deepEqual(judgeP1(plugin()), {
    ok: true, verdict: 'ok', requirements: {}, declared: 'compatible',
  })

  const requirements = judgeP1(plugin({
    compatible: false,
    peers: { '@deepseek-ai/dsh-tools': '^0.3.0' },
  }))
  assert.equal(requirements.ok, false)
  assert.equal(requirements.verdict, 'requirements')
  assert.deepEqual(requirements.requirements, { '@deepseek-ai/dsh-tools': '^0.3.0' })

  // manifest 读不到：信息不足，不阻断。
  const unknown = judgeP1(plugin({ known: false, detail: 'package.json not found' }))
  assert.equal(unknown.ok, true)
  assert.equal(unknown.verdict, 'unverified')
  assert.match(unknown.detail, /package\.json/)

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
  assert.deepEqual(disabled.requirements, {})
})

test('aggregatePreflight：P1 要求未满足 + P2 装不上都算阻断，未验证只进 warnings', () => {
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
    ok: true, verdict: 'ok', requirements: {}, declared: 'compatible',
  })
  assert.deepEqual(byName.get('ok-plugin').p2, { ok: true, reason: '装配通过（新增 ok-plugin）' })
  assert.equal(byName.get('needs-upgrade').p1.verdict, 'requirements')
  assert.deepEqual(byName.get('probe-fails').p2, { ok: false, reason: 'plugin add 退出码 1' })
  assert.equal(byName.get('never-verified').p1.verdict, 'unverified')
  assert.deepEqual(byName.get('never-verified').p2, { ok: true, skipped: true, reason: '未试装（不是 link:/file: 依赖）' })

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
