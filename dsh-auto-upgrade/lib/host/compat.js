/**
 * 已装插件的兼容性预检。
 *
 * 判定用官方 API（`evaluatePluginCompatibility` / `readProfileVersionExemptions`），
 * 判定的对象是**准备升级到的目标版本**，而不是当前运行版本——这才是"升级前预检"。
 * @module dsh-plugin-auto-upgrade/host/compat
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 读一个已装插件的 manifest。
 * @param {string} profileDir profile 目录。
 * @param {string} name 依赖名（含 npm 别名时的键名）。
 * @returns {Promise<{manifest?:object, path:string, error?:string}>} 结果。
 */
export async function readPluginManifest(profileDir, name) {
  const candidates = [join(profileDir, 'node_modules', name, 'package.json')]
  for (const path of candidates) {
    try {
      return { manifest: JSON.parse(await readFile(path, 'utf8')), path }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error?.code !== 'ENOENT') return { path, error: message }
    }
  }
  return { path: candidates[0], error: 'package.json not found' }
}

/**
 * 把 profile 的依赖清单逐条判成"对目标版本是否兼容"。
 * @param {object} options 输入。
 * @param {any} options.official 官方 app-boot 模块。
 * @param {string} options.profileDir profile 目录。
 * @param {readonly {name:string, version:string, bundle:boolean, enabled:boolean}[]} options.dependencies 依赖清单。
 * @param {string} options.targetVersion 准备升级到的版本。
 * @returns {Promise<{plugins:object[], incompatible:object[], exemptions:Record<string,string[]>}>} 判定结果。
 */
export async function evaluatePlugins(options) {
  const { official, profileDir, dependencies, targetVersion } = options
  /** @type {Record<string, string[]>} */
  let exemptions = {}
  try {
    exemptions = official.readProfileVersionExemptions(profileDir) ?? {}
  } catch {
    exemptions = {}
  }
  const plugins = []
  for (const dependency of dependencies) {
    const { manifest, path, error } = await readPluginManifest(profileDir, dependency.name)
    if (manifest === undefined) {
      plugins.push({
        name: dependency.name,
        version: dependency.version,
        bundle: dependency.bundle,
        enabled: dependency.enabled,
        compatible: true, // 读不到 manifest 不是"不兼容"，是"信息不足"，如实标注
        known: false,
        exempted: false,
        peers: {},
        detail: error === undefined ? undefined : `无法读取插件 manifest：${error} (${path})`,
      })
      continue
    }
    let issue
    try {
      issue = official.evaluatePluginCompatibility(manifest, exemptions, targetVersion)
    } catch (failure) {
      plugins.push({
        name: dependency.name,
        version: dependency.version,
        bundle: dependency.bundle,
        enabled: dependency.enabled,
        compatible: false,
        known: true,
        exempted: false,
        peers: {},
        detail: `兼容性判定失败：${failure instanceof Error ? failure.message : String(failure)}`,
      })
      continue
    }
    if (issue === undefined) {
      plugins.push({
        name: dependency.name,
        version: dependency.version,
        bundle: dependency.bundle,
        enabled: dependency.enabled,
        compatible: true,
        known: true,
        exempted: false,
        peers: {},
      })
      continue
    }
    let detail
    try {
      detail = official.pluginCompatibilityWarning(issue)
    } catch {
      detail = undefined
    }
    plugins.push({
      name: issue.name ?? dependency.name,
      version: issue.version ?? dependency.version,
      bundle: dependency.bundle,
      enabled: dependency.enabled,
      compatible: false,
      known: true,
      exempted: issue.exempted === true,
      peers: issue.peers ?? {},
      runtimeVersion: issue.runtimeVersion,
      detail,
    })
  }
  return {
    plugins,
    incompatible: plugins.filter((plugin) => plugin.compatible === false && plugin.exempted !== true && plugin.enabled !== false),
    exemptions,
  }
}

/**
 * 读 profile 依赖清单（官方 API；读不到时退回自己解析 profile 的 package.json）。
 * @param {any} official 官方 app-boot 模块。
 * @param {{binName:string, profileDir:string, installAnchor:string}} location 解析输入。
 * @returns {Promise<{dependencies:object[], error?:string}>} 清单。
 */
export async function readInventory(official, location) {
  try {
    const inventory = official.readProfilePlugins(location)
    return { dependencies: [...inventory.dependencies] }
  } catch (error) {
    return {
      dependencies: [],
      error: `读取 profile 插件清单失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
