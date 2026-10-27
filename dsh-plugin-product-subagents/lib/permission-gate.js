/**
 * 委派权限天花板（readonly < default < full）。
 *
 * 语义：权限沿委派树**向下继承**——一个 product 子代理不能派生出比自己权限更高的后代，
 * 否则只读子代理可以靠"生一个全权孙子"绕过限制。
 *
 * 关键细节（issue #58）：绑定表里可能存在 **没有 `settings` 的记录**——
 * `prepareContinuable()` 建绑定时写的是 `{ product, bridge, remote, settings: undefined }`，
 * 真正的 `settings.permissionMode` 要等 `start()` 返回后才补写。因此"绑定存在"并不等于
 * "调用方是一个已声明权限的 product 子代理"：
 *   - 有绑定 + `settings.permissionMode` 是字符串 → 按天花板校验；
 *   - 有绑定但 `settings` 缺失 / 模式未知 → **不拦**（按根代理处理），并让调用方记一条 warn。
 * 曾经把后一种情况当成 `default`（rank 1），结果根代理做完一次后台委派后就再也派不出全权子代理
 * （报 `permission escalation blocked`），表现是"第一次能派、之后全被拦"。
 */

export const PERM_RANK = { readonly: 0, default: 1, full: 2 }

/** 从绑定记录里取调用方的权限模式；取不到返回 undefined（= 未声明，不是 default）。 */
export function callerPermissionMode(callerRecord) {
  if (!callerRecord || typeof callerRecord !== 'object') return undefined
  const settings = callerRecord.settings
  if (!settings || typeof settings !== 'object') return undefined
  const mode = settings.permissionMode
  return typeof mode === 'string' && PERM_RANK[mode] !== undefined ? mode : undefined
}

/**
 * @returns {{ ok: true, callerMode?: string, undeclared?: boolean }
 *          | { ok: false, callerMode: string, requestedMode: string }}
 */
export function checkDelegationPermission(callerRecord, requestedMode) {
  const callerMode = callerPermissionMode(callerRecord)
  if (callerMode === undefined) {
    // 调用方不是已声明权限的 product 子代理（根代理 / 未初始化记录）→ 不设上限
    return { ok: true, undeclared: Boolean(callerRecord) }
  }
  const requestedRank = PERM_RANK[requestedMode] ?? PERM_RANK.default
  const callerRank = PERM_RANK[callerMode]
  if (requestedRank > callerRank) {
    return { ok: false, callerMode, requestedMode }
  }
  return { ok: true, callerMode }
}
