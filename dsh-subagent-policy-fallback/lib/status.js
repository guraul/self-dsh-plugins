/**
 * 只读自检：把「插件挂没挂、设置服务在不在、补了几个会话」一次性说清楚。
 *
 * 供人排查用，不做 CLI：宿主进程里 import 本模块后对当前 ctx 调一次即可
 * （单测也走同一入口）。状态由 `lib/index.js` 在挂载与补写时累计，
 * 本模块只读不写；计数只在本进程内有效，宿主重启归零。
 * @module dsh-subagent-policy-fallback/status
 */
import { readStats } from './index.js'
import { readAllowedModels, SERVICE_NAME } from './policy.js'

/**
 * 描述某个 ctx 上本插件的状态。
 *
 * - `mounted`：本进程的 `apply()` 是否真的注册了监听（`enabled: false` 时为 false）；
 * - `serviceAvailable`：设置服务 `subagentModelSelection` 在不在（只看在不在，
 *   不看开没开——开没开体现在 `allowedRoutes` 上）；
 * - `allowedRoutes`：设置里当前可用的路由条数（服务缺失 / 未启用 / 列表为空时为 0）；
 * - `backfilledSessions`：本进程内补写过策略的会话数（含挂载时回填与 `agent/created` 触发）。
 * @param {any} ctx 宿主上下文。
 * @returns {{mounted: boolean, serviceAvailable: boolean, allowedRoutes: number, backfilledSessions: number}}
 *   结构化状态。
 */
export function describeStatus(ctx) {
  const stats = readStats(ctx)

  let service
  try {
    service = typeof ctx?.get === 'function' ? ctx.get(SERVICE_NAME) : undefined
  } catch {
    service = undefined
  }
  const serviceAvailable =
    service !== undefined && service !== null && typeof service.current === 'function'

  let routes
  try {
    routes = readAllowedModels(ctx)
  } catch {
    routes = undefined
  }

  return {
    mounted: stats.mounted,
    serviceAvailable,
    allowedRoutes: routes === undefined ? 0 : routes.length,
    backfilledSessions: stats.backfilledSessions,
  }
}
