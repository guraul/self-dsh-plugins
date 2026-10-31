/**
 * 一键开 issue：把「这次升级被哪些插件、哪些要求挡住」变成一条可追踪的 GitHub issue。
 *
 * 安全边界：**issue 的标题与正文全部由宿主根据当前检测结果生成**，请求体只接受一个
 * `target`（精确版本号）。这样这个端点就不可能被拿来往仓库里塞任意文本。
 *
 * 幂等：创建前先用 `gh issue list --search <标题> --state open` 找同名 open issue，
 * 命中就直接返回（`created:false`）。gh 的 search 是全文检索，所以这里还会按标题**精确**比对。
 * @module dsh-plugin-auto-upgrade/host/report-issue
 */
import { execFile } from 'node:child_process'

/** `gh` 单次调用的超时（毫秒）：开 issue 不该把请求挂死。 */
export const GH_TIMEOUT_MS = 30000

/** issue 正文里每个插件最多列多少条要求（其余折叠成计数）。 */
export const BODY_REQUIREMENT_LIMIT = 10

/** 标题上限，避免插件很多时越过 GitHub 的长度限制。 */
const TITLE_LIMIT = 200

/**
 * 默认的 `gh` 执行器：跑一个子进程，**不抛异常**，把结果如实交回给路由。
 * @param {string[]} args 参数表（第一项固定是 `issue`）。
 * @param {{timeoutMs?:number}} [options] 选项。
 * @returns {Promise<{ok:boolean, stdout:string, error?:string}>} 结果。
 */
export function defaultRunGh(args, options = {}) {
  return new Promise((resolve) => {
    execFile('gh', args, {
      timeout: options.timeoutMs ?? GH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error === null || error === undefined) {
        resolve({ ok: true, stdout: String(stdout ?? '') })
        return
      }
      const detail = String(stderr ?? '').trim() || error.message
      resolve({ ok: false, stdout: String(stdout ?? ''), error: detail })
    })
  })
}

/**
 * 一个能直接给路由用的失败（带状态码）。
 */
export class ReportError extends Error {
  /**
   * @param {number} status HTTP 状态码。
   * @param {string} message 人话原因。
   */
  constructor(status, message) {
    super(message)
    this.name = 'ReportError'
    this.status = status
  }
}

/**
 * 判断一条点名记录是否来自门禁（`gate`）。
 * 老调用 / 裸 `{name}` 输入没有 `sources`，沿用「阻塞」口径，标题格式不变。
 * @param {{sources?:string[], compatible?:boolean}} plugin 点名记录。
 * @returns {boolean} 是否门禁阻塞。
 */
function isGate(plugin) {
  if (Array.isArray(plugin.sources)) return plugin.sources.includes('gate')
  return plugin.compatible !== true
}

/**
 * 可开 issue 的点名集合：**只有已知不兼容**才算——门禁阻塞（`gate`）或自述 `incompatible`。
 *
 * `unverified`（从未验证）不是「已知不兼容」：它不逐条占位、不开 issue，只作背景计数。
 * 否则任何没写矩阵的插件都会让按钮有东西可开，issue 里就会塞满「我没测过」这种噪音。
 * @param {object[]} plugins `flagged` 列表（门禁 + 自述合并后的那份）。
 * @returns {object[]} 可写进 issue 的点名项。
 */
export function reportablePlugins(plugins) {
  return (Array.isArray(plugins) ? plugins : [])
    .filter((plugin) => isGate(plugin) || plugin?.declared?.verdict === 'incompatible')
}

/**
 * 从 `flagged` 里挑出**未验证**的那些（既不是门禁阻塞，也不是自述 `incompatible`）。
 * 它们只能折叠成一行计数，不能点名、不能开 issue。
 * @param {object[]} plugins `flagged` 列表。
 * @returns {object[]} 未验证的插件。
 */
export function unverifiedPlugins(plugins) {
  const reportable = new Set(reportablePlugins(plugins))
  return (Array.isArray(plugins) ? plugins : []).filter((plugin) => !reportable.has(plugin))
}

/**
 * 生成确定性的 issue 标题（幂等搜索就靠它）。
 * @param {{target:string, plugins:{name:string, sources?:string[], compatible?:boolean}[]}} input 输入。
 * @returns {string} 标题。
 */
export function issueTitle(input) {
  const names = input.plugins.map((plugin) => plugin.name).join('、')
  const blocked = input.plugins.some((plugin) => isGate(plugin))
  const reason = blocked
    ? `被 ${input.plugins.length} 个插件阻塞`
    : `时 ${input.plugins.length} 个插件自述兼容性有问题`
  const title = `dsh-auto-upgrade：升级到 ${input.target} ${reason}（${names}）`
  return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title
}

/**
 * 把一条要求格式化成 markdown 行（`name` 要求 `range`）。
 * @param {[string, string]} entry 名字与声明范围。
 * @returns {string} 一行文本。
 */
function requirementLine([name, range]) {
  return `- \`${name}\` 要求 \`${range}\``
}

/**
 * 生成 issue 正文。所有事实都来自这次检测结果与调用方传入的本机事实。
 *
 * 自述矩阵（`dsh.compatibility.dshReleases`）是**人工实测记录**，官方门禁不读；
 * 缺失即 `unverified`（从未验证）。正文必须把这份证据原样带上，否则 issue 读者
 * 无法区分「门禁判的」与「插件自己记的」。
 * @param {object} input 输入。
 * @param {string} input.target 目标 dsh 版本。
 * @param {string|null} input.installed 当前 dsh 版本。
 * @param {string} input.profile profile 名。
 * @param {{name:string, version:string, peers?:Record<string,string>, declared?:{verdict:string}, sources?:string[], compatible?:boolean}[]} input.plugins 点名插件（只含已知不兼容：门禁阻塞或自述 `incompatible`）。
 * @param {number} [input.unverifiedCount] 另有几个插件未验证该版本（只作背景一行，不进表格）。
 * @param {number} input.port dsh web 端口（拼复现命令）。
 * @returns {string} markdown 正文。
 */
export function issueBody(input) {
  /** 取自述判定；老记录没有 `declared` 时按「从未验证」如实处理。 */
  const declaredOf = (plugin) => plugin.declared ?? { verdict: 'unverified', source: 'self-declared' }
  /** 矩阵原文：有记录就照抄，没有就明说。 */
  const recordOf = (verdict) => (verdict === 'unverified' ? '（无记录 = 从未验证）' : `\`"${verdict}"\``)
  /** 来源列表：门禁（可能没有）+ 自述。 */
  const sourcesOf = (plugin) => [...new Set([...(plugin.sources ?? []), 'self-declared'])]

  const lines = [
    '由 `dsh-auto-upgrade` 插件的「开 issue 记录这个不兼容」按钮生成。',
    '',
    '## 目标版本',
    '',
    `- 目标 dsh：\`${input.target}\``,
    `- 当前 dsh：\`${input.installed ?? 'unknown'}\``,
    `- profile：\`${input.profile}\``,
    '',
    '## 自述兼容矩阵证据',
    '',
    '> 取自各插件 `package.json` → `dsh.compatibility.dshReleases[<目标版本>]`。',
    '> `source: self-declared` 是**人工实测记录**（官方门禁 `evaluatePluginCompatibility()` 不读它，可能过期或漏记）；',
    '> 缺失即 `unverified`（该版本从未验证）。`source: gate` 是官方门禁的判定。',
    '',
    '| 插件 | 来源 | 目标版本 | 矩阵记录 | verdict |',
    '|---|---|---|---|---|',
  ]
  for (const plugin of input.plugins) {
    const declared = declaredOf(plugin)
    lines.push(
      `| \`${plugin.name}@${plugin.version}\` | ${sourcesOf(plugin).map((source) => `\`${source}\``).join(' + ')} | \`${input.target}\` | ${recordOf(declared.verdict)} | \`${declared.verdict}\` |`,
    )
  }
  // 未验证的插件只留一行背景：不进表格、不点名、也不构成开 issue 的理由。
  if (Number.isInteger(input.unverifiedCount) && input.unverifiedCount > 0) {
    lines.push('', `另有 ${input.unverifiedCount} 个插件未验证该版本（未验证 ≠ 已知不兼容，未列入上表）。`)
  }
  lines.push('', '## 点名插件', '')
  for (const plugin of input.plugins) {
    lines.push(`### \`${plugin.name}@${plugin.version}\``, '')
    const requirements = Object.entries(plugin.peers ?? {})
    if (requirements.length === 0) {
      lines.push(isGate(plugin) ? '（官方判定不兼容，但没有回报具体未满足项）' : '（官方门禁已放行；下面是插件自述矩阵的结论）', '')
      continue
    }
    for (const entry of requirements.slice(0, BODY_REQUIREMENT_LIMIT)) lines.push(requirementLine(entry))
    if (requirements.length > BODY_REQUIREMENT_LIMIT) {
      lines.push(`- 等 ${requirements.length - BODY_REQUIREMENT_LIMIT} 项（共 ${requirements.length} 项）`)
    }
    lines.push('')
  }
  lines.push(
    '## 复现',
    '',
    '```sh',
    `curl -sS -X POST http://127.0.0.1:${input.port}/api/dsh-auto-upgrade/check/run -H 'content-type: application/json' -d '{"force":true}'`,
    `curl -sS 'http://127.0.0.1:${input.port}/api/dsh-auto-upgrade/plugins?version=${input.target}'`,
    '```',
    '',
    '## 修法',
    '',
    '1. 放宽该插件的 peer 声明后重跑其装配验收：`scripts/pipeline/install-check.sh <插件目录>`',
    '2. 或为该版本组合申请版本豁免：`dsh plugin --profile web allow-version …`',
    '3. 自述矩阵只是记录：复测该版本后，把结论同步写进插件的 `package.json` → `dsh.compatibility.dshReleases` 与 `docs/COMPATIBILITY.md`',
    '',
  )
  return lines.join('\n')
}

/**
 * 从 `gh issue list --json number,title,url` 的输出里找同名 open issue。
 * @param {string} stdout 原始输出。
 * @param {string} title 期望标题（精确比对）。
 * @returns {{number:number, url:string}|undefined} 命中的 issue。
 */
export function findExistingIssue(stdout, title) {
  let parsed
  try {
    parsed = JSON.parse(String(stdout ?? '').trim() === '' ? '[]' : stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const hit = parsed.find((issue) => issue?.title === title && Number.isInteger(issue?.number))
  if (hit === undefined) return undefined
  return { number: hit.number, url: typeof hit.url === 'string' ? hit.url : '' }
}

/**
 * 从 `gh issue create` 的输出里取 issue 编号与链接。
 * @param {string} stdout 原始输出（通常是新建 issue 的 URL）。
 * @returns {{number:number, url:string}} 结果。
 * @throws {ReportError} 500：输出里没有可识别的 issue 链接。
 */
export function parseCreatedIssue(stdout) {
  const match = /(https?:\/\/\S+\/issues\/(\d+))/.exec(String(stdout ?? ''))
  if (match === null) {
    throw new ReportError(500, `gh issue create 的输出里没有 issue 链接：${String(stdout ?? '').trim().slice(0, 200)}`)
  }
  return { number: Number(match[2]), url: match[1] }
}

/**
 * 幂等地创建 issue：先按标题找 open issue，没有才创建。
 * @param {object} input 输入。
 * @param {(args:string[]) => Promise<{ok:boolean, stdout:string, error?:string}>} input.runGh gh 执行器（测试缝）。
 * @param {string} input.slug `owner/repo`。
 * @param {string} input.title issue 标题。
 * @param {string} input.body issue 正文。
 * @returns {Promise<{ok:true, number:number, url:string, created:boolean}>} 结果。
 * @throws {ReportError} 500：gh 不可用 / 未登录 / 创建失败。
 */
export async function reportIssue(input) {
  const listed = await input.runGh([
    'issue', 'list',
    '--repo', input.slug,
    '--search', input.title,
    '--state', 'open',
    '--json', 'number,title,url',
    '--limit', '20',
  ])
  if (listed.ok !== true) {
    throw new ReportError(500, `gh issue list 失败（gh 不存在或未登录？）：${listed.error ?? 'unknown error'}`)
  }
  const existing = findExistingIssue(listed.stdout, input.title)
  if (existing !== undefined) {
    return { ok: true, number: existing.number, url: existing.url, created: false }
  }

  const created = await input.runGh([
    'issue', 'create',
    '--repo', input.slug,
    '--title', input.title,
    '--body', input.body,
  ])
  if (created.ok !== true) {
    throw new ReportError(500, `gh issue create 失败（gh 不存在或未登录？）：${created.error ?? 'unknown error'}`)
  }
  const parsed = parseCreatedIssue(created.stdout)
  return { ok: true, number: parsed.number, url: parsed.url, created: true }
}
