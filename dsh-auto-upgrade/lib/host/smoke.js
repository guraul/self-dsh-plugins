/**
 * 升级后「逐插件冒烟」（issue #300 P2）。
 *
 * 试装探针（P1）只能证明「装得上」。装得上但行为坏了是另一类故障——2026-11-05 的
 * `installModelSelection` 签名变更就是：声明覆盖、装配通过、`reasoningEffort` 静默失效。
 *
 * 这里做两层：
 *   1. **宿主兜底三项**（不依赖插件配合）：在运行中的 Loader 里启用（取不到时回退
 *      `dsh.profile.bundles`）、插件目录存在、`dsh.client.inject` 声明的客户端包能解析到；
 *   2. **插件自报断言**：`package.json` 的 `dsh.smoke = { module, timeoutMs }`，模块导出
 *      `run(ctx)` → `{ ok, checks: [{ name, ok, detail? }] }`。只有插件自己知道「我的行为
 *      算不算正常」，宿主无法通用推断。
 *
 * 没写 `dsh.smoke` 的插件只跑兜底三项，结果记 `partial: true`——**不假装验过行为**。
 */

/** 单插件默认超时：超时按失败算，不许把冒烟卡死。 */
export const SMOKE_TIMEOUT_MS = 5000

/**
 * 兜底三项（纯函数，便于单测）。
 *
 * 「启用」优先看**运行中的 Loader**（`enabled`）：`cordis.patch.yml` 用 insert 声明的行不在
 * profile 的 `bundles` 里，只看 bundles 会把它们误报成「没启用」（issue #413）。
 * @param {object} input 输入。
 * @param {string} input.name 包名。
 * @param {string[]} input.bundles profile 的 `dsh.profile.bundles`。
 * @param {Iterable<string> | string[]} [input.enabled] 运行中 Loader 里未禁用的条目名；
 *   传了但不可迭代时按「取不到」处理（回退 bundles）。
 * @param {boolean} input.pluginDirExists 插件目录是否存在。
 * @param {string[]} input.inject `dsh.client.inject` 声明的包名。
 * @param {(pkg: string) => boolean | 'unknown'} input.resolvable 该客户端包能否解析到；
 *   `'unknown'` 表示平台种子表不可读、判不了（按通过算，但要在 detail 里说清楚）。
 * @returns {{name: string, ok: boolean, detail: string}[]} 三项检查。
 */
export function fallbackChecks(input) {
  // 只有真能迭代时才当「运行中 Loader 的启用名单」；传了但不可迭代（如 `{}`）说明取到的不是名单，
  // 按 undefined 回退 bundles——折成空 Set 会被误读成「全部未启用」。
  const enabled = input.enabled == null || typeof input.enabled[Symbol.iterator] !== 'function'
    ? undefined
    : new Set(input.enabled)
  const enabledNow = enabled === undefined ? input.bundles.includes(input.name) : enabled.has(input.name)
  const unknownInject = []
  const missingInject = []
  for (const pkg of input.inject) {
    const state = input.resolvable(pkg)
    if (state === true) continue
    if (state === 'unknown') unknownInject.push(pkg)
    else missingInject.push(pkg)
  }
  return [
    {
      name: 'bundle',
      ok: enabledNow,
      detail: enabled === undefined
        ? (enabledNow ? '在 dsh.profile.bundles 里启用' : '没被 profile 启用（插件不会被加载）')
        : (enabledNow ? '在运行中 Loader 里已启用' : '未在运行中的 Loader 里启用（插件不会被加载）'),
    },
    {
      name: 'installed',
      ok: input.pluginDirExists,
      detail: input.pluginDirExists ? '插件目录存在' : '插件目录不存在（软链悬空或已被删）',
    },
    {
      name: 'inject',
      ok: missingInject.length === 0,
      detail: missingInject.length > 0
        ? `客户端注入包缺失：${missingInject.join(', ')}`
        : unknownInject.length > 0
          ? `未解析到 ${unknownInject.join(', ')}（平台种子表不可读，未判定）`
          : `客户端注入包齐全（${String(input.inject.length)} 个）`,
    },
  ]
}

/**
 * 从运行中 Loader 里取未禁用的条目名。
 *
 * **事实依据**：本机 dsh `0.2.2-rc.2` 的
 * `node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js` 里，`EntryTree` 的
 * `*entries()` 是 generator（函数形）；所以「`entries` 是函数」是主路径。
 * 双形状（数组 / 可迭代对象）只是兼容性兜底——Loader 服务被替换或别家实现时也能取到。
 *
 * 返回 `undefined` 一律表示「取不到」，调用方回退 `dsh.profile.bundles`；
 * **空集合也算取不到**，否则会把「Loader 里恰好一条都没有」误判成「全部未启用」。
 * @param {unknown} loader `ctx.get('loader')` 的返回值。
 * @returns {string[] | undefined} 未禁用条目的 `options.name`；取不到 / 为空时 `undefined`。
 */
export function collectLoaderNames(loader) {
  try {
    if (loader === null || typeof loader !== 'object') return undefined
    const entries = loader.entries
    let iterable
    if (typeof entries === 'function') {
      iterable = entries.call(loader)
    } else if (entries !== null && typeof entries === 'object' && typeof entries[Symbol.iterator] === 'function') {
      iterable = entries
    } else {
      return undefined
    }
    const names = []
    for (const entry of iterable) {
      if (entry?.disabled === true) continue
      const name = entry?.options?.name
      if (typeof name === 'string' && name !== '') names.push(name)
    }
    return names.length === 0 ? undefined : names
  } catch {
    return undefined
  }
}

/**
 * 从 dsh web 前端构建产物（`dist/assets/index-*.js`）里解析平台模块表。
 *
 * 官方客户端包 `@deepseek-ai/dsh-client-ui-slots` / `...-primitives` 是**平台内置种子模块**：
 * 它们不是 npm 包、也不在启动图里，官方包自己也 inject 它们。名单只存在于打包后的
 * `staticModules` 表里，没有别的机器可读来源。
 *
 * 算法：以 `"react-dom/client":` 为锚点，往前找最近的 `{`（对象字面量起点），
 * 花括号配对到对象末尾，再用「字符串键或标识符键 + 冒号」收集键名；最后自检结果里必须
 * 同时有 `react` 与 `react-dom/client`，否则视为锚点撞到了别的对象。
 * 解析失败一律返回 `undefined`（调用方据此把该项降级为「未判定」，不许抛错）。
 * @param {string} source 构建产物文本。
 * @returns {string[] | undefined} 模块名；找不到锚点 / 花括号不配对 / 自检不过时 `undefined`。
 */
export function platformSeedsFromStaticModules(source) {
  if (typeof source !== 'string') return undefined
  const anchor = source.indexOf('"react-dom/client":')
  if (anchor === -1) return undefined
  const start = source.lastIndexOf('{', anchor)
  if (start === -1) return undefined
  let depth = 0
  let end = -1
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) return undefined
  const body = source.slice(start + 1, end)
  const names = []
  const seen = new Set()
  const keyPattern = /(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g
  let matched
  while ((matched = keyPattern.exec(body)) !== null) {
    const name = matched[1] ?? matched[2]
    if (name === undefined || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  // 自检：`"react-dom/client":` 在打包产物里不止一处，锚点可能撞到别的对象。
  // 真正的 `staticModules` 表一定同时含这两个键；缺一个就按没解析到处理，
  // 否则会把一张假表当成「种子表已知」，把真缺失洗成通过。
  if (!seen.has('react') || !seen.has('react-dom/client')) return undefined
  return names
}

/**
 * 从启动图里补官方种子名：官方行（id 在安装树能找到包）自己 inject、但既不是图行 id
 * 也不是包名的名字，就是平台种子。
 *
 * **只认官方行**：自定义插件行 inject 的未知名字不能变成种子，否则会把真缺失洗成通过。
 * @param {{id?: string, inject?: string[]}[]} graphEntries `clientModules.graph().entries`。
 * @param {(pkg: string) => boolean} packageExists 该包是否在 **dsh 安装树**里。
 * @returns {string[]} 种子名。
 */
export function officialInjectSeeds(graphEntries, packageExists) {
  const entries = Array.isArray(graphEntries) ? graphEntries : []
  const ids = new Set(entries.map((entry) => entry?.id).filter((id) => typeof id === 'string'))
  const seeds = []
  const seen = new Set()
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || packageExists(entry.id) !== true) continue
    for (const dependency of Array.isArray(entry.inject) ? entry.inject : []) {
      if (typeof dependency !== 'string' || dependency === '') continue
      if (ids.has(dependency) || packageExists(dependency) === true) continue
      if (seen.has(dependency)) continue
      seen.add(dependency)
      seeds.push(dependency)
    }
  }
  return seeds
}

/**
 * 造一个客户端包解析器。
 *
 * 判据是「三选一」：启动图行 / 安装树或 profile 里能解析的包 / 平台种子名。
 * 前两个是确定事实；种子表读不到时 `seedsKnown === false`，此时解析不到只能算
 * `'unknown'`（判不了，不是缺失），不许判红。
 * @param {object} input 输入。
 * @param {Iterable<string>} input.graphIds 启动图里的行 id。
 * @param {(pkg: string) => boolean} input.packageExists 安装树 / profile 里是否存在该包。
 * @param {Iterable<string>} [input.seeds] 平台种子名。
 * @param {boolean} [input.seedsKnown] 种子表是否读到了。
 * @returns {(pkg: string) => true | false | 'unknown'} 解析器。
 */
export function createInjectResolver(input) {
  const graphIds = new Set(input.graphIds ?? [])
  const seeds = new Set(input.seeds ?? [])
  const seedsKnown = input.seedsKnown === true
  return (pkg) => {
    if (typeof pkg !== 'string' || pkg === '') return false
    if (graphIds.has(pkg)) return true
    if (input.packageExists(pkg) === true) return true
    if (seeds.has(pkg)) return true
    return seedsKnown ? false : 'unknown'
  }
}

/**
 * 把插件自报的结果规整成统一形状；脏数据按失败处理（宁可报红，不许静默当通过）。
 * @param {unknown} result 插件 `run()` 的返回值。
 * @returns {{ok: boolean, checks: object[], detail?: string}} 规整后的结果。
 */
export function normalizeSmoke(result) {
  if (result === null || typeof result !== 'object') {
    return { ok: false, checks: [], detail: `冒烟模块返回值不是对象：${typeof result}` }
  }
  const checks = Array.isArray(result.checks)
    ? result.checks.map((check) => ({
      name: typeof check?.name === 'string' ? check.name : 'unnamed',
      ok: check?.ok === true,
      detail: typeof check?.detail === 'string' ? check.detail : undefined,
    }))
    : []
  const ok = result.ok === true && checks.every((check) => check.ok)
  return { ok, checks, ...(ok ? {} : { detail: result.ok === true ? '有检查项失败' : '插件自报 ok=false' }) }
}

/**
 * 跑一个插件的冒烟：兜底三项 + （若有）自报断言。
 * @param {object} options 输入。
 * @param {{name: string, dir: string, inject: string[], smoke?: {module?: string, timeoutMs?: number}}} options.plugin 插件事实。
 * @param {string[]} options.bundles profile 的 bundles。
 * @param {Iterable<string> | string[]} [options.enabled] 运行中 Loader 的启用条目名（缺省回退 bundles）。
 * @param {(pkg: string) => boolean | 'unknown'} options.resolvable 客户端包解析器。
 * @param {(plugin: object, modulePath: string) => Promise<unknown>} options.importModule 动态导入（测试可注入）。
 * @param {object} [options.context] 宿主事实（版本 / 安装目录等），原样交给插件的 `run()`。
 * @param {number} [options.timeoutMs] 覆盖默认超时。
 * @returns {Promise<object>} `{name, ok, partial, hasSmoke, selfOk?, checks, detail?}`。
 */
export async function runSmoke(options) {
  const { plugin } = options
  const checks = fallbackChecks({
    name: plugin.name,
    bundles: options.bundles,
    enabled: options.enabled,
    pluginDirExists: plugin.dirExists !== false,
    inject: plugin.inject ?? [],
    resolvable: options.resolvable,
  })
  if (typeof plugin.smoke?.module !== 'string') {
    return {
      name: plugin.name,
      ok: checks.every((check) => check.ok),
      partial: true,
      hasSmoke: false,
      checks,
      detail: '插件的 package.json 里没有 dsh.smoke：只验了兜底三项，行为未验证',
    }
  }
  const timeoutMs = plugin.smoke.timeoutMs ?? options.timeoutMs ?? SMOKE_TIMEOUT_MS
  let self
  try {
    const module = await options.importModule(plugin, plugin.smoke.module)
    if (typeof module?.run !== 'function') throw new Error('dsh.smoke 模块没有导出 run()')
    const raced = await Promise.race([
      module.run({ name: plugin.name, ...options.context }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`冒烟超时（${String(timeoutMs)}ms）`)), timeoutMs).unref?.()),
    ])
    self = normalizeSmoke(raced)
  } catch (error) {
    self = { ok: false, checks: [], detail: error instanceof Error ? error.message : String(error) }
  }
  const all = [...checks, ...self.checks]
  return {
    name: plugin.name,
    ok: all.every((check) => check.ok) && self.ok,
    partial: false,
    // `selfOk` 单独留一份：启动冒烟要靠它区分「插件自报失败」（可运行时摘掉）
    // 与「兜底三项失败」（只报不摘，issue #429）。
    hasSmoke: true,
    selfOk: self.ok,
    checks: all,
    ...(self.detail === undefined ? {} : { detail: self.detail }),
  }
}

/**
 * 跑一批插件的冒烟。
 * @param {object} options 输入（`plugins` / `bundles` / `enabled` / `resolvable` / `importModule` / `timeoutMs`）。
 * @returns {Promise<{results: object[]}>} 每个插件的结论。
 */
export async function runSmokes(options) {
  /** @type {object[]} */
  const results = []
  for (const plugin of options.plugins) {
    // 串行：冒烟会跑插件自己的代码，并发容易互相干扰（也会抢同一个 profile）。
    results.push(await runSmoke({ ...options, plugin }))
  }
  return { results }
}
