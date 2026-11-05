/**
 * 升级前「试装」探针（issue #300）：声明覆盖 ≠ 装得上。一次性 `DSH_HOME` 里用当前 dsh
 * 把插件真装一遍，判据两条——① `plugin add` 退出码 0；② `--dump-config` 里出现插件 id。
 * 结论只作警告，不进阻断判定（装配失败率极低，误伤代价高）。 */

/** 结论缓存有效期：一天。同一 (目标版本, 插件, 插件目录 mtime) 不重复试装。 */
export const PROBE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 从 profile 的 `dependencies` 里挑出「本机路径型」插件（只有 `link:` / `file:` 能用路径装回去）。
 * @param {Record<string, unknown>} dependencies profile 的 `dependencies`。
 * @returns {{name: string, path: string}[]} 可试装的插件（含绝对路径）。
 */
export function linkTargets(dependencies) {
  /** @type {{name: string, path: string}[]} */
  const targets = []
  for (const [name, spec] of Object.entries(dependencies ?? {})) {
    if (typeof spec !== 'string') continue
    const matched = /^(?:link|file):(.+)$/.exec(spec)
    if (matched === null) continue
    targets.push({ name, path: matched[1] })
  }
  return targets
}

/**
 * 一次探针要跑的两条命令（argv 形态，不拼 shell 字符串）。
 * @param {{dshBin: string, pluginPath: string, profileName: string}} options 输入。
 * @returns {{add: string[], dump: string[]}} 两条 argv。
 */
export function buildProbeCommands(options) {
  return {
    add: [options.dshBin, 'plugin', '--profile', options.profileName, 'add', options.pluginPath],
    dump: [options.dshBin, '--profile', options.profileName, '--dump-config'],
  }
}

/**
 * `--dump-config` 里是否**恰好**有这条插件（`- id: <名字>` 行）。
 * 不用 `includes`：同一次性 profile 里插件是顺序 add 的，后装的插件 dump 里会带上前面
 * 装过的名字；子串匹配还会被「名字是另一个名字的前缀」骗到。
 * @param {string} text `--dump-config` 输出。
 * @param {string} name 插件名。
 * @returns {boolean} 命中返回 true。
 */
export function probeHasPlugin(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\n)\\s*-?\\s*id:\\s*["']?${escaped}["']?\\s*(\\n|$)`).test(text)
}

/**
 * 判定一次探针（纯函数，便于单测）。
 * @param {{addExit: number|null, dumpExit?: number|null, dumpText?: string, pluginName: string}} result 原始结果。
 * @returns {{ok: boolean, detail: string}} 结论。
 */
export function judgeProbe(result) {
  if (result.addExit !== 0) {
    return { ok: false, detail: `plugin add 退出码 ${String(result.addExit)}` }
  }
  if (result.dumpExit !== 0) {
    return { ok: false, detail: `--dump-config 退出码 ${String(result.dumpExit)}` }
  }
  const text = typeof result.dumpText === 'string' ? result.dumpText : ''
  if (!probeHasPlugin(text, result.pluginName)) {
    return { ok: false, detail: '--dump-config 里没有该插件（装了但没进 profile）' }
  }
  return { ok: true, detail: '装配通过' }
}

/**
 * 缓存键：目标版本 + 插件名 + 插件目录 mtime。@param {{targetVersion: string, name: string, mtimeMs?: number}} options 输入。
 * @returns {string} 键。
 */
export function probeKey(options) {
  return `${options.targetVersion}|${options.name}|${options.mtimeMs ?? 0}`
}

/**
 * 缓存里的结论还能不能用。
 * @param {{at?: number, ok?: boolean, detail?: string}|undefined} entry 缓存条目。
 * @param {number} now 当前时间（毫秒）。
 * @param {number} [ttlMs] 有效期。
 * @returns {boolean} 可复用返回 true。
 */
export function cacheHit(entry, now, ttlMs = PROBE_TTL_MS) {
  if (entry === undefined || typeof entry.at !== 'number') return false
  if (!Number.isFinite(entry.at)) return false
  // at 在「未来」说明时钟被改过或文件被手改，不能当新鲜结论。
  if (entry.at > now) return false
  return now - entry.at <= ttlMs
}

/**
 * 跑一批探针：命中缓存就直接用，否则真装一遍。`run` 由调用方注入（生产是
 * `toolchain.run`），单测因此不必 spawn。
 * @param {object} options 输入。
 * @param {{name: string, path: string, mtimeMs?: number}[]} options.targets 待试装插件。
 * @param {string} options.targetVersion 目标 dsh 版本（只用于缓存键与展示）。
 * @param {string} options.dshBin dsh 可执行文件。
 * @param {string} options.profileName 一次性 profile 名。
 * @param {string} options.dshHome 一次性 DSH_HOME。
 * @param {Record<string, {at: number, ok: boolean, detail: string}>} options.cache 现有缓存（会被就地更新）。
 * @param {number} options.now 当前时间。
 * @param {(command: string, args: string[], options?: object) => Promise<{status?: number|null, code?: number|null, stdout?: string}>} options.run 执行器（`toolchain.run` 的 `code` 也接受）。
 * @returns {Promise<{results: object[], cache: object}>} 每个插件的结论与更新后的缓存。
 */
export async function runProbes(options) {
  const cache = { ...options.cache }
  /** @type {object[]} */
  const results = []
  for (const target of options.targets) {
    const key = probeKey({ targetVersion: options.targetVersion, name: target.name, mtimeMs: target.mtimeMs })
    const cached = cache[key]
    if (cacheHit(cached, options.now)) {
      results.push({ name: target.name, ok: cached.ok === true, detail: cached.detail, cached: true })
      continue
    }
    const commands = buildProbeCommands({
      dshBin: options.dshBin,
      pluginPath: target.path,
      profileName: options.profileName,
    })
    const env = { ...process.env, DSH_HOME: options.dshHome }
    const added = await options.run(commands.add[0], commands.add.slice(1), { env })
    const addExit = added.status ?? added.code ?? null
    const dumped = addExit === 0
      ? await options.run(commands.dump[0], commands.dump.slice(1), { env })
      : { status: null, stdout: '' }
    const verdict = judgeProbe({
      addExit,
      dumpExit: dumped.status ?? dumped.code ?? null,
      dumpText: dumped.stdout,
      pluginName: target.name,
    })
    cache[key] = { at: options.now, ok: verdict.ok, detail: verdict.detail }
    results.push({ name: target.name, ok: verdict.ok, detail: verdict.detail, cached: false })
  }
  return { results, cache }
}
