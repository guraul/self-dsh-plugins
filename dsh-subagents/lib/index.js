/**
 * dsh-plugin-subagents 的宿主半边。
 *
 * PR2 只交付骨架：角色层、契约层、记录层与 CLI。宿主侧能力（注册
 * `product-subagents:*` provider、审核 HTTP 路由）在 PR4 补齐——那一版会先卸载
 * 旧插件 `dsh-plugin-product-subagents`，再挂本插件，避免 provider 重名导致
 * 整个 profile 插件树启动失败。
 *
 * 为什么这里什么也不注册：一期不挂真实 profile，装配验证只要求本包能被
 * `install-check.sh` 装进一次性 DSH_HOME。提前注册 provider 会让「有没有装进
 * 去」和「注册对不对」两件事混在一次验收里。
 */
export const name = 'subagents'

/** PR4 会补 `subagents`（注册 provider）与 `webServer`（审核路由）。 */
export const inject = []

export function apply() {
  // PR4: ctx.subagents.registerProvider(...) + POST /api/dsh-subagents/review
}
