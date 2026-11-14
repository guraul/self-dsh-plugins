/**
 * 升级预检管线（issue #421 PR-1）：把 P1 兼容性判定与 P2 试装聚合成一次可落盘的结论。
 *
 * 结果文件 `preflight.json` 是 GUI / 进度页的消费契约（见
 * `docs/plugins/dsh-auto-upgrade.md` 的「升级预检管线」），字段名与枚举改动必须同步文档与
 * `test/preflight.test.mjs`。
 *
 * 判定口径：
 * - **P1** 用 `compat.js` 的 `evaluatePlugins()` 按**目标版本**逐插件判定：门禁要求未满足 =
 *   `requirements`（阻断）；manifest 读不到或插件自述从未验证 = `unverified`（只警告，不阻断）。
 * - **P2** 复用一次性 `DSH_HOME` 试装执行器：只覆盖 `link:` / `file:` 插件，装不上 = 阻断。
 * - **P3** 启动预演（`rehearse.js`）：在同一个一次性 `DSH_HOME` 里真启动一次，条目没起来
 *   只写 warning，**不改 `blocked`**。
 * @module dsh-plugin-auto-upgrade/host/preflight-run
 */
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { entryCandidates, linkTargets, pluginIdFromSource, runProbes } from './probe.js'
import { runProbeWithProfile } from './probe-run.js'

/** 预检结果文件名（状态目录内）。 */
export const PREFLIGHT_FILE = 'preflight.json'
/** 强制升级留痕文件名（状态目录内，一行一条 JSON）。 */
export const FORCE_AUDIT_FILE = 'force-audit.jsonl'
/** 结果文件 schema；判定口径变了就 +1，旧结果仍然可读但要标明版本。 */
export const PREFLIGHT_SCHEMA = 2

/**
 * 把 `evaluatePlugins()` 的单插件判定折成 P1 三态。
 *
 * 三态刻意与门禁语义对齐：`requirements` 才阻断，`unverified` 只是「没法下结论」。
 * 自述矩阵（`declared`）原样带出，但不改变 `requirements` 结论——它从来不是门禁。
 * @param {object} plugin `evaluatePlugins()` 的插件条目。
 * @returns {{ok:boolean, verdict:'ok'|'requirements'|'unverified', requirements:object, declared:string, detail?:string}} P1 判定。
 */
export function judgeP1(plugin) {
  const declared = plugin?.declared?.verdict ?? 'unverified'
  const requirements = plugin?.peers ?? {}
  if (plugin?.enabled === false) {
    return { ok: true, verdict: 'ok', requirements: {}, declared }
  }
  // manifest 读不到不是「不兼容」，是「信息不足」：如实标 unverified，不阻断。
  if (plugin?.known === false) {
    return {
      ok: true,
      verdict: 'unverified',
      requirements: {},
      declared,
      ...(typeof plugin.detail === 'string' ? { detail: plugin.detail } : {}),
    }
  }
  if (plugin?.compatible === false && plugin?.exempted !== true) {
    return {
      ok: false,
      verdict: 'requirements',
      requirements,
      declared,
      ...(typeof plugin.detail === 'string' ? { detail: plugin.detail } : {}),
    }
  }
  // 门禁已放行，但插件自述从未验证：仍然是「未验证」，不是「兼容」。
  if (declared === 'unverified') {
    return { ok: true, verdict: 'unverified', requirements: {}, declared }
  }
  return { ok: true, verdict: 'ok', requirements: {}, declared }
}

/**
 * 聚合 P1 + P2，产出 `preflight.json` 的内容（纯函数）。
 * @param {object} options 输入。
 * @param {string} options.target 目标 dsh 版本。
 * @param {object} options.evaluated `evaluatePlugins()` 的返回（或同形状）。
 * @param {{name:string, ok:boolean, detail?:string}[]} [options.probes] P2 的逐插件结论。
 * @param {object|null} [options.p3] P3 启动预演结论（`rehearse.js` 的 `judgeRehearsal`）。
 * @param {number} [options.at] 时间戳（毫秒）。
 * @param {string} [options.inventoryError] 读取 profile 清单的错误（若有）。
 * @returns {object} 预检结果。
 */
export function aggregatePreflight(options) {
  const at = options.at ?? Date.now()
  const probes = Array.isArray(options.probes) ? options.probes : []
  const probeByName = new Map(probes.map((probe) => [probe.name, probe]))
  const warnings = []
  if (typeof options.inventoryError === 'string' && options.inventoryError !== '') {
    warnings.push({ plugin: null, kind: 'inventory', reason: options.inventoryError })
  }

  const plugins = (options.evaluated?.plugins ?? []).map((plugin) => {
    const p1 = judgeP1(plugin)
    const probe = probeByName.get(plugin.name)
    const p2 = probe === undefined
      ? { ok: true, skipped: true, reason: '未试装（不是 link:/file: 依赖）' }
      : { ok: probe.ok === true, reason: probe.detail ?? (probe.ok === true ? '装配通过' : '装配失败') }
    if (p1.verdict === 'unverified') {
      warnings.push({
        plugin: plugin.name,
        kind: 'p1-unverified',
        reason: p1.detail ?? (p1.declared === 'unverified' ? '插件没有记录该版本的验证结论' : '无法读取插件 manifest'),
      })
    }
    if (p1.declared === 'incompatible') {
      warnings.push({ plugin: plugin.name, kind: 'declared-incompatible', reason: '插件自述已知不兼容（不参与门禁）' })
    }
    return {
      name: plugin.name,
      version: plugin.version,
      enabled: plugin.enabled !== false,
      p1,
      p2,
    }
  })

  const blocked = blockedPluginNames({ plugins })
  appendP3Warnings(warnings, options.p3)
  return {
    schema: PREFLIGHT_SCHEMA,
    at,
    target: options.target,
    plugins,
    p3: options.p3 ?? null,
    blocked: blocked.length > 0,
    warnings,
  }
}

/**
 * 把 P3 的失败 / 未激活条目折成 **只警告** 的条目。
 *
 * P3 刻意不进 `blocked`：启动失败可能来自环境（端口、权限、外部服务），
 * 把它当阻断会让「预检通过」变成看运气。
 * @param {{plugin:string|null, kind:string, reason:string}[]} warnings 可变数组。
 * @param {object|null|undefined} p3 P3 结论。
 * @returns {void}
 */
export function appendP3Warnings(warnings, p3) {
  if (p3 === null || p3 === undefined || typeof p3 !== 'object') return
  if (p3.launch === 'failed') {
    warnings.push({
      plugin: null,
      kind: 'p3-failed',
      reason: typeof p3.error === 'string' && p3.error !== '' ? p3.error : '启动预演失败',
    })
    return
  }
  for (const [plugin, state] of Object.entries(p3.entries ?? {})) {
    if (state !== 'active') {
      warnings.push({ plugin, kind: 'p3-inactive', reason: '启动预演中条目未激活' })
    }
  }
}

/**
 * 从结果里挑出**阻断**项（P1 要求未满足或 P2 装不上；禁用插件不算）。
 * @param {{plugins?:object[]}} result 预检结果。
 * @returns {string[]} 插件名。
 */
export function blockedPluginNames(result) {
  const names = []
  for (const plugin of result?.plugins ?? []) {
    if (plugin?.enabled === false) continue
    if (plugin?.p1?.verdict === 'requirements' || (plugin?.p2?.ok === false && plugin?.p2?.skipped !== true)) {
      names.push(plugin.name)
    }
  }
  return names
}

/**
 * `/update` 前置门禁的纯判定。
 * @param {{result:object|null|undefined, force?:boolean}} options 输入。
 * @returns {{allowed:boolean, reason:null|'missing'|'blocked', blocked:string[]}} 判定。
 */
export function decidePreflightGate(options) {
  const { result } = options
  const force = options.force === true
  if (result === null || result === undefined || typeof result !== 'object') {
    return { allowed: force, reason: 'missing', blocked: [] }
  }
  if (result.blocked === true) {
    const blocked = blockedPluginNames(result)
    return { allowed: force, reason: 'blocked', blocked }
  }
  return { allowed: true, reason: null, blocked: [] }
}

/**
 * 一行强制升级留痕。
 * @param {object} options 输入。
 * @param {string|null} options.from 升级前版本。
 * @param {string} options.to 目标版本。
 * @param {object|null} options.result 预检结果（缺失时 null）。
 * @param {'missing'|'blocked'} options.reason 跳过原因。
 * @param {number} [options.at] 时间戳（毫秒）。
 * @returns {object} 审计条目。
 */
export function buildForceAuditEntry(options) {
  const at = options.at ?? Date.now()
  return {
    at: new Date(at).toISOString(),
    from: options.from ?? null,
    to: options.to,
    blocked: blockedPluginNames(options.result),
    reason: options.reason,
  }
}

/**
 * 读已落盘的预检结果（缺失 / 损坏都返回 null）。
 * @param {string} stateDir 状态目录。
 * @returns {Promise<object|null>} 结果。
 */
export async function readPreflight(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, PREFLIGHT_FILE), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 原子写入预检结果。
 * @param {string} stateDir 状态目录。
 * @param {object} result 结果。
 * @returns {Promise<object>} 写入的值。
 */
export async function writePreflight(stateDir, result) {
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, PREFLIGHT_FILE)
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
  return result
}

/**
 * 追加一条强制升级留痕（一行一条 JSON）。
 * @param {string} stateDir 状态目录。
 * @param {object} entry 条目（见 `buildForceAuditEntry`）。
 * @returns {Promise<void>} 完成。
 */
export async function appendForceAudit(stateDir, entry) {
  await mkdir(stateDir, { recursive: true })
  await appendFile(join(stateDir, FORCE_AUDIT_FILE), `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * 列出 profile 里可试装的 `link:` / `file:` 插件，并补上插件真实 id。
 *
 * dump-config 里是模块导出的 `name`，不是包名（见 issue #346），所以先把 id 解析出来。
 * @param {string} profileDir profile 目录。
 * @returns {Promise<{name:string, path:string, id?:string}[]>} 可试装项。
 */
export async function collectProbeTargets(profileDir) {
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  const targets = linkTargets(manifest.dependencies)
  for (const item of targets) {
    try {
      const pluginManifest = JSON.parse(await readFile(join(item.path, 'package.json'), 'utf8'))
      for (const candidate of entryCandidates(pluginManifest)) {
        let source
        try {
          source = await readFile(join(item.path, candidate), 'utf8')
        } catch {
          continue
        }
        const id = pluginIdFromSource(source)
        if (id !== undefined) {
          item.id = id
          break
        }
      }
    } catch {
      // 读不到就不设 id，runProbes 会回落到包名（行为与修复前一致）。
    }
  }
  return targets
}

/**
 * 在一个一次性 `DSH_HOME` 里跑一轮试装，并就地更新缓存文件。
 * @param {object} options 输入。
 * @param {{name:string, path:string, id?:string}[]} options.targets 试装项。
 * @param {string} options.targetVersion 目标版本（进缓存键）。
 * @param {string} options.dshBin dsh 可执行文件。
 * @param {string} options.profileName 一次性 profile 名。
 * @param {string} options.cachePath 探针缓存文件。
 * @param {(command:string, args:string[], options?:object) => Promise<{status:number|null, stdout:string}>} options.run 执行器。
 * @param {number} [options.now] 当前时间。
 * @param {string} [options.home] 复用的一次性 `DSH_HOME`（P3 要在同一个 HOME 里启动；不传则自建并清理）。
 * @param {(home:string, name:string) => Promise<unknown>} [options.ensure] 建 profile（测试缝）。
 * @returns {Promise<{results:object[], cache:object}>} 结论与更新后的缓存。
 */
export async function runProbePass(options) {
  const ownsHome = options.home === undefined
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'dsh-au-probe-'))
  try {
    let cache = {}
    try {
      cache = JSON.parse(await readFile(options.cachePath, 'utf8'))
    } catch {
      cache = {}
    }
    const { results, cache: next } = await runProbeWithProfile({
      dshHome: home,
      profileName: options.profileName,
      ...(options.ensure === undefined ? {} : { ensure: options.ensure }),
      probes: () => runProbes({
        targets: options.targets,
        targetVersion: options.targetVersion,
        dshBin: options.dshBin,
        profileName: options.profileName,
        dshHome: home,
        cache,
        now: options.now ?? Date.now(),
        run: options.run,
      }),
    })
    await writeFile(options.cachePath, `${JSON.stringify(next, null, 2)}\n`)
    return { results, cache: next }
  } finally {
    if (ownsHome) await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}
