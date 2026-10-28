/**
 * 结果判定（三段式）+ 业务数据规范化。
 *
 * 三种结构必须分开对待，顺序不能反：
 * 1. **退出码**是第一依据（2 参数 / 3 密钥 / 4 限流 / 5–8 其它）。
 * 2. 退出码 0 但 stdout 是 CLI 自己的错误信封 `{"ok":false,"error":{...}}`
 *    —— 参数错误、Keychain 不可用等会用它。
 * 3. 退出码 0 且是服务端业务体 `{"Code":0,"Message":"success","Data":{...}}`
 *    —— `Code` 非 0 是业务错误（20001 鉴权、30001 限流），**HTTP 200 也可能藏错误**。
 *
 * 返回永远带上 `raw`，出问题时不靠猜。
 * @module dsh-plugin-zhihu-sidebar/host/parse
 */

/** 语义化原因。 */
export const REASON = {
  AUTH_REQUIRED: 'auth_required',
  RATE_LIMITED: 'rate_limited',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  INVALID_ARGUMENT: 'invalid_argument',
  NETWORK_ERROR: 'network_error',
  TIMEOUT: 'timeout',
  SERVER_ERROR: 'server_error',
  KEYCHAIN_UNAVAILABLE: 'keychain_unavailable',
  INSTALL_ERROR: 'install_error',
  BUSINESS_ERROR: 'business_error',
  PARSE_ERROR: 'parse_error',
  CLI_ERROR: 'cli_error',
  CLI_MISSING: 'cli_missing',
  UNKNOWN: 'unknown',
}

/** 退出码 → 原因。 */
export const EXIT_REASON = {
  2: REASON.INVALID_ARGUMENT,
  3: REASON.AUTH_REQUIRED,
  4: REASON.RATE_LIMITED,
  5: REASON.NETWORK_ERROR,
  6: REASON.SERVER_ERROR,
  7: REASON.KEYCHAIN_UNAVAILABLE,
  8: REASON.INSTALL_ERROR,
}

/** CLI 信封里的 `error.code` → 原因。 */
export const ENVELOPE_REASON = {
  AUTH_REQUIRED: REASON.AUTH_REQUIRED,
  UNAUTHORIZED: REASON.AUTH_REQUIRED,
  INVALID_ACCESS_SECRET: REASON.AUTH_REQUIRED,
  RATE_LIMITED: REASON.RATE_LIMITED,
  RATE_LIMIT_EXCEEDED: REASON.RATE_LIMITED,
  QUOTA_EXHAUSTED: REASON.QUOTA_EXHAUSTED,
  QUOTA_EXCEEDED: REASON.QUOTA_EXHAUSTED,
  INVALID_ARGUMENT: REASON.INVALID_ARGUMENT,
  NETWORK_ERROR: REASON.NETWORK_ERROR,
  TIMEOUT: REASON.TIMEOUT,
  KEYCHAIN_UNAVAILABLE: REASON.KEYCHAIN_UNAVAILABLE,
}

/** 业务码 → 原因。30001 是实测到的限流码；20001 是文档提到的鉴权码。 */
export const BUSINESS_REASON = {
  20001: REASON.AUTH_REQUIRED,
  30001: REASON.RATE_LIMITED,
}

/**
 * 安全地解析 JSON。
 * @param {string} text 文本。
 * @returns {unknown} 解析结果或 undefined。
 */
function tryParse(text) {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * @param {unknown} value 任意值。
 * @returns {value is Record<string, any>} 是否普通对象。
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value 任意值。
 * @returns {string} 字符串或空串。
 */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * @param {unknown} value 任意值。
 * @param {number} fallback 兜底。
 * @returns {number} 数字。
 */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 三段判定。
 * @param {{ code: number|null, stdout?: string, stderr?: string, timedOut?: boolean, spawnError?: string|null }} result CLI 原始结果。
 * @returns {{ ok: boolean, reason?: string, message?: string, actionUrl?: string, businessCode?: number, code: number|null, data?: unknown, raw: string, stderr: string }} 判定。
 */
export function parseResult(result) {
  const raw = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const base = { ok: false, code: result.code, raw, stderr }

  if (result.code === null) {
    const spawn = result.spawnError ?? ''
    return {
      ...base,
      reason:
        result.timedOut === true ? REASON.TIMEOUT : spawn.includes('ENOENT') ? REASON.CLI_MISSING : REASON.UNKNOWN,
      message:
        result.timedOut === true ? 'zhihu-cli timed out' : spawn === '' ? 'zhihu-cli did not exit normally' : spawn,
    }
  }

  const envelope = tryParse(raw)
  const envelopeError =
    isObject(envelope) && envelope.ok === false && isObject(envelope.error) ? envelope.error : undefined
  const envelopeMessage = envelopeError === undefined ? undefined : str(envelopeError.message)
  const envelopeAction = envelopeError === undefined ? undefined : str(envelopeError.action_url)
  const envelopeCode = envelopeError === undefined ? undefined : str(envelopeError.code)

  if (result.code !== 0) {
    const mapped = envelopeCode === undefined ? undefined : ENVELOPE_REASON[envelopeCode]
    const reason = mapped ?? EXIT_REASON[result.code] ?? REASON.UNKNOWN
    return {
      ...base,
      reason,
      ...(envelopeMessage === undefined || envelopeMessage === '' ? {} : { message: envelopeMessage }),
      ...(envelopeAction === undefined || envelopeAction === '' ? {} : { actionUrl: envelopeAction }),
      ...(envelopeCode === undefined ? {} : { cliCode: envelopeCode }),
    }
  }

  if (envelopeError !== undefined) {
    return {
      ...base,
      reason: (envelopeCode === undefined ? undefined : ENVELOPE_REASON[envelopeCode]) ?? REASON.CLI_ERROR,
      ...(envelopeMessage === undefined || envelopeMessage === '' ? {} : { message: envelopeMessage }),
      ...(envelopeAction === undefined || envelopeAction === '' ? {} : { actionUrl: envelopeAction }),
      ...(envelopeCode === undefined ? {} : { cliCode: envelopeCode }),
    }
  }

  if (!isObject(envelope)) {
    return { ...base, reason: REASON.PARSE_ERROR, message: 'stdout is not a JSON object' }
  }

  if (!Object.hasOwn(envelope, 'Code')) {
    return { ok: true, code: 0, data: envelope, raw, stderr }
  }

  const businessCode = Number(envelope.Code)
  if (!Number.isFinite(businessCode)) {
    return { ...base, reason: REASON.PARSE_ERROR, message: `invalid business code: ${String(envelope.Code)}` }
  }
  if (businessCode !== 0) {
    return {
      ...base,
      reason: BUSINESS_REASON[businessCode] ?? REASON.BUSINESS_ERROR,
      businessCode,
      message: str(envelope.Message) === '' ? `business error ${businessCode}` : str(envelope.Message),
    }
  }

  return {
    ok: true,
    code: 0,
    data: Object.hasOwn(envelope, 'Data') ? envelope.Data : envelope,
    businessCode: 0,
    message: str(envelope.Message),
    raw,
    stderr,
  }
}

/**
 * 热榜规范化。真实结构（已实测）：`Data: { Total, Items: [{ Title, Url, ThumbnailUrl, Summary }] }`。
 * @param {unknown} data 业务体 `Data`。
 * @returns {{ total: number, pageSize: number, items: { title: string, url: string, thumbnailUrl: string, summary: string }[] }} 规范化结果。
 */
export function normalizeHot(data) {
  const record = isObject(data) ? data : {}
  const items = Array.isArray(record.Items) ? record.Items : []
  const normalized = items
    .map((item) => {
      const entry = isObject(item) ? item : {}
      return {
        title: str(entry.Title ?? entry.title),
        url: str(entry.Url ?? entry.url),
        thumbnailUrl: str(entry.ThumbnailUrl ?? entry.thumbnail_url ?? entry.thumbnailUrl),
        summary: str(entry.Summary ?? entry.summary),
      }
    })
    .filter((item) => item.title !== '' || item.url !== '')
  return { total: num(record.Total ?? record.total, normalized.length), pageSize: normalized.length, items: normalized }
}

/**
 * 搜索规范化。真实结构（已实测）：
 * `Data: { HasMore, SearchHashId, Items: [{ Title, ContentType, ContentID, ContentText, Url, CommentCount,
 * VoteUpCount, AuthorName, … }] }` —— **没有 `Total`**，所以不返回 `total`，
 * 翻页信息只用 `hasMore` 表达（`null` = 服务端没给）。
 * @param {unknown} data 业务体。
 * @returns {{ pageSize: number, hasMore: boolean|null, items: { title: string, url: string, author: string, summary: string }[] }} 规范化结果。
 */
export function normalizeSearch(data) {
  const record = isObject(data) ? data : {}
  const items = Array.isArray(record.Items) ? record.Items : []
  const normalized = items
    .map((item) => {
      const entry = isObject(item) ? item : {}
      return {
        title: str(entry.Title ?? entry.title),
        url: str(entry.Url ?? entry.url),
        author: str(entry.AuthorName ?? entry.author_name ?? entry.Author ?? entry.author),
        summary: str(entry.ContentText ?? entry.Excerpt ?? entry.Summary ?? entry.summary),
      }
    })
    .filter((item) => item.title !== '' || item.url !== '')
  const hasMore = typeof record.HasMore === 'boolean' ? record.HasMore : null
  return { pageSize: normalized.length, hasMore, items: normalized }
}

/**
 * 「我的创作」规范化。真实结构（已实测）：
 * `Data: { Items: [{ ContentType, Url, CreatedAt, LikeCount, CommentCount, FavoriteCount, Title, Summary }],
 * Paging: { IsEnd, NextOffset, Totals } }` —— **`Data` 没有 `Total`**，总数在 `Paging.Totals`。
 * `CreatedAt` 是 Unix **秒级**数字，这里保留数字（`null` = 缺失），由 UI 决定格式化方式。
 * @param {unknown} data 业务体。
 * @returns {{ total: number|null, pageSize: number, hasMore: boolean|null, nextOffset: number|null, items: { title: string, url: string, type: string, createdAt: number|null, summary: string }[] }} 规范化结果。
 */
export function normalizeContents(data) {
  const record = isObject(data) ? data : {}
  const paging = isObject(record.Paging) ? record.Paging : {}
  const items = Array.isArray(record.Items) ? record.Items : []
  const normalized = items
    .map((item) => {
      const entry = isObject(item) ? item : {}
      const rawCreated = entry.CreatedAt ?? entry.created_at ?? entry.Created ?? entry.created
      return {
        title: str(entry.Title ?? entry.title),
        url: str(entry.Url ?? entry.url),
        type: str(entry.ContentType ?? entry.content_type ?? entry.Type ?? entry.type),
        createdAt: typeof rawCreated === 'number' && Number.isFinite(rawCreated) ? rawCreated : null,
        summary: str(entry.Summary ?? entry.summary ?? entry.Excerpt ?? entry.ContentText),
      }
    })
    .filter((item) => item.title !== '' || item.url !== '')
  return {
    total: typeof paging.Totals === 'number' ? paging.Totals : null,
    pageSize: normalized.length,
    hasMore: typeof paging.IsEnd === 'boolean' ? !paging.IsEnd : null,
    nextOffset: typeof paging.NextOffset === 'number' ? paging.NextOffset : null,
    items: normalized,
  }
}

/**
 * 能力清单规范化：只留本插件关心的字段（参数上下界）。
 * @param {unknown} data `capabilities` 输出。
 * @returns {{ version: string, commands: { name: string, limit: { min: number, max: number, default: number }|null, count: { min: number, max: number, default: number }|null }[] }} 规范化结果。
 */
export function normalizeCapabilities(data) {
  const record = isObject(data) ? data : {}
  const commands = Array.isArray(record.commands) ? record.commands : []
  /**
   * @param {unknown} value 任意。
   * @returns {{ min: number, max: number, default: number }|null} 边界。
   */
  const bounds = (value) => {
    if (!isObject(value)) return null
    return { min: num(value.min, 0), max: num(value.max, 0), default: num(value.default, 0) }
  }
  return {
    version: str(record.version),
    commands: commands.map((command) => {
      const entry = isObject(command) ? command : {}
      return { name: str(entry.name), limit: bounds(entry.limit), count: bounds(entry.count) }
    }),
  }
}
