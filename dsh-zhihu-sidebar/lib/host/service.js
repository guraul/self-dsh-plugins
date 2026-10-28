/**
 * 数据层编排：缓存 → 冷却 → 额度 → 串行调用 → 三段判定 → 规范化。
 *
 * 顺序是有讲究的：先看缓存（不发请求），再看冷却（不发请求），再看额度（不达标不发请求），
 * 最后才轮到队列与子进程。任何一个前置闸门拦下，都不会消耗知乎侧的额度。
 * @module dsh-plugin-zhihu-sidebar/host/service
 */
import { createBackoff } from './backoff.js'
import { createCache, TTL } from './cache.js'
import { createQueue } from './queue.js'
import { createQuotaGuard, extractQuota } from './quota.js'
import {
  normalizeCapabilities,
  normalizeContents,
  normalizeHot,
  normalizeSearch,
  parseResult,
  REASON,
} from './parse.js'

/** 能力名。与缓存 / 退避 / 额度的键一致。 */
export const CAPABILITY = {
  HOT: 'hot',
  SEARCH: 'search',
  CONTENTS: 'contents',
  CAPABILITIES: 'capabilities',
  QUOTA: 'quota',
}

/** 服务端允许的参数边界（`capabilities` 的实测值，运行时以该命令为准）。 */
export const LIMITS = {
  hot: { min: 1, max: 30, fallback: 30 },
  search: { min: 1, max: 10, fallback: 10 },
  contents: { min: 1, max: 50, fallback: 20 },
}

/**
 * 把值夹进区间。
 * @param {number} value 值。
 * @param {{ min: number, max: number, fallback: number }} bounds 区间。
 * @returns {number} 夹好的整数。
 */
function clamp(value, bounds) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)))
}

/**
 * 建数据层。
 * @param {object} options 选项。
 * @param {{ run: (args: string[]) => Promise<any>, binPath?: string }} options.cli CLI 调用器。
 * @param {() => number} [options.now] 时钟（测试注入）。
 * @param {ReturnType<typeof createCache>} [options.cache] 缓存。
 * @param {ReturnType<typeof createBackoff>} [options.backoff] 退避表。
 * @param {ReturnType<typeof createQuotaGuard>} [options.quota] 额度守卫。
 * @param {ReturnType<typeof createQueue>} [options.queue] 队列。
 * @param {typeof TTL} [options.ttl] TTL 表。
 * @returns {object} 数据层。
 */
export function createService({
  cli,
  now = () => Date.now(),
  cache = createCache({ now }),
  backoff = createBackoff({ now }),
  quota = createQuotaGuard({ now }),
  queue = createQueue({ now }),
  ttl = TTL,
} = {}) {
  /**
   * 冷却中的统一回包：有上次数据就给旧数据，否则明确说限流。
   * @param {string} capability 能力。
   * @param {string} cacheKey 缓存键。
   * @param {string} [message] 原始错误。
   * @returns {object} 回包。
   */
  function cooling(capability, cacheKey, message) {
    const stale = cache.peek(cacheKey)
    const retryAfterMs = backoff.remaining(capability)
    if (stale !== undefined) {
      return {
        ok: true,
        stale: true,
        reason: REASON.RATE_LIMITED,
        retryAfterMs,
        fetchedAt: stale.at,
        data: stale.payload,
      }
    }
    return {
      ok: false,
      reason: REASON.RATE_LIMITED,
      retryAfterMs,
      ...(message === undefined ? {} : { message }),
    }
  }

  /**
   * 低频刷新额度。失败一律吞掉（额度信息是增益，不该拖垮数据请求）。
   * @returns {Promise<void>} 完成。
   */
  async function maybeRefreshQuota() {
    if (!quota.shouldRefresh()) return
    if (!quota.beginRefresh()) return
    try {
      const raw = await queue.run(CAPABILITY.QUOTA, () => cli.run(['quota']))
      const parsed = parseResult(raw)
      if (parsed.ok) {
        quota.applyRemote(extractQuota(parsed.data))
        backoff.succeed(CAPABILITY.QUOTA)
      } else if (parsed.reason === REASON.RATE_LIMITED) {
        backoff.fail(CAPABILITY.QUOTA)
      } else if (parsed.reason === REASON.QUOTA_EXHAUSTED) {
        quota.requestRefresh()
      }
    } catch {
      // 额度只是辅助信号，任何失败都不影响主流程。
    } finally {
      quota.markRefreshed()
    }
  }

  /**
   * 取一份数据。
   * @param {object} request 请求。
   * @param {string} request.capability 能力。
   * @param {string} request.cacheKey 缓存/去重键。
   * @param {string[]} request.args CLI 参数。
   * @param {number} request.ttlMs TTL。
   * @param {(data: unknown) => unknown} request.normalize 规范化函数。
   * @param {boolean} [request.quotaExempt] 是否免额度（`capabilities` 不消耗业务额度）。
   * @returns {Promise<object>} 回包。
   */
  async function load({ capability, cacheKey, args, ttlMs, normalize, quotaExempt = false }) {
    const hit = cache.get(cacheKey)
    if (hit !== undefined) {
      return { ok: true, cached: true, fetchedAt: hit.at, data: hit.payload }
    }
    if (backoff.isCooling(capability)) return cooling(capability, cacheKey)

    if (!quotaExempt) {
      await maybeRefreshQuota()
      const gate = quota.check(capability)
      if (!gate.ok) {
        return {
          ok: false,
          reason: gate.reason,
          quota: {
            source: gate.source,
            limit: gate.limit,
            used: gate.used,
            remaining: gate.remaining,
          },
        }
      }
      quota.spend(capability)
    }

    const raw = await queue.run(cacheKey, () => cli.run(args))
    const parsed = parseResult(raw)

    if (parsed.ok) {
      const at = now()
      const data = normalize(parsed.data)
      cache.set(cacheKey, data, ttlMs, at)
      backoff.succeed(capability)
      return { ok: true, cached: false, fetchedAt: at, data }
    }

    if (parsed.reason === REASON.RATE_LIMITED) {
      backoff.fail(capability)
      return cooling(capability, cacheKey, parsed.message)
    }
    if (parsed.reason === REASON.QUOTA_EXHAUSTED) quota.requestRefresh()

    return {
      ok: false,
      reason: parsed.reason,
      ...(parsed.message === undefined ? {} : { message: parsed.message }),
      ...(parsed.actionUrl === undefined ? {} : { actionUrl: parsed.actionUrl }),
      ...(parsed.businessCode === undefined ? {} : { businessCode: parsed.businessCode }),
    }
  }

  return {
    /**
     * 热榜。
     * @param {number} [limit] 条数。
     * @returns {Promise<object>} 回包。
     */
    hot(limit = LIMITS.hot.fallback) {
      const count = clamp(limit, LIMITS.hot)
      return load({
        capability: CAPABILITY.HOT,
        cacheKey: `hot:${count}`,
        args: ['hot', '--limit', String(count)],
        ttlMs: ttl.hot,
        normalize: normalizeHot,
      })
    },
    /**
     * 知乎搜索。
     * @param {string} query 关键词。
     * @param {number} [count] 条数。
     * @returns {Promise<object>} 回包。
     */
    search(query, count = LIMITS.search.fallback) {
      const keyword = typeof query === 'string' ? query.trim() : ''
      if (keyword === '') return Promise.resolve({ ok: false, reason: REASON.INVALID_ARGUMENT, message: 'query is required' })
      const limit = clamp(count, LIMITS.search)
      return load({
        capability: CAPABILITY.SEARCH,
        cacheKey: `search:${keyword}:${limit}`,
        args: ['search', 'zhihu', '--query', keyword, '--count', String(limit)],
        ttlMs: ttl.search,
        normalize: normalizeSearch,
      })
    },
    /**
     * 我的创作。
     * @param {number} [limit] 条数。
     * @returns {Promise<object>} 回包。
     */
    contents(limit = LIMITS.contents.fallback) {
      const count = clamp(limit, LIMITS.contents)
      return load({
        capability: CAPABILITY.CONTENTS,
        cacheKey: `contents:${count}`,
        args: ['me', 'contents', '--limit', String(count)],
        ttlMs: ttl.contents,
        normalize: normalizeContents,
      })
    },
    /**
     * 能力清单（免密钥、不消耗业务额度，缓存 24h）。
     * @returns {Promise<object>} 回包。
     */
    capabilities() {
      return load({
        capability: CAPABILITY.CAPABILITIES,
        cacheKey: 'capabilities',
        args: ['capabilities'],
        ttlMs: ttl.capabilities,
        normalize: normalizeCapabilities,
        quotaExempt: true,
      })
    },
    /**
     * 运行状态：队列、缓存、冷却、额度。
     * @returns {object} 状态。
     */
    status() {
      return {
        ok: true,
        cli: cli.binPath ?? null,
        queue: queue.stats(),
        cacheSize: cache.size(),
        backoff: backoff.snapshot(),
        quota: quota.snapshot(),
      }
    },
    /**
     * 直接暴露底层组件，便于测试与第二阶段复用。
     * @returns {object} 组件。
     */
    internals() {
      return { cache, backoff, quota, queue }
    },
  }
}
