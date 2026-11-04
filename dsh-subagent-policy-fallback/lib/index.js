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
 * @module dsh-subagent-policy-fallback
 */
import { backfillLiveSessions, backfillSession } from './policy.js'

/** 插件 id（cordis 里就是组合行的 id）。 */
export const name = 'dsh-subagent-policy-fallback'

/** 需要的宿主服务：会话存储；设置服务用 `ctx.get()` 软探测，不强制注入。 */
export const inject = ['sessions']

/**
 * 挂载补丁。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {{ enabled?: boolean }} [config] 插件配置；`enabled` 默认 `true`。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) return

  // 同步监听：检查与追加在同一个同步段里完成，避免和上游监听器交错。
  ctx.on('agent/created', ({ agent } = {}) => {
    try {
      backfillSession(ctx, agent?.session)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`subagent-policy-fallback: 会话 ${String(agent?.session?.id)} 补策略失败：${reason}`)
      }
    }
  })

  // 插件加载 / 重启时，已经存活的会话不会再触发 agent/created，这里补一次。
  backfillLiveSessions(ctx)
}
