/**
 * 升级前「试装」探针（issue #300）：声明覆盖 ≠ 装得上。一次性 `DSH_HOME` 里用当前 dsh
 * 把插件真装一遍，判据两条——① `plugin add` 退出码 0；② `--dump-config` 里出现插件 id。
 * 结论只作警告，不进阻断判定（装配失败率极低，误伤代价高）。 */

/** 结论缓存有效期：一天。同一 (目标版本, 插件, 插件目录 mtime) 不重复试装。 */
export const PROBE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 判定逻辑的版本：改了「怎么判」就把这个数 +1。
 * 它进了缓存 key，所以旧版本写下的结论会整体失效，不会被原样回放（#346 review 的 blocker）。
 */
export const PROBE_CACHE_SCHEMA = 3

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
 * 从插件入口源码里取它**真正的 id**（`export const name = '…'`）。
 *
 * DSH 的插件 id 来自模块导出的 `name`，**不是** `package.json` 的包名：
 * `dsh-plugin-auto-upgrade` 的 id 是 `dsh-auto-upgrade`、`@mhfire/dsh-im-bridge` 是 `im-bridge`。
 * 拿包名去比对 dump 里的 id，会一个都对不上（2026-11-06 真机全量误报就是这么来的）。
 * @param {string} text 入口文件源码。
 * @returns {string|undefined} id；没写 `name` 导出时 undefined。
 */
export function pluginIdFromSource(text) {
  // 先剥注释：入口里注释掉的旧写法（`// module.exports.name = 'old'`）不能抢先命中。
  const source = String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const patterns = [
    /export\s+const\s+name\s*=\s*(['"])([^'"]+)\1/,                                     // export const name = 'x'
    /(?:module\.)?exports(?:\.name|\[\s*(['"])name\1\s*\])\s*=\s*(['"])([^'"]+)\2/,       // module.exports.name = 'x'
    /(?:module\.)?exports\s*=\s*\{[^}]*?\bname\s*:\s*(['"])([^'"]+)\1/s,                    // module.exports = { name: 'x' }
    /export\s+default\s+(?:definePlugin\s*\(\s*)?\{[^}]*?\bname\s*:\s*(['"])([^'"]+)\1/s,    // export default { name: 'x' }
    /definePlugin\s*\(\s*\{[^}]*?\bname\s*:\s*(['"])([^'"]+)\1/s,                          // definePlugin({ name: 'x' })
  ]
  for (const pattern of patterns) {
    const matched = pattern.exec(source)
    if (matched !== null) {
      // 各写法的捕获组位置不同：取最后一个捕获组就是 id。
      return matched[matched.length - 1]
    }
  }
  return undefined
}

/**
 * 猜入口文件（按 `exports["."]` → `main` → `lib/index.js` → `index.js` 试）。
 * @param {object|undefined} manifest 插件 package.json。
 * @returns {string[]} 相对路径候选，按优先级排列。
 */
export function entryCandidates(manifest) {
  const out = []
  const exported = manifest?.exports
  if (typeof exported === 'string') out.push(exported)
  else if (exported !== null && typeof exported === 'object') {
    const dot = exported['.']
    if (typeof dot === 'string') out.push(dot)
    else if (dot !== null && typeof dot === 'object') {
      for (const key of ['default', 'import', 'require', 'node']) {
        if (typeof dot[key] === 'string') out.push(dot[key])
      }
    }
  }
  if (typeof manifest?.main === 'string') out.push(manifest.main)
  out.push('lib/index.js', 'index.js', 'dist/index.js')
  return [...new Set(out)]
}

/**
 * 从 `--dump-config` 输出里抽出**所有**插件 id。
 *
 * 试装判据不再猜「这个插件的 id 叫什么」，而是比较 add 前后的 id 集合：
 * 多出来的那个就是它（`dsh-usage-panel` 的 id 其实是 `usage-stats`，猜不准）。
 * @param {string} text dump 输出。
 * @returns {Set<string>} id 集合。
 */
export function idsFromDump(text) {
  const ids = new Set()
  for (const raw of String(text ?? '').split('\n')) {
    // 只认**顶层列表项** `- id: x`：`config:` 里嵌套的 `id:`（provider / model / mcp）缩进更深，
    // 用宽松正则会把它们一起收进来，「新增」就不一定是插件了（#361 review 的 major）。
    const line = raw.replace(/\s+#.*$/, '')
    const matched = /^-\s+id:\s*(.+?)\s*$/.exec(line)
    if (matched === null) continue
    ids.add(matched[1].replace(/^['"]|['"]$/g, ''))
  }
  return ids
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
  // 有 add 前后的 id 集合就用**差集**判定：不依赖「插件的 id 叫什么」，也就不用猜。
  if (result.beforeIds instanceof Set && result.afterIds instanceof Set) {
    const added = [...result.afterIds].filter((id) => !result.beforeIds.has(id))
    if (added.length > 0) return { ok: true, detail: `装配通过（新增 ${added.join('、')}）` }
    return { ok: false, detail: '装了但没进 profile（dump 里没有新增插件）' }
  }
  // 没有基线就**不下结论**：拿「从源码猜出来的 id」兜底，正是本 PR 要消灭的不可靠判据。
  if (result.beforeIds === undefined) {
    return { ok: false, detail: '基线 --dump-config 不可用，无法判定（不等于「没进 profile」）' }
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
  // 第三个字段是**缓存 schema 版本**：改了探针的判定逻辑就 +1，
  // 否则旧版本写进去的结论会被原样回放，修复在 TTL 内表现为「不生效」（#346 review 的 blocker）。
  return `${PROBE_CACHE_SCHEMA}|${options.targetVersion}|${options.name}|${options.mtimeMs ?? 0}`
}

/**
 * 把缓存文件的键拆回字段，供界面直接用。
 *
 * 键格式是 `<schema>|<目标版本>|<包名>|<mtime>`（见 `probeKey`）。两件事必须做对：
 * 1. **段数不对的旧键要丢**：0.9.2 之前写的是三段 `版本|包名|mtime`，解析出来会把版本号当插件名；
 * 2. **schema 与当前不一致的要丢**：那是旧判定逻辑留下的结论，回放会误导人。
 * @param {Record<string, {at?: number, ok?: boolean, detail?: string}>} cache 缓存文件内容。
 * @param {number} now 当前时间（毫秒）。
 * @param {number} [schema] 当前判定逻辑版本。
 * @returns {{version: string, name: string, ok: boolean, detail?: string, at?: number, stale: boolean}[]} 供 UI 的条目。
 */
export function probeCacheEntries(cache, now, schema = PROBE_CACHE_SCHEMA) {
  /** @type {Map<string, {version: string, name: string, mtime: number, entry: object}>} */
  const byName = new Map()
  for (const [key, value] of Object.entries(cache ?? {})) {
    const parts = String(key).split('|')
    if (parts.length !== 4) continue
    const [keySchema, version, name, mtimeText] = parts
    if (keySchema !== String(schema)) continue
    const mtime = Number(mtimeText)
    // 键里带 mtime：插件一更新就会多出一条同名的键，旧键又不会被删。
    // 同名只留 mtime 最大的那条，否则界面会重复展示（正是 #359 的「10 条变 20 条」）。
    const previous = byName.get(name)
    if (previous !== undefined && previous.mtime >= (Number.isFinite(mtime) ? mtime : 0)) continue
    byName.set(name, { version, name, mtime: Number.isFinite(mtime) ? mtime : 0, entry: value })
  }
  return [...byName.values()].map(({ version, name, entry }) => ({
    version,
    name,
    ok: entry?.ok === true,
    ...(entry?.detail === undefined ? {} : { detail: entry.detail }),
    ...(entry?.at === undefined ? {} : { at: entry.at }),
    stale: !cacheHit(entry, now),
  }))
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
 * 跑一批探针：命中缓存就直接用，否则真装一遍。
 * @param {object} options 输入：`targets` / `targetVersion` / `dshBin` / `profileName` /
 *   `dshHome`（一次性）/ `cache`（就地更新）/ `now` / `run`（执行器，生产是 `toolchain.run`）。
 * @returns {Promise<{results: object[], cache: object}>} 每个插件的结论与更新后的缓存。
 */
export async function runProbes(options) {
  const cache = { ...options.cache }
  /** @type {object[]} */
  const results = []
  for (const target of options.targets) {
    // 比对用**插件 id**（模块导出的 name），显示仍用包名。
    const id = target.id ?? target.name
    const idFallback = target.id === undefined
    const key = probeKey({ targetVersion: options.targetVersion, name: target.name, mtimeMs: target.mtimeMs })
    const cached = cache[key]
    if (cacheHit(cached, options.now)) {
      results.push({ name: target.name, id, idFallback, ok: cached.ok === true, detail: cached.detail, cached: true })
      continue
    }
    const commands = buildProbeCommands({
      dshBin: options.dshBin,
      pluginPath: target.path,
      profileName: options.profileName,
    })
    const env = { ...process.env, DSH_HOME: options.dshHome }
    // 先 dump 一次记下现有的 id；装完再 dump 一次，差集就是「这次装进去的东西」。
    const before = await options.run(commands.dump[0], commands.dump.slice(1), { env })
    // `?? 0` 会把 spawn 失败（status 为 null）当成成功，得到空基线 → 把既有 id 全算成新增 → 误放行。
    const beforeExit = before.status ?? before.code ?? null
    const beforeIds = beforeExit === 0 ? idsFromDump(before.stdout) : undefined
    const added = await options.run(commands.add[0], commands.add.slice(1), { env })
    const addExit = added.status ?? added.code ?? null
    const dumped = addExit === 0
      ? await options.run(commands.dump[0], commands.dump.slice(1), { env })
      : { status: null, stdout: '' }
    const verdict = judgeProbe({
      addExit,
      dumpExit: dumped.status ?? dumped.code ?? null,
      dumpText: dumped.stdout,
      pluginName: id,
      beforeIds,
      afterIds: (dumped.status ?? dumped.code ?? 0) === 0 ? idsFromDump(dumped.stdout) : undefined,
    })
    cache[key] = { at: options.now, ok: verdict.ok, detail: verdict.detail }
    const detail = idFallback && verdict.ok === false
      ? `${verdict.detail}（未能从入口解析插件 id，退回按包名比对，结论仅供参考）`
      : verdict.detail
    results.push({ name: target.name, id, idFallback, ok: verdict.ok, detail, cached: false })
  }
  return { results, cache }
}
