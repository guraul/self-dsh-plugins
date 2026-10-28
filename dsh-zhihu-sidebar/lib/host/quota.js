/**
 * 额度保护。
 *
 * 关键事实：`zhihu-cli quota` 不消耗业务额度，但它**自身会触发限流**。所以绝不能
 * 每次请求前查一次额度 —— 这里做三件事：
 * 1. 低频刷新（默认 30 分钟最多一次）；
 * 2. 本地按天记消耗，配额为 0 时该能力直接降级为 `quota_exhausted`，不发请求；
 * 3. 收到额度类错误时只置一个「下次刷新」标记，不立即打请求。
 * @module dsh-plugin-zhihu-sidebar/host/quota
 */

/** 每日本地调用上限（保守值，给真实额度留余量）。0 表示不限。 */
export const DEFAULT_DAILY_LIMITS = {
  hot: 80,
  search: 500,
  contents: 1000,
  capabilities: 0,
}

/** 服务端 `APIID` → 本地能力名。 */
export const API_ID_MAP = {
  hot_list: 'hot',
  zhihu_search: 'search',
  global_search: 'global',
  user_data: 'contents',
  creator: 'contents',
}

/** 默认刷新间隔。 */
export const DEFAULT_REFRESH_MS = 30 * 60 * 1000

/**
 * 本地日期键（用于跨天清零）。
 * @param {number} ms 时间戳。
 * @returns {string} `YYYY-M-D`。
 */
function dayKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/**
 * 从 `quota` 命令的业务体里找出各能力的剩余额度。
 *
 * 真实结构（有密钥实测）：`Data: [{ APIID, APIName, TotalQuota, TotalUsed, RemainingQuota }]`。
 * 字段名首字母大写；这里仍按大小写多种写法递归扫描，找不到就返回空表
 * （空表 = 未知，不影响请求放行）。
 * @param {unknown} data 业务体（`Data` 或整个响应）。
 * @returns {Record<string, { remaining: number, total: number|null }>} 能力 → 额度。
 */
export function extractQuota(data) {
  /** @type {Record<string, { remaining: number, total: number|null }>} */
  const out = {}
  /**
   * @param {unknown} node 任意节点。
   * @returns {void}
   */
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    const record = /** @type {Record<string, unknown>} */ (node)
    const rawId = record.APIID ?? record.ApiId ?? record.api_id ?? record.ApiID ?? record.apiId
    const rawRemaining = record.RemainingQuota ?? record.remaining_quota ?? record.Remaining ?? record.remaining
    if (typeof rawId === 'string' && typeof rawRemaining === 'number') {
      const capability = API_ID_MAP[rawId] ?? rawId
      const rawTotal = record.TotalQuota ?? record.total_quota ?? record.Total ?? record.total
      const previous = out[capability]
      const remaining = Math.max(0, rawRemaining)
      out[capability] = {
        remaining: previous === undefined ? remaining : Math.min(previous.remaining, remaining),
        total: typeof rawTotal === 'number' ? rawTotal : (previous?.total ?? null),
      }
    }
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object') visit(value)
    }
  }
  visit(data)
  return out
}

/**
 * 建一个额度守卫。
 * @param {object} [options] 选项。
 * @param {() => number} [options.now] 时钟（测试注入）。
 * @param {Record<string, number>} [options.limits] 每日本地上限。
 * @param {number} [options.refreshIntervalMs] 刷新间隔。
 * @returns {object} 守卫。
 */
export function createQuotaGuard({
  now = () => Date.now(),
  limits = DEFAULT_DAILY_LIMITS,
  refreshIntervalMs = DEFAULT_REFRESH_MS,
} = {}) {
  let day = dayKey(now())
  /** @type {Map<string, number>} */
  const used = new Map()
  /** @type {Map<string, { remaining: number, total: number|null }>} */
  const remote = new Map()
  /** @type {number|null} */
  let lastRefreshAt = null
  let refreshRequested = false
  let refreshing = false

  /**
   * 跨天清零。
   * @returns {void}
   */
  const rollover = () => {
    const today = dayKey(now())
    if (today === day) return
    day = today
    used.clear()
  }

  return {
    /**
     * 能不能花一次额度。
     * @param {string} capability 能力名。
     * @returns {{ ok: true } | { ok: false, reason: 'quota_exhausted', source: 'local'|'remote', limit: number|null, used: number, remaining: number }} 判定。
     */
    check(capability) {
      rollover()
      const known = remote.get(capability)
      if (known !== undefined && known.remaining <= 0) {
        return {
          ok: false,
          reason: 'quota_exhausted',
          source: 'remote',
          limit: known.total,
          used: known.total === null ? 0 : Math.max(0, known.total - known.remaining),
          remaining: 0,
        }
      }
      const limit = limits[capability] ?? 0
      const spent = used.get(capability) ?? 0
      if (limit > 0 && spent >= limit) {
        return {
          ok: false,
          reason: 'quota_exhausted',
          source: 'local',
          limit,
          used: spent,
          remaining: 0,
        }
      }
      return { ok: true }
    },
    /**
     * 记一次消耗（在真正发起调用前调用）。
     * @param {string} capability 能力名。
     * @returns {void}
     */
    spend(capability) {
      rollover()
      used.set(capability, (used.get(capability) ?? 0) + 1)
      const known = remote.get(capability)
      if (known !== undefined && known.remaining > 0) {
        known.remaining -= 1
      }
    },
    /**
     * 是否该刷新额度了。首次、跨过间隔、或收到额度错误后为 true。
     * @returns {boolean} 是否需要刷新。
     */
    shouldRefresh() {
      if (refreshRequested) return true
      if (lastRefreshAt === null) return true
      return now() - lastRefreshAt >= refreshIntervalMs
    },
    /**
     * 抢占刷新权，避免并发重复查额度。
     * @returns {boolean} 抢到返回 true。
     */
    beginRefresh() {
      if (refreshing) return false
      refreshing = true
      return true
    },
    /**
     * 结束刷新。
     * @param {number} [at] 刷新时刻。
     * @returns {void}
     */
    markRefreshed(at = now()) {
      refreshing = false
      refreshRequested = false
      lastRefreshAt = at
    },
    /**
     * 请求下一次刷新（额度类错误时调用，不立即查）。
     * @returns {void}
     */
    requestRefresh() {
      refreshRequested = true
    },
    /**
     * 写入服务端额度快照。
     * @param {Record<string, { remaining: number, total: number|null }>} snapshot 快照。
     * @returns {void}
     */
    applyRemote(snapshot) {
      for (const [capability, value] of Object.entries(snapshot)) {
        remote.set(capability, { ...value })
      }
    },
    /**
     * 快照，供 `/status` 与测试用。
     * @returns {object} 状态。
     */
    snapshot() {
      rollover()
      return {
        day,
        limits: { ...limits },
        used: Object.fromEntries(used),
        remote: Object.fromEntries(remote),
        lastRefreshAt,
        refreshDue: refreshRequested,
        refreshing,
      }
    },
  }
}
