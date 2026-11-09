/**
 * 「建 profile → 跑探针」的顺序（issue #400）。
 *
 * 抽出来是为了能在**不依赖真实 dsh** 的前提下测顺序：原来那条用例要 `which dsh`，
 * CI 里没有 dsh 就 skip，等于修复没有回归保护。
 */

import { ensureProbeProfile } from './probe-profile.js'

/**
 * 先建一次性 profile，再跑探针。
 *
 * `ensure` 抛错时**不跑** probes：拿一个不存在的 profile 去 dump 只会得到「基线不可用」，
 * 那正是 #392 的误报来源。
 * @param {object} options 依赖。
 * @param {string} options.dshHome 一次性 DSH_HOME。
 * @param {string} options.profileName profile 名。
 * @param {(home: string, name: string) => Promise<unknown>} [options.ensure] 建 profile；
 *   默认用真实的 `ensureProbeProfile`，测试可注入。
 * @param {() => Promise<unknown>} options.probes 跑探针。
 * @returns {Promise<unknown>} `probes()` 的结果。
 */
export async function runProbeWithProfile(options) {
  const ensure = options.ensure ?? ensureProbeProfile
  await ensure(options.dshHome, options.profileName)
  return options.probes()
}
