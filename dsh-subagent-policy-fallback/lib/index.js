/**
 * 宿主半边：给种子 / 恢复会话补 `subagent/model-selection-policy`。
 *
 * 背景：DSH 的 `SubagentModelSelectionConfig` 只在 `agent/created` 时对
 * `firstLiveSeq === 0` 的顶层新会话采样设置。种子 / 恢复 / fork 会话的
 * `firstLiveSeq !== 0`，因此永远拿不到策略事件，subagent 也就无法显式指定
 * `provider/model`（upstream discussion #8444）。
 *
 * 本插件不复制那条判据，而是监听所有 `agent/created`，并在 `apply` 时回填
 * 已存活会话；用「日志里已有策略事件就跳过」来保证幂等。
 * 挂载时另打一行 info（见 `apply`），让「插件没加载 / 设置服务缺失」也能被看见，
 * 不必等某个会话补策略失败才暴露。
 * @module dsh-subagent-policy-fallback
 */
import { backfillLiveSessions, backfillSession, readAllowedModels } from './policy.js'

/** 插件 id（cordis 里就是组合行的 id）。 */
export const name = 'dsh-subagent-policy-fallback'

/**
 * 需要的宿主服务：会话存储。
 *
 * `sessions` 会挂到 `ctx.sessions` 上供 `backfillLiveSessions()` 使用；设置服务
 * `subagentModelSelection` 故意不写进 `inject`，用 `ctx.get()` 软探测——它没挂载时
 * 本插件应当安静地什么都不做，而不是把挂载顶掉。
 */
export const inject = ['sessions']

/**
 * 进程内状态（按 ctx 分桶）：挂载标记与补写计数。
 * 只为 `lib/status.js` 的 `describeStatus()` 服务；宿主重启即归零。
 * @type {WeakMap<object, {mounted: boolean, backfilledSessions: number}>}
 */
const states = new WeakMap()

/**
 * 取（缺则建）某个 ctx 的状态对象。
 * @param {any} ctx 宿主上下文。
 * @returns {{mounted: boolean, backfilledSessions: number}} 状态。
 */
function stateOf(ctx) {
  let state = states.get(ctx)
  if (state === undefined) {
    state = { mounted: false, backfilledSessions: 0 }
    states.set(ctx, state)
  }
  return state
}

/**
 * 只读导出本进程内状态，供 `lib/status.js` 的 `describeStatus()` 消费。
 * @param {any} ctx 宿主上下文。
 * @returns {{mounted: boolean, backfilledSessions: number}} 状态快照。
 */
export function readStats(ctx) {
  const state = states.get(ctx)
  return state === undefined ? { mounted: false, backfilledSessions: 0 } : { ...state }
}

/**
 * 打一行 info；logger 不可用时静默——挂载不能因为日志不可用而失败。
 * @param {any} ctx 宿主上下文。
 * @param {string} message 日志文本。
 * @returns {void}
 */
function logInfo(ctx, message) {
  if (ctx?.logger !== undefined && ctx.logger !== null && typeof ctx.logger.info === 'function') {
    ctx.logger.info(message)
  }
}

/**
 * 挂载补丁。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {{ enabled?: boolean }} [config] 插件配置；`enabled` 默认 `true`。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) {
    logInfo(ctx, `${name}: 未挂载（enabled=false），不会补策略`)
    return
  }

  const state = stateOf(ctx)

  // 同步监听：检查与追加在同一个同步段里完成，避免和上游监听器交错。
  ctx.on('agent/created', ({ agent } = {}) => {
    try {
      if (backfillSession(ctx, agent?.session)) state.backfilledSessions += 1
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`subagent-policy-fallback: 会话 ${String(agent?.session?.id)} 补策略失败：${reason}`)
      }
    }
  })

  state.mounted = true

  // 挂载行：一行说清「挂没挂、能不能补」。服务缺失在这里可见，不逐会话刷屏。
  // 路由数是挂载那一刻的快照；设置之后改了以 describeStatus 的实时读数为准。
  let allowedRoutes
  try {
    allowedRoutes = readAllowedModels(ctx)
  } catch {
    allowedRoutes = undefined
  }
  logInfo(
    ctx,
    allowedRoutes === undefined
      ? `${name}: 已挂载，设置服务缺失，不会补策略`
      : `${name}: 已挂载，设置里允许 ${allowedRoutes.length} 条 subagent 模型路由`,
  )

  // 插件加载 / 重启时，已经存活的会话不会再触发 agent/created，这里补一次。
  // 回填失败只影响「当下这批会话」，不能让插件挂载跟着失败。
  try {
    const patched = backfillLiveSessions(ctx)
    if (patched > 0) state.backfilledSessions += patched
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(`subagent-policy-fallback: 回填存活会话失败：${reason}`)
    }
  }
}
