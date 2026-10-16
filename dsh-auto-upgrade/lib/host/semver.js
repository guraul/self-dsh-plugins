/**
 * 最小 SemVer 比较：只做本插件真正需要的「谁更新」判断，不做范围匹配
 * （范围匹配交给官方 evaluatePluginCompatibility）。
 * 规则按 semver.org §11：数字段逐位比；有预发布段的版本小于同号正式版；
 * 预发布段按点分标识符比较（数字 < 字母数字，数字按数值比）。
 * @module dsh-plugin-auto-upgrade/host/semver
 */

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/**
 * 解析版本号。
 * @param {unknown} value 版本文本。
 * @returns {{major:number,minor:number,patch:number,pre:Array<string|number>,raw:string}|undefined} 解析结果；非法返回 undefined。
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined
  const m = RE.exec(value.trim())
  if (m === null) return undefined
  const pre = m[4] === undefined ? [] : m[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre, raw: value.trim() }
}

/**
 * 是否是规范的精确版本（不含范围符号）。
 * @param {unknown} value 候选文本。
 * @returns {boolean} true 表示可当作精确版本使用。
 */
export function isExactVersion(value) {
  return parseVersion(value) !== undefined
}

/**
 * 比较两个版本。
 * @param {string} a 左值。
 * @param {string} b 右值。
 * @returns {number} a<b 返回负数，a>b 返回正数，相等或不可比返回 0。
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  const lp = left.pre
  const rp = right.pre
  if (lp.length === 0 && rp.length === 0) return 0
  if (lp.length === 0) return 1 // 正式版 > 预发布版
  if (rp.length === 0) return -1
  const len = Math.max(lp.length, rp.length)
  for (let i = 0; i < len; i += 1) {
    const l = lp[i]
    const r = rp[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const ln = typeof l === 'number'
    const rn = typeof r === 'number'
    if (ln && rn) return l < r ? -1 : 1
    if (ln) return -1 // 数字标识符优先级低于字母数字
    if (rn) return 1
    return l < r ? -1 : 1
  }
  return 0
}

/**
 * 从版本列表里挑出严格大于 `current` 的最大版本。
 * 预发布版只在 `allowPrerelease` 为真、或没有任何正式候选时参与。
 * @param {string[]} versions 候选版本（顺序不敏感）。
 * @param {string} current 当前版本。
 * @param {{allowPrerelease?: boolean}} [options] 选项。
 * @returns {string|undefined} 目标版本，没有更新时返回 undefined。
 */
export function pickNewestAbove(versions, current, options = {}) {
  const allowPrerelease = options.allowPrerelease === true
  let best
  for (const version of versions) {
    const parsed = parseVersion(version)
    if (parsed === undefined) continue
    if (!allowPrerelease && parsed.pre.length > 0) continue
    if (compareVersions(version, current) <= 0) continue
    if (best === undefined || compareVersions(version, best) > 0) best = version
  }
  if (best === undefined && !allowPrerelease) {
    // 只有预发布候选时也让调用方看见，由上层决定是否提示渠道问题
    return pickNewestAbove(versions, current, { allowPrerelease: true })
  }
  return best
}
