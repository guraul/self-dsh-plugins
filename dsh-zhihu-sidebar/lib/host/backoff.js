/**
 * 限流退避。
 *
 * 命中的信号有两个：CLI 退出码 4，或业务码 30001（HTTP 200 里的错误）。
 * 一旦命中，该能力进入冷却：冷却期内不发起真实调用，服务层直接回缓存或 `rate_limited`。
 * 退避 30s → 60s → 120s → … 封顶 5 分钟；成功一次就复位。
 * @module dsh-plugin-zhihu-sidebar/host/backoff
 */

/** 默认退避参数。 */
export const DEFAULT_BACKOFF = {
  baseMs: 30 * 1000,
  factor: 2,
  maxMs: 5 * 60 * 1000,
}

/**
 * 建一个退避表。
 * @param {object} [options] 选项。
 * @param {() => number} [options.now] 时钟（测试注入）。
 * @param {number} [options.baseMs] 首次冷却时长。
 * @param {number} [options.factor] 倍数。
 * @param {number} [options.maxMs] 冷却上限。
 * @returns {{ isCooling: (key: string) => boolean, remaining: (key: string) => number, failures: (key: string) => number, fail: (key: string) => { until: number, failures: number, delayMs: number }, succeed: (key: string) => void, reset: () => void, snapshot: () => Record<string, { until: number, failures: number }> }} 退避表。
 */
export function createBackoff({
  now = () => Date.now(),
  baseMs = DEFAULT_BACKOFF.baseMs,
  factor = DEFAULT_BACKOFF.factor,
  maxMs = DEFAULT_BACKOFF.maxMs,
} = {}) {
  /** @type {Map<string, { until: number, failures: number }>} */
  const states = new Map()

  return {
    isCooling(key) {
      const state = states.get(key)
      return state !== undefined && state.until > now()
    },
    remaining(key) {
      const state = states.get(key)
      if (state === undefined) return 0
      return Math.max(0, state.until - now())
    },
    failures(key) {
      return states.get(key)?.failures ?? 0
    },
    fail(key) {
      const previous = states.get(key)?.failures ?? 0
      const failures = previous + 1
      const delayMs = Math.min(baseMs * factor ** (failures - 1), maxMs)
      const until = now() + delayMs
      states.set(key, { until, failures })
      return { until, failures, delayMs }
    },
    succeed(key) {
      states.delete(key)
    },
    reset() {
      states.clear()
    },
    snapshot() {
      return Object.fromEntries(states)
    },
  }
}
