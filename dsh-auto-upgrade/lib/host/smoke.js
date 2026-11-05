/**
 * 升级后「逐插件冒烟」（issue #300 P2）。
 *
 * 试装探针（P1）只能证明「装得上」。装得上但行为坏了是另一类故障——2026-11-05 的
 * `installModelSelection` 签名变更就是：声明覆盖、装配通过、`reasoningEffort` 静默失效。
 *
 * 这里做两层：
 *   1. **宿主兜底三项**（不依赖插件配合）：在 `dsh.profile.bundles` 里启用、插件目录存在、
 *      `dsh.client.inject` 声明的客户端包能解析到；
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
 * @param {object} input 输入。
 * @param {string} input.name 包名。
 * @param {string[]} input.bundles profile 的 `dsh.profile.bundles`。
 * @param {boolean} input.pluginDirExists 插件目录是否存在。
 * @param {string[]} input.inject `dsh.client.inject` 声明的包名。
 * @param {(pkg: string) => boolean} input.resolvable 该客户端包能否从 profile 解析到。
 * @returns {{name: string, ok: boolean, detail: string}[]} 三项检查。
 */
export function fallbackChecks(input) {
  const missingInject = input.inject.filter((pkg) => !input.resolvable(pkg))
  return [
    {
      name: 'bundle',
      ok: input.bundles.includes(input.name),
      detail: input.bundles.includes(input.name) ? '在 dsh.profile.bundles 里启用' : '没被 profile 启用（插件不会被加载）',
    },
    {
      name: 'installed',
      ok: input.pluginDirExists,
      detail: input.pluginDirExists ? '插件目录存在' : '插件目录不存在（软链悬空或已被删）',
    },
    {
      name: 'inject',
      ok: missingInject.length === 0,
      detail: missingInject.length === 0
        ? `客户端注入包齐全（${String(input.inject.length)} 个）`
        : `客户端注入包缺失：${missingInject.join(', ')}`,
    },
  ]
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
 * @param {(pkg: string) => boolean} options.resolvable 客户端包解析器。
 * @param {(plugin: object, modulePath: string) => Promise<unknown>} options.importModule 动态导入（测试可注入）。
 * @param {object} [options.context] 宿主事实（版本 / 安装目录等），原样交给插件的 `run()`。
 * @param {number} [options.timeoutMs] 覆盖默认超时。
 * @returns {Promise<object>} `{name, ok, partial, checks, detail?}`。
 */
export async function runSmoke(options) {
  const { plugin } = options
  const checks = fallbackChecks({
    name: plugin.name,
    bundles: options.bundles,
    pluginDirExists: plugin.dirExists !== false,
    inject: plugin.inject ?? [],
    resolvable: options.resolvable,
  })
  if (typeof plugin.smoke?.module !== 'string') {
    return {
      name: plugin.name,
      ok: checks.every((check) => check.ok),
      partial: true,
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
    checks: all,
    ...(self.detail === undefined ? {} : { detail: self.detail }),
  }
}

/**
 * 跑一批插件的冒烟。
 * @param {object} options 输入（`plugins` / `bundles` / `resolvable` / `importModule` / `timeoutMs`）。
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
