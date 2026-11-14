/**
 * dsh-auto-upgrade 的冒烟断言（`dsh.smoke` 契约见 `docs/plugins/dsh-auto-upgrade.md`）。
 *
 * 只验升级后 5 秒内能确定的事，不联网、不跑真实预检：
 *   1. `preflight`：`aggregatePreflight()` 在 fixture 上产出稳定结论，含 `depth` / `pending` 口径
 *      （只有 L2+ 算通过；L1 / 缺深度是 pending，只警告不阻断）；
 *   2. `gate`：`decidePreflightGate()` 的缺失 / 阻断 / force 判定不变；
 *   3. `official-api`：用**宿主实际安装的那份** `@deepseek-ai/dsh-app-boot`（`ctx.dshDir`），
 *      断言 `evaluatePluginCompatibility` / `readProfileVersionExemptions` 仍存在且判定可用。
 *
 * 为什么能抓漂移：预检是升级门禁的唯一依据，`depth` 字段被上游改名、`pending` 被误算成通过、
 * 官方兼容性 API 改名/改签名，都会让第 1、3 条立刻红。第 3 条刻意不 import 插件自己
 * `node_modules` 里的旧副本——那会在升级后继续绿，等于没验。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 与 `preflight-run.js` 一致；判定口径的破坏性变化才允许 +1。 */
const PREFLIGHT_SCHEMA = 2
/** 只有 L2+ 算行为验证过。 */
const VERIFIED_DEPTHS = ['L2', 'L3', 'L4']
/** 被冒烟刻意钻空子的假 peer 要求：当前 dsh 不可能满足。 */
const IMPOSSIBLE_PEER = '>=99.0.0'

/**
 * 一个 `evaluatePlugins()` 形状的插件条目（默认 L2 = 行为验证过）。
 * @param {object} [over] 覆盖字段。
 * @returns {object} 条目。
 */
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

/**
 * 从宿主安装目录解析一个包（不用插件自己的 `node_modules` 旧副本）。
 * @param {string} dshDir 宿主 dsh 包目录（`ctx.dshDir`）。
 * @param {string} specifier 包名。
 * @returns {Promise<any>} 该包。
 */
async function importFromHost(dshDir, specifier) {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const requireFromHost = createRequire(join(dshDir, 'package.json'))
  return import(pathToFileURL(requireFromHost.resolve(specifier)).href)
}

/**
 * 跑一遍断言。
 * @param {{name?: string, dshDir?: string, dshVersion?: string}} [ctx] 宿主事实（由冒烟 runner 传入）。
 * @returns {Promise<{ok: boolean, checks: {name: string, ok: boolean, detail?: string}[]}>} 结果。
 */
export async function run(ctx = {}) {
  /** @type {{name: string, ok: boolean, detail?: string}[]} */
  const checks = []
  /**
   * 跑一条断言：抛错也算失败（不把「断言本身崩了」当成通过）。
   * @param {string} name 断言名。
   * @param {() => Promise<{ok: boolean, detail?: string}>} fn 断言体。
   * @returns {Promise<void>} 无。
   */
  const check = async (name, fn) => {
    try {
      const { ok, detail } = await fn()
      checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const { aggregatePreflight, blockedPluginNames, decidePreflightGate } = await import('./lib/host/preflight-run.js')

  await check('preflight', async () => {
    const options = {
      target: '9.9.9',
      at: 1_700_000_000_000,
      evaluated: {
        plugins: [
          plugin({ name: 'ok-plugin' }),
          plugin({ name: 'needs-upgrade', compatible: false, peers: { '@deepseek-ai/dsh-tools': '>=0.4.0' } }),
          plugin({ name: 'probe-fails', declared: { verdict: 'unverified', source: 'self-declared' } }),
          plugin({ name: 'never-verified', declared: { verdict: 'unverified', source: 'self-declared' } }),
          plugin({ name: 'assembly-only', depth: 'L1' }),
          plugin({ name: 'no-depth', depth: undefined }),
          plugin({ name: 'disabled-plugin', enabled: false, compatible: false }),
        ],
      },
      probes: [
        { name: 'ok-plugin', ok: true, detail: '装配通过（新增 ok-plugin）' },
        { name: 'probe-fails', ok: false, detail: 'plugin add 退出码 1' },
      ],
    }
    const result = aggregatePreflight(options)
    const byName = new Map(result.plugins.map((item) => [item.name, item]))
    const expectedOk = {
      ok: true, verdict: 'ok', requirements: {}, declared: 'compatible', depth: 'L2',
    }
    const expectedPendingL1 = {
      ok: true,
      verdict: 'pending',
      requirements: {},
      declared: 'compatible',
      depth: 'L1',
      detail: '只到 L1（可装配 · 未验证行为）',
    }
    const stable = JSON.stringify(result) === JSON.stringify(aggregatePreflight(options))
    const depthOk = VERIFIED_DEPTHS.includes(byName.get('ok-plugin').p1.depth)
      && byName.get('ok-plugin').p1.verdict === 'ok'
    const pendingOk = JSON.stringify(byName.get('assembly-only').p1) === JSON.stringify(expectedPendingL1)
      && byName.get('no-depth').p1.verdict === 'pending'
      && 'depth' in byName.get('no-depth').p1 === false
    const blockedOk = result.blocked === true
      && JSON.stringify(blockedPluginNames(result)) === JSON.stringify(['needs-upgrade', 'probe-fails'])
    const p2Ok = JSON.stringify(byName.get('ok-plugin').p2) === JSON.stringify({ ok: true, reason: '装配通过（新增 ok-plugin）' })
      && JSON.stringify(byName.get('probe-fails').p2) === JSON.stringify({ ok: false, reason: 'plugin add 退出码 1' })
      && JSON.stringify(byName.get('needs-upgrade').p2) === JSON.stringify({
        ok: true, skipped: true, reason: '未试装（不是 link:/file: 依赖）',
      })
    const warningsOk = JSON.stringify(result.warnings.map((item) => item.kind))
      === JSON.stringify(['p1-unverified', 'p1-unverified'])
    const disabledOk = byName.get('disabled-plugin').p1.verdict === 'ok'
      && byName.get('disabled-plugin').enabled === false
    const onlyWarnings = aggregatePreflight({
      target: '9.9.9',
      evaluated: { plugins: [plugin({ name: 'never-verified', declared: { verdict: 'unverified', source: 'self-declared' } })] },
    })
    return {
      ok: result.schema === PREFLIGHT_SCHEMA
        && depthOk
        && pendingOk
        && blockedOk
        && p2Ok
        && warningsOk
        && disabledOk
        && onlyWarnings.blocked === false
        && JSON.stringify(byName.get('ok-plugin').p1) === JSON.stringify(expectedOk)
        && stable,
      detail: `blocked=[${blockedPluginNames(result).join(',')}] `
        + `verdicts=${result.plugins.map((item) => `${item.name}:${item.p1.verdict}`).join(',')}`,
    }
  })

  await check('gate', async () => {
    const missing = decidePreflightGate({ result: null })
    const forced = decidePreflightGate({ result: null, force: true })
    const blockedResult = {
      blocked: true,
      plugins: [{
        name: 'bad',
        enabled: true,
        p1: { ok: false, verdict: 'requirements', requirements: { x: '^1' }, declared: 'compatible' },
        p2: { ok: true, skipped: true, reason: '未试装（不是 link:/file: 依赖）' },
      }],
    }
    const blocked = decidePreflightGate({ result: blockedResult })
    const blockedForced = decidePreflightGate({ result: blockedResult, force: true })
    const clear = decidePreflightGate({ result: { blocked: false, plugins: [] } })
    return {
      ok: missing.allowed === false && missing.reason === 'missing'
        && forced.allowed === true
        && blocked.allowed === false && JSON.stringify(blocked.blocked) === JSON.stringify(['bad'])
        && blockedForced.allowed === true
        && clear.allowed === true && clear.reason === null,
      detail: `missing=${String(missing.allowed)} blocked=${String(blocked.allowed)} force=${String(forced.allowed)}`,
    }
  })

  await check('official-api', async () => {
    const dshDir = typeof ctx.dshDir === 'string' && ctx.dshDir !== '' ? ctx.dshDir : undefined
    if (dshDir === undefined) {
      throw new Error('ctx.dshDir 不可用：拿不到宿主安装目录，无法证明官方兼容性 API 仍可用')
    }
    const appBoot = await importFromHost(dshDir, '@deepseek-ai/dsh-app-boot')
    const evaluate = appBoot.evaluatePluginCompatibility
    const exemptions = appBoot.readProfileVersionExemptions
    const hostVersion = typeof ctx.dshVersion === 'string' && ctx.dshVersion !== ''
      ? ctx.dshVersion
      : JSON.parse(await readFile(join(dshDir, 'package.json'), 'utf8')).version
    const manifest = {
      name: 'smoke-probe',
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh': IMPOSSIBLE_PEER },
    }
    const issue = typeof evaluate === 'function' ? evaluate(manifest, {}, hostVersion) : undefined
    const passing = typeof evaluate === 'function' ? evaluate(manifest, {}, '99.0.0') : 'unexpected'
    return {
      ok: typeof evaluate === 'function'
        && typeof exemptions === 'function'
        && issue?.requirements?.['@deepseek-ai/dsh'] === IMPOSSIBLE_PEER
        && issue?.runtimeVersion === hostVersion
        && passing === undefined,
      detail: `dsh ${String(hostVersion)}；evaluate=${typeof evaluate}/${String(evaluate?.length)} `
        + `exemptions=${typeof exemptions} requirements=${JSON.stringify(issue?.requirements)}`,
    }
  })

  return { ok: checks.every((item) => item.ok), checks }
}
