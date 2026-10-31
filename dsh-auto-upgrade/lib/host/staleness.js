/**
 * 过期判定：上次检测结论（`state.lastCheck`）还能不能当结论用。
 *
 * 检测结论只在「当时的已装版本 + 当时的发布渠道」这两个前提下成立。升级成功或换渠道之后，
 * 缓存的结论就过期了——它描述的是过去，不是现在。这里只做**判定**，不联网、不重算：
 * 重算由 `POST /check/auto`（遇过期必须重算）或客户端的一次性 `POST /check/run` 负责。
 * @module dsh-plugin-auto-upgrade/host/staleness
 */

/** 过期原因。两项同时不同时优先 `installed-changed`（它直接决定「当前版本」这条文案）。 */
export const STALE_REASON = {
  INSTALLED_CHANGED: 'installed-changed',
  CHANNEL_CHANGED: 'channel-changed',
}

/** 非空字符串才算「可比较的值」。 */
const asText = (value) => (typeof value === 'string' && value !== '' ? value : null)

/**
 * 判定上次检测结论是否过期。
 *
 * 规则（顺序即优先级）：
 * 1. `lastCheck.installed !== 实时已装版本` → `installed-changed`；
 * 2. 否则 `lastCheck.channel !== policy.channel` → `channel-changed`；
 * 3. 都一致 → `stale:false`。
 *
 * 实时已装版本取不到（安装树解析失败）时**不做已装版本比较**：此时无法判断，
 * 把它判成过期会让客户端每次都白重算一遍。
 * @param {object|null|undefined} lastCheck 上次检测结论。
 * @param {{installed?:string|null, channel?:string|null}} facts 当前事实。
 * @returns {{stale:boolean, staleReason:string|null}} 判定结果。
 */
export function checkStaleness(lastCheck, facts = {}) {
  if (lastCheck === null || lastCheck === undefined || typeof lastCheck !== 'object') {
    return { stale: false, staleReason: null }
  }
  const installed = asText(facts.installed)
  if (installed !== null) {
    // 记录里没有 installed（早期记录）时同样视为「对不上」：无法确认前提，就不该当结论。
    if (lastCheck.installed !== installed) {
      return { stale: true, staleReason: STALE_REASON.INSTALLED_CHANGED }
    }
  }
  const channel = asText(facts.channel)
  if (channel !== null && lastCheck.channel !== channel) {
    return { stale: true, staleReason: STALE_REASON.CHANNEL_CHANGED }
  }
  return { stale: false, staleReason: null }
}
