/**
 * 取某个 dsh 版本的 GitHub release notes。
 *
 * 纯读、可失败：拿不到就说拿不到（`available:false` + `reason`），绝不抛给路由、
 * 也绝不把"拿不到"伪装成"没有更新说明"以外的任何结论。
 * @module dsh-plugin-auto-upgrade/host/notes
 */

/** 默认 GitHub API 基址（单测会指到假服务器上）。 */
export const DEFAULT_GITHUB_API = 'https://api.github.com'

/** 版本标签的候选形态，按命中概率排序（dsh 官方用 `dsh-v<版本>`）。 */
export const TAG_PREFIXES = ['dsh-v', 'v', '']

/**
 * 从包的 manifest 里读出 `owner/repo`。
 * @param {object} manifest 已解析的 package.json。
 * @returns {string|undefined} `owner/repo`；不是 GitHub 仓库时返回 undefined。
 */
export function repositorySlug(manifest) {
  const raw = manifest?.repository
  const url = typeof raw === 'string' ? raw : raw?.url
  if (typeof url !== 'string' || url === '') return undefined
  const match = /github\.com[/:]([^/\s]+)\/([^/#\s]+?)(?:\.git)?(?:#.*)?$/i.exec(url.trim())
  if (match === null) return undefined
  return `${match[1]}/${match[2]}`
}

/**
 * 版本 → 候选标签。
 * @param {string} version 精确版本号。
 * @returns {string[]} 候选标签。
 */
export function candidateTags(version) {
  return TAG_PREFIXES.map((prefix) => `${prefix}${version}`)
}

/**
 * 把 GitHub release 正文压成能塞进浮层的一小段纯文本。
 *
 * dsh 的 release 正文里混着 `<h3 id=…>`、`[中文](#…)` 这类 HTML/锚点，原样显示很脏；
 * 这里只做「去标签 + 链接留文字 + 压空行 + 截断」，不做 markdown 渲染。
 * 完整正文永远可以通过 `url` 打开，所以截断是安全的。
 * @param {unknown} body release 正文。
 * @param {number} [limit] 截断长度。
 * @returns {string} 纯文本。
 */
export function plainNotes(body, limit = 1200) {
  if (typeof body !== 'string') return ''
  const text = body
    .replace(/<[^>]*>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[ \t]*[-*]\s+/gm, '· ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text
}

/**
 * 拉某个版本的 release notes。
 * @param {{slug:string, version:string, apiBase?:string, fetchImpl?:typeof fetch, timeoutMs?:number}} options 输入。
 * @returns {Promise<{available:boolean, tag?:string, notes?:string, plain?:string, url?:string, name?:string, reason?:string}>} 结果（不抛）。
 */
export async function fetchReleaseNotes(options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const apiBase = (options.apiBase ?? DEFAULT_GITHUB_API).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? 8000
  const tags = candidateTags(options.version)
  let lastReason = 'no release found for this version'

  for (const tag of tags) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${apiBase}/repos/${options.slug}/releases/tags/${encodeURIComponent(tag)}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-plugin-auto-upgrade',
        },
        signal: controller.signal,
      })
      if (response.status === 404) {
        lastReason = `no release tagged ${tags.join(' / ')}`
        continue
      }
      if (!response.ok) {
        return { available: false, reason: `GitHub responded ${response.status}` }
      }
      const body = await response.json()
      const markdown = typeof body.body === 'string' ? body.body : ''
      return {
        available: true,
        tag,
        name: typeof body.name === 'string' && body.name !== '' ? body.name : tag,
        notes: markdown,
        plain: plainNotes(markdown),
        url: typeof body.html_url === 'string' ? body.html_url : undefined,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastReason = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : message
    } finally {
      clearTimeout(timer)
    }
  }
  return { available: false, reason: lastReason }
}
