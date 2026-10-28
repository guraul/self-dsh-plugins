/**
 * 内存 TTL 缓存。
 *
 * 时钟可注入：测试里不用等 5 分钟，直接把 `now` 往前拨。
 * `get` 只返回新鲜值；`peek` 连过期值也返回 —— 限流冷却时要用「上次的数据」兜底。
 * @module dsh-plugin-zhihu-sidebar/host/cache
 */

/** 各能力的 TTL（毫秒）。 */
export const TTL = {
  hot: 5 * 60 * 1000,
  search: 2 * 60 * 1000,
  contents: 10 * 60 * 1000,
  capabilities: 24 * 60 * 60 * 1000,
}

/**
 * 建一个缓存。
 * @param {object} [options] 选项。
 * @param {() => number} [options.now] 时钟。
 * @returns {{ get: (key: string) => { at: number, payload: unknown }|undefined, peek: (key: string) => { at: number, payload: unknown }|undefined, set: (key: string, payload: unknown, ttlMs: number, at?: number) => void, invalidate: (key?: string) => void, size: () => number }} 缓存。
 */
export function createCache({ now = () => Date.now() } = {}) {
  /** @type {Map<string, { payload: unknown, at: number, expiresAt: number }>} */
  const entries = new Map()

  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (now() >= entry.expiresAt) return undefined
      return { at: entry.at, payload: entry.payload }
    },
    peek(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      return { at: entry.at, payload: entry.payload }
    },
    set(key, payload, ttlMs, at = now()) {
      entries.set(key, { payload, at, expiresAt: at + ttlMs })
    },
    invalidate(key) {
      if (key === undefined) entries.clear()
      else entries.delete(key)
    },
    size() {
      return entries.size
    },
  }
}
