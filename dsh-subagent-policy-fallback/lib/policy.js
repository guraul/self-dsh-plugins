/**
 * 补齐 `subagent/model-selection-policy` 的纯逻辑层。
 *
 * DSH 只在 `firstLiveSeq === 0` 的顶层新会话上采样 subagent 模型选择，
 * 种子 / 恢复会话永远等不到那条策略事件。本模块负责把这些会话补上，
 * 同时保证三件事：
 *
 * 1. **只碰顶层会话**：`origin === 'subagent'` 的子会话继承父会话，不再注入；
 * 2. **幂等**：日志里已有策略事件就跳过，重复触发不会写第二条；
 * 3. **只读现成设置**：从 `subagentModelSelection.current()` 取快照，不自己存配置。
 *
 * 所有函数都是同步的：在 `agent/created` 同步派发期间一口气完成检查与追加，
 * 不把「检查 → 追加」拆到两个微任务里，避免和上游监听器交错写出重复事件。
 * @module dsh-subagent-policy-fallback/policy
 */

/** 策略事件的类型名（与 DSH 上游一致）。 */
export const POLICY_EVENT = 'subagent/model-selection-policy'

/** 提供当前 subagent 模型选择的服务名。 */
export const SERVICE_NAME = 'subagentModelSelection'

/**
 * 判断会话日志里是否已经有策略事件。
 *
 * 用完整日志快照而不是 `ownEvents()`：fork 出来的会话，策略事件可能落在
 * 继承前缀里，只看自己写的事件会误判成「没有」并重复追加。
 * @param {any} session 会话。
 * @returns {boolean} 已有该事件。
 */
export function policyEventExists(session) {
  if (typeof session?.snapshotEvents === 'function') {
    return session.snapshotEvents().some((event) => event?.type === POLICY_EVENT)
  }
  // 兜底：有些测试替身 / 旧宿主只暴露 eventAt + seq。
  if (typeof session?.eventAt === 'function' && Number.isInteger(session.seq)) {
    for (let seq = 0; seq < session.seq; seq += 1) {
      if (session.eventAt(seq)?.type === POLICY_EVENT) return true
    }
  }
  return false
}

/**
 * 从宿主设置服务读一份允许路由快照。
 *
 * 服务缺失、`current()` 不可用或抛错、未启用、列表为空，一律返回 `undefined`——
 * 调用方据此「什么都不做」。上游 `current()` 在「已启用但列表为空」时会抛错，
 * 这里捕获后按空列表处理。
 * @param {any} ctx 宿主上下文。
 * @returns {Array<{provider: string, model: string}>|undefined} 允许路由。
 */
export function readAllowedModels(ctx) {
  if (typeof ctx?.get !== 'function') return undefined
  const service = ctx.get(SERVICE_NAME)
  if (service === undefined || service === null || typeof service.current !== 'function') return undefined

  let current
  try {
    current = service.current()
  } catch {
    return undefined
  }

  if (current?.enabled !== true) return undefined
  if (!Array.isArray(current.allowedModels) || current.allowedModels.length === 0) return undefined
  return current.allowedModels
}

/**
 * 给一个会话补策略事件。
 * @param {any} ctx 宿主上下文。
 * @param {any} session 会话（`agent.session` 或 `ctx.sessions.list()` 的元素）。
 * @returns {boolean} 是否真的追加了事件。
 */
export function backfillSession(ctx, session) {
  if (session === undefined || session === null) return false
  // 子会话继续继承父会话；即使父会话缺策略，也不在这里二次分发。
  if (session.header?.origin === 'subagent') return false
  if (policyEventExists(session)) return false

  const allowedModels = readAllowedModels(ctx)
  if (allowedModels === undefined) return false

  session.append(POLICY_EVENT, { allowedModels })
  if (ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger.info === 'function') {
    ctx.logger.info(
      `subagent-policy-fallback: 为会话 ${String(session.id)} 补齐 ${allowedModels.length} 条 subagent 模型路由`,
    )
  }
  return true
}

/**
 * 对一批会话逐个补齐；单个会话失败只记 warn，不影响其它会话。
 * @param {any} ctx 宿主上下文。
 * @param {Iterable<any>} sessions 会话集合。
 * @returns {number} 成功追加的会话数。
 */
export function backfillSessions(ctx, sessions) {
  let patched = 0
  for (const session of sessions) {
    try {
      if (backfillSession(ctx, session)) patched += 1
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (ctx?.logger !== undefined && ctx.logger !== null && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`subagent-policy-fallback: 会话 ${String(session?.id)} 补策略失败：${reason}`)
      }
    }
  }
  return patched
}

/**
 * 补 `apply` 时已经存活的会话。
 * @param {any} ctx 宿主上下文。
 * @returns {number} 成功追加的会话数。
 */
export function backfillLiveSessions(ctx) {
  if (typeof ctx?.sessions?.list !== 'function') return 0
  return backfillSessions(ctx, ctx.sessions.list())
}
