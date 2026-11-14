/**
 * 升级后第一次启动的冒烟结论落盘（issue #429）。
 *
 * 冒烟本身早就有了（`/smoke`，issue #300 P2），但只有人**主动点**才跑；升级后真正该跑的
 * 那一次启动反而没人验。这里补上：
 *
 *   1. 启动完成后跑一次 `runSmokes`（兜底三项 + 插件 `dsh.smoke`）；
 *   2. 结论写成 `stateDir/boot-check.json`（schema 1，契约见 issue #429），
 *      供 GUI #422 / 进度页 #423 直接读；
 *   3. **自报失败**的插件当场从运行时摘掉（dispose 它的 Loader fiber），**不写 profile**——
 *      重启就恢复。兜底三项失败只报不摘：目录没了 / 注入包缺不是「摘掉就能好」，
 *      而且摘掉会掩盖问题。
 *
 * 核心插件（升级器自己与 subagents）永不摘：升级器被摘掉就没有后续的检测/回滚入口了。
 * @module dsh-plugin-auto-upgrade/host/boot-check
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { maybeReportSmokeFailures } from './smoke-issue.js'

/** 结果文件 schema 版本。 */
export const BOOT_CHECK_SCHEMA = 1
/** 结果文件名。 */
export const BOOT_CHECK_FILE = 'boot-check.json'
/** 永不禁用的核心插件。 */
export const CORE_PLUGINS = ['dsh-plugin-auto-upgrade', 'dsh-plugin-subagents']

/**
 * 是否核心插件（豁免运行时禁用）。
 * @param {string} name 包名。
 * @returns {boolean} 核心插件返回 true。
 */
export function isCorePlugin(name) {
  return CORE_PLUGINS.includes(name)
}

/**
 * 版本没变且已有结果就跳过——「升级后的第一次启动」只跑一次。
 * @param {{lastBootCheckVersion?: unknown, dshVersion?: unknown, hasResult: boolean}} input 输入。
 * @returns {boolean} 该跳过返回 true。
 */
export function shouldSkipBootCheck(input) {
  if (input.hasResult !== true) return false
  if (typeof input.dshVersion !== 'string' || input.dshVersion === '') return false
  return input.lastBootCheckVersion === input.dshVersion
}

/**
 * 把一条冒烟结果压成契约里的形状（丢掉 `partial` / `selfOk` 等内部字段）。
 * @param {object} result `runSmokes` 的一条结果。
 * @returns {{name: string, ok: boolean, checks: object[]}} 契约结果。
 */
export function toBootCheckResult(result) {
  const checks = Array.isArray(result?.checks)
    ? result.checks.map((check) => ({
      name: typeof check?.name === 'string' ? check.name : 'unnamed',
      ok: check?.ok === true,
      ...(typeof check?.detail === 'string' ? { detail: check.detail } : {}),
    }))
    : []
  return {
    name: typeof result?.name === 'string' ? result.name : 'unknown',
    ok: result?.ok === true,
    checks,
  }
}

/**
 * 在运行中的 Loader 里按包名找条目（会遍历嵌套子树）。
 * @param {unknown} loader `ctx.get('loader')` 的返回值。
 * @param {string} name 包名。
 * @returns {object|undefined} Loader entry；取不到时 undefined。
 */
export function findLoaderEntry(loader, name) {
  try {
    if (loader === null || typeof loader !== 'object' || typeof loader.entries !== 'function') return undefined
    for (const entry of loader.entries()) {
      if (entry?.options?.name === name) return entry
    }
  } catch {
    /* Loader 被替换 / 迭代中途抛错：当作取不到 */
  }
  return undefined
}

/**
 * 运行时禁用一个已加载的插件：**只 dispose fiber，不动 profile**。
 *
 * 找不到条目时返回 `disabled:false`，由调用方如实不记进 `disabled`（不能假装摘掉了）。
 * @param {unknown} loader Loader 服务。
 * @param {string} name 包名。
 * @returns {Promise<{disabled: boolean, reason?: string}>} 结果。
 */
export async function disableLoadedPlugin(loader, name) {
  const entry = findLoaderEntry(loader, name)
  if (entry === undefined) return { disabled: false, reason: 'no-loader-entry' }
  const fiber = entry.fiber
  if (fiber === null || typeof fiber !== 'object' || typeof fiber.dispose !== 'function') {
    return { disabled: false, reason: 'no-fiber' }
  }
  try {
    await fiber.dispose()
    return { disabled: true }
  } catch (error) {
    return { disabled: false, reason: `dispose-failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 读已有结果（缺失 / 损坏都返回 undefined）。
 * @param {string} stateDir 状态目录。
 * @returns {Promise<object|undefined>} 结果。
 */
export async function readBootCheck(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, BOOT_CHECK_FILE), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * 原子写结果（临时文件 + rename，与 `JsonStore` 同一手法）。
 * @param {string} stateDir 状态目录。
 * @param {object} report 结果。
 * @returns {Promise<string>} 写入的绝对路径。
 */
export async function writeBootCheck(stateDir, report) {
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, BOOT_CHECK_FILE)
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
  return path
}

/**
 * 从冒烟结果里判定处置：哪些自报失败该摘、哪些只是兜底失败、哪些没验证过。
 * @param {object[]} results `runSmokes` 的结果。
 * @returns {{problems: object[], selfFailed: object[], fallbackFailed: object[], unverified: string[]}} 判定。
 */
export function classifyResults(results) {
  const list = Array.isArray(results) ? results : []
  const failed = list.filter((item) => item?.ok === false)
  return {
    problems: failed,
    selfFailed: failed.filter((item) => item.hasSmoke === true && item.selfOk === false),
    fallbackFailed: failed.filter((item) => item.hasSmoke !== true || item.selfOk !== false),
    unverified: list.filter((item) => item?.partial === true).map((item) => item.name),
  }
}

/**
 * 跑一次启动冒烟、处置、落盘，必要时开 issue。
 *
 * 返回结构就是写进 `boot-check.json` 的结构（契约 schema 1）。
 * @param {object} options 输入。
 * @param {() => Promise<{results: object[]}>} options.smoke 冒烟执行器（通常包一层 `runSmokes`）。
 * @param {string} options.stateDir 状态目录。
 * @param {string} [options.dshVersion] 当前 dsh 版本（契约里的 `to`）。
 * @param {string} [options.from] 升级前版本（契约里的 `from`）。
 * @param {number} [options.at] 时间戳（测试可注入）。
 * @param {(name: string) => Promise<{disabled: boolean, reason?: string}>} [options.disable] 运行时禁用函数。
 * @param {string} [options.slug] 仓库 slug；给了才会开 issue。
 * @param {(input: {slug: string, title: string, body: string}) => Promise<{number: number, created?: boolean}>} [options.report] 开单函数。
 * @returns {Promise<object>} 写盘的结果。
 */
export async function runBootCheck(options) {
  const at = typeof options.at === 'number' ? options.at : Date.now()
  const to = typeof options.dshVersion === 'string' && options.dshVersion !== '' ? options.dshVersion : 'unknown'
  const from = typeof options.from === 'string' && options.from !== '' ? options.from : 'unknown'
  const { results } = await options.smoke()
  const classified = classifyResults(results)

  const disabled = []
  for (const item of classified.selfFailed) {
    if (isCorePlugin(item.name)) {
      console.warn(`[dsh-auto-upgrade] ${String(item.name)} 自报冒烟失败，但它是核心插件，豁免运行时禁用`)
      continue
    }
    const outcome = typeof options.disable === 'function'
      ? await options.disable(item.name)
      : { disabled: false, reason: 'no-disabler' }
    if (outcome?.disabled === true) disabled.push(item.name)
    else console.warn(`[dsh-auto-upgrade] ${String(item.name)} 自报冒烟失败但未能运行时禁用：${String(outcome?.reason ?? 'unknown')}`)
  }

  const report = {
    schema: BOOT_CHECK_SCHEMA,
    at,
    from,
    to,
    problems: classified.problems.length,
    disabled,
    unverified: classified.unverified,
    results: (Array.isArray(results) ? results : []).map(toBootCheckResult),
  }
  await writeBootCheck(options.stateDir, report)

  if (classified.problems.length > 0) {
    const reported = await maybeReportSmokeFailures({
      version: to,
      results: classified.problems,
      at,
      slug: options.slug,
      report: options.report,
    })
    if (reported.opened) {
      console.warn(`[dsh-auto-upgrade] 启动冒烟失败已关联 issue #${String(reported.number)}（created=${String(reported.created)}）`)
    } else if (reported.reason !== 'no-failures') {
      console.warn(`[dsh-auto-upgrade] 启动冒烟失败但未开 issue：${String(reported.reason)}`)
    }
  }

  return report
}
