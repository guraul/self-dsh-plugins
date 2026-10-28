/**
 * 浏览器半边：右侧栏「知乎」页。
 *
 * 右侧栏是**两段式注册**，缺一不可：
 * 1. `ctx.sidebarRightTabs.register(definition)` 声明 tab 类型（纯静态：id / kind / title / guide）；
 * 2. `ctx.slots.inject('sidebar.right.pane.tab', …)` 在同一个 `id` 下挂正文。
 * 打开入口第一版只有引导页卡片（`guide`），不注册会话头按钮、不碰设置页。
 *
 * 一个 tab 装三个子视图（热榜 / 搜索 / 我的创作），用分段切换，不占三条 tab。
 * 数据全部走第一阶段已经做好的宿主路由（`/api/dsh-zhihu-sidebar/*`），
 * 缓存 / 串行 / 退避 / 额度闸门都在宿主侧，UI **不绕过**它们，也不自己算额度。
 *
 * 额度纪律：热榜每天只有 100 次，所以**任何视图都不自动请求**——
 * 只在用户点按钮时发一次，热榜按钮上写着下次可刷新的倒计时（30 分钟内不再放行）。
 *
 * 无构建步骤：手写并包在 `window.__ModuleLoader__.load({ id, factory })` 里，
 * 与 dsh-external-discuss / dsh-auto-upgrade 的浏览器半边同形。
 * 纯逻辑（取数 URL、信封判定、冷却倒计时、行映射）都在本文件内，
 * 通过 `exports.__internals` 暴露给单测，避免「测试对着副本测」。
 * @module dsh-plugin-zhihu-sidebar/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-zhihu-sidebar',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement

    /** 客户端插件 id（= 包名，模块表用它做注册键）。 */
    const TAB_ID = 'dsh-plugin-zhihu-sidebar'
    /** tab 类型判别值，`openTab` 用它，引导卡片也按它打开。 */
    const TAB_KIND = 'zhihu'
    /** 文案命名空间。 */
    const NS = 'dsh-zhihu-sidebar'

    /**
     * 路由前缀（**文档相对**，不带前导 `/`）：dsh web 可能挂在子路径下，
     * 与官方插件一致用相对 URL，由浏览器按当前文档解析。
     * 路径必须与 `lib/host/http.js` 的 `API` 常量一致——`test/client.test.mjs` 会逐条比对。
     */
    const API_BASE = 'api/dsh-zhihu-sidebar'
    const ROUTES = {
      hot: `${API_BASE}/hot`,
      search: `${API_BASE}/search`,
      contents: `${API_BASE}/contents`,
    }

    /** 子视图（一个 tab 三个）。 */
    const VIEWS = ['hot', 'search', 'contents']
    const DEFAULT_VIEW = 'hot'

    /** 与宿主 `LIMITS` 的默认值一致（真正的上下界由宿主夹取）。 */
    const LIMITS = { hot: 30, search: 10, contents: 20 }

    /**
     * 热榜的最短刷新间隔。每日 100 次额度，30 分钟一次最多 48 次/天，
     * 留出足够余量给手动操作与重试。
     */
    const HOT_REFRESH_INTERVAL_MS = 30 * 60 * 1000

    /** 无密钥时给用户的申请入口（宿主没带 `actionUrl` 时兜底）。 */
    const AUTH_CONSOLE_URL = 'https://developer.zhihu.com/profile'

    /** 失败原因 → UI 种类。未列出的原因一律「普通错误」。 */
    const FAILURE_KIND = {
      auth_required: 'auth',
      rate_limited: 'rate',
      quota_exhausted: 'quota',
    }

    /** 失败原因 → 文案键。 */
    const ERROR_KEYS = {
      invalid_argument: 'error.invalid_argument',
      business_error: 'error.business_error',
      network_error: 'error.network_error',
      timeout: 'error.timeout',
      server_error: 'error.server_error',
      cli_missing: 'error.cli_missing',
      keychain_unavailable: 'error.keychain_unavailable',
      install_error: 'error.install_error',
      parse_error: 'error.parse_error',
    }

    /** `ContentType` → 文案键（识别不出的值原样显示）。 */
    const CONTENT_TYPES = {
      answer: 'type.answer',
      article: 'type.article',
      pin: 'type.pin',
      question: 'type.question',
      zvideo: 'type.video',
    }

    /** 子视图 → 空闲态文案键。 */
    const IDLE_KEYS = { hot: 'hot.idle', search: 'search.idle', contents: 'contents.idle' }

    const MINUTE = 60
    const HOUR = 60 * MINUTE
    const DAY = 24 * HOUR
    const MONTH = 30 * DAY
    const YEAR = 365 * DAY

    const COLOR = {
      primary: 'var(--dsw-alias-label-primary, #1a1a1a)',
      secondary: 'var(--dsw-alias-label-secondary, #616161)',
      tertiary: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      border: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
      layer: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03))',
      accent: 'var(--dsw-alias-state-business-primary, #2b6cff)',
      error: 'var(--dsw-alias-state-error-primary, #d93f4c)',
      warning: 'var(--dsw-alias-state-warn-primary, #b26a00)',
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        color: COLOR.primary,
        font: 'inherit',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '8px 10px',
        borderBottom: `1px solid ${COLOR.border}`,
        flex: '0 0 auto',
      },
      segment: {
        padding: '3px 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        color: COLOR.secondary,
        font: 'inherit',
        fontSize: 'var(--dsw-font-xxs-12, 12px)',
        lineHeight: 'var(--dsw-font-xxs-12-line-height, 18px)',
        cursor: 'pointer',
      },
      segmentActive: { background: COLOR.layer, color: COLOR.primary, fontWeight: 600 },
      spacer: { flex: 1 },
      action: {
        padding: '3px 8px',
        border: `1px solid ${COLOR.border}`,
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        color: COLOR.accent,
        font: 'inherit',
        fontSize: 'var(--dsw-font-xxs-12, 12px)',
        lineHeight: 'var(--dsw-font-xxs-12-line-height, 18px)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      actionDisabled: { color: COLOR.tertiary, cursor: 'not-allowed' },
      searchBar: {
        display: 'flex',
        gap: 6,
        padding: '8px 10px',
        borderBottom: `1px solid ${COLOR.border}`,
        flex: '0 0 auto',
      },
      input: {
        flex: 1,
        minWidth: 0,
        padding: '5px 8px',
        border: `1px solid ${COLOR.border}`,
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        color: COLOR.primary,
        font: 'inherit',
        fontSize: 'var(--dsw-font-xxs-12, 12px)',
      },
      scroll: { flex: 1, minHeight: 0, overflowY: 'auto' },
      notice: {
        margin: 12,
        padding: '10px 12px',
        borderRadius: 'var(--dsw-radius-lg, 8px)',
        border: `1px solid ${COLOR.border}`,
        background: COLOR.layer,
        color: COLOR.secondary,
        lineHeight: 'var(--dsw-font-xs-13-line-height, 20px)',
      },
      failureTitle: { fontWeight: 600, color: COLOR.primary },
      failureDetail: { marginTop: 4, color: COLOR.tertiary, fontSize: 'var(--dsw-font-xxs-12, 12px)', wordBreak: 'break-word' },
      failureAction: {
        display: 'inline-block',
        marginTop: 8,
        padding: '4px 10px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: COLOR.accent,
        color: 'var(--dsw-static-neutral-00, #fff)',
        textDecoration: 'none',
        fontSize: 'var(--dsw-font-xxs-12, 12px)',
      },
      list: { listStyle: 'none', margin: 0, padding: 0 },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 12px',
        borderBottom: `1px solid ${COLOR.border}`,
      },
      rank: { flex: '0 0 18px', color: COLOR.tertiary, fontVariantNumeric: 'tabular-nums', lineHeight: 'var(--dsw-font-xs-13-line-height, 20px)' },
      rowBody: { flex: 1, minWidth: 0 },
      rowTitle: { color: COLOR.primary, textDecoration: 'none', fontWeight: 500, lineHeight: 'var(--dsw-font-xs-13-line-height, 20px)' },
      rowMeta: { marginTop: 2, color: COLOR.tertiary, fontSize: 'var(--dsw-font-xxxs-11, 11px)', lineHeight: 'var(--dsw-font-xxxs-11-line-height, 16px)' },
      rowSummary: {
        marginTop: 4,
        color: COLOR.secondary,
        fontSize: 'var(--dsw-font-xxs-12, 12px)',
        lineHeight: 'var(--dsw-font-xxs-12-line-height, 18px)',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      thumb: { flex: '0 0 44px', width: 44, height: 44, borderRadius: 'var(--dsw-radius-sm, 6px)', objectFit: 'cover', background: COLOR.layer },
      footer: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        padding: '6px 12px',
        color: COLOR.tertiary,
        fontSize: 'var(--dsw-font-xxxs-11, 11px)',
        borderTop: `1px solid ${COLOR.border}`,
      },
      staleBanner: { margin: '10px 12px 0', padding: '6px 10px', color: COLOR.warning, fontSize: 'var(--dsw-font-xxs-12, 12px)', lineHeight: 'var(--dsw-font-xxs-12-line-height, 18px)' },
    }

    const zh = {
      'tab.title': '知乎',
      'guide.title': '知乎热榜 / 搜索 / 我的创作',
      'guide.description': '来自知乎开放平台的实时数据',
      'view.hot': '热榜',
      'view.search': '搜索',
      'view.contents': '我的创作',
      'hot.load': '加载热榜',
      'hot.refresh': '刷新热榜',
      'hot.wait': '{time} 后可刷新',
      'hot.nextAt': '下次可刷新：{time}',
      'hot.idle': '还没有取过热榜。热榜每天只有 100 次额度，所以这里不会自动刷新——点右上角按钮取一次。',
      'search.placeholder': '搜索知乎…',
      'search.submit': '搜索',
      'search.idle': '输入关键词后按回车或点「搜索」。',
      'search.more': '还有更多结果',
      'search.end': '已到最后一页',
      'contents.load': '加载我的创作',
      'contents.refresh': '刷新我的创作',
      'contents.idle': '点右上角按钮读取当前账号的公开创作。',
      'contents.notice': '只显示当前 Access Secret 所属账号的公开创作',
      'state.loading': '读取中…',
      'state.empty': '这一页没有内容。',
      'state.cached': '缓存',
      'state.stale': '被限流，显示的是缓存数据，{time} 后可重试',
      'state.updated': '更新于 {time}',
      'state.pageSize': '本页 {count} 条',
      'state.total': '共 {count} 条',
      'type.answer': '回答',
      'type.article': '文章',
      'type.pin': '想法',
      'type.question': '问题',
      'type.video': '视频',
      'age.justNow': '刚刚',
      'age.minute': '{count} 分钟前',
      'age.hour': '{count} 小时前',
      'age.day': '{count} 天前',
      'age.month': '{count} 个月前',
      'age.year': '{count} 年前',
      'error.auth': '需要知乎 Access Secret',
      'error.authAction': '去申请密钥',
      'error.rate': '被知乎限流，{time} 后可重试',
      'error.quota': '今日额度已用完（剩余 {count} 次）',
      'error.quotaUnknown': '今日额度已用完',
      'error.invalid_argument': '参数不合法',
      'error.business_error': '知乎返回业务错误',
      'error.network_error': '连不上知乎',
      'error.timeout': '请求超时',
      'error.server_error': '服务端错误',
      'error.cli_missing': '找不到 zhihu-cli',
      'error.keychain_unavailable': '系统凭证库不可用',
      'error.install_error': 'zhihu-cli 安装异常',
      'error.parse_error': '响应无法解析',
      'error.generic': '请求失败',
    }

    const en = {
      'tab.title': 'Zhihu',
      'guide.title': 'Zhihu hot list / search / my posts',
      'guide.description': 'Live data from the Zhihu open platform',
      'view.hot': 'Hot',
      'view.search': 'Search',
      'view.contents': 'My posts',
      'hot.load': 'Load hot list',
      'hot.refresh': 'Refresh',
      'hot.wait': 'Refresh in {time}',
      'hot.nextAt': 'Next refresh at {time}',
      'hot.idle':
        'The hot list has not been loaded. It is capped at 100 requests a day, so nothing loads on its own — use the button above.',
      'search.placeholder': 'Search Zhihu…',
      'search.submit': 'Search',
      'search.idle': 'Type a keyword, then press Enter or Search.',
      'search.more': 'More results available',
      'search.end': 'Last page',
      'contents.load': 'Load my posts',
      'contents.refresh': 'Refresh',
      'contents.idle': 'Use the button above to read the public posts of this account.',
      'contents.notice': 'Only public posts of the account behind the current Access Secret',
      'state.loading': 'Loading…',
      'state.empty': 'Nothing on this page.',
      'state.cached': 'cached',
      'state.stale': 'Rate limited; showing cached data, retry in {time}',
      'state.updated': 'Updated {time}',
      'state.pageSize': '{count} shown',
      'state.total': '{count} total',
      'type.answer': 'Answer',
      'type.article': 'Article',
      'type.pin': 'Pin',
      'type.question': 'Question',
      'type.video': 'Video',
      'age.justNow': 'just now',
      'age.minute': '{count} min ago',
      'age.hour': '{count} h ago',
      'age.day': '{count} d ago',
      'age.month': '{count} mo ago',
      'age.year': '{count} y ago',
      'error.auth': 'A Zhihu Access Secret is required',
      'error.authAction': 'Get a key',
      'error.rate': 'Rate limited by Zhihu; retry in {time}',
      'error.quota': 'Daily quota used up ({count} left)',
      'error.quotaUnknown': 'Daily quota used up',
      'error.invalid_argument': 'Invalid arguments',
      'error.business_error': 'Zhihu returned a business error',
      'error.network_error': 'Cannot reach Zhihu',
      'error.timeout': 'Request timed out',
      'error.server_error': 'Server error',
      'error.cli_missing': 'zhihu-cli not found',
      'error.keychain_unavailable': 'System keychain unavailable',
      'error.install_error': 'zhihu-cli installation problem',
      'error.parse_error': 'Unreadable response',
      'error.generic': 'Request failed',
    }

    /**
     * 是否普通对象。
     * @param {unknown} value 任意值。
     * @returns {boolean} 非 null、非数组的对象。
     */
    function isObject(value) {
      return value !== null && typeof value === 'object' && Array.isArray(value) === false
    }

    /**
     * 取有限数字。
     * @param {unknown} value 任意值。
     * @param {number|null} fallback 兜底。
     * @returns {number|null} 数字或兜底。
     */
    function finiteOr(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    /**
     * 取非空字符串。
     * @param {unknown} value 任意值。
     * @param {string|null} fallback 兜底。
     * @returns {string|null} 字符串或兜底。
     */
    function textOr(value, fallback) {
      return typeof value === 'string' && value !== '' ? value : fallback
    }

    /**
     * 子视图名归一：未知值落回默认视图。
     * @param {unknown} value 任意值。
     * @returns {string} `hot` / `search` / `contents`。
     */
    function normalizeView(value) {
      return VIEWS.indexOf(value) === -1 ? DEFAULT_VIEW : value
    }

    /**
     * 拼查询串：跳过 `undefined` / `null` / 空串，键序固定，值做 URI 编码。
     * @param {string} route 路由。
     * @param {Record<string, unknown>} params 参数。
     * @returns {string} 带查询串的 URL（无参数时原样返回路由）。
     */
    function withQuery(route, params) {
      const pairs = []
      for (const name of Object.keys(params)) {
        const value = params[name]
        if (value === undefined || value === null || value === '') continue
        pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
      }
      return pairs.length === 0 ? route : `${route}?${pairs.join('&')}`
    }

    /**
     * 热榜请求。
     * @param {number} [limit] 条数。
     * @returns {{ view: string, url: string }} 请求。
     */
    function hotRequest(limit) {
      return { view: 'hot', url: withQuery(ROUTES.hot, { limit: limit === undefined ? LIMITS.hot : limit }) }
    }

    /**
     * 搜索请求。关键词去首尾空白后进 `q`（宿主只认 `q`，不认位置参数）。
     * @param {string} query 关键词。
     * @param {number} [count] 条数。
     * @returns {{ view: string, url: string, query: string }} 请求。
     */
    function searchRequest(query, count) {
      const keyword = typeof query === 'string' ? query.trim() : ''
      return {
        view: 'search',
        url: withQuery(ROUTES.search, { q: keyword, count: count === undefined ? LIMITS.search : count }),
        query: keyword,
      }
    }

    /**
     * 我的创作请求。
     * @param {number} [limit] 条数。
     * @returns {{ view: string, url: string }} 请求。
     */
    function contentsRequest(limit) {
      return {
        view: 'contents',
        url: withQuery(ROUTES.contents, { limit: limit === undefined ? LIMITS.contents : limit }),
      }
    }

    /**
     * 失败视图模型的公共形状。
     * @param {string} reason 原因。
     * @param {string} message 原始消息。
     * @param {number} retryAfterMs 冷却剩余。
     * @returns {object} 视图模型。
     */
    function failureModel(reason, message, retryAfterMs) {
      return {
        kind: 'error',
        stale: false,
        cached: false,
        reason,
        retryAfterMs,
        message,
        actionUrl: null,
        remaining: null,
        data: null,
        fetchedAt: null,
      }
    }

    /**
     * 把宿主信封读成统一的视图模型。
     *
     * 成功（`ok: true`）保留 `stale` / `cached` / `fetchedAt`；
     * 失败按 `reason` 分四类：`auth`（要给申请入口）、`rate`（要给倒计时）、
     * `quota`（要给剩余额度）、`error`（只给消息）。
     * @param {unknown} body 宿主响应体。
     * @returns {object} 视图模型。
     */
    function readResult(body) {
      if (!isObject(body)) return failureModel('parse_error', '', 0)
      const reason = typeof body.reason === 'string' ? body.reason : null
      const retryAfterMs = Math.max(0, finiteOr(body.retryAfterMs, 0))
      if (body.ok === true) {
        return {
          kind: 'ok',
          stale: body.stale === true,
          cached: body.cached === true,
          reason,
          retryAfterMs,
          message: '',
          actionUrl: null,
          remaining: null,
          data: body.data === undefined ? null : body.data,
          fetchedAt: finiteOr(body.fetchedAt, null),
        }
      }
      const kind = FAILURE_KIND[reason] ?? 'error'
      const quota = isObject(body.quota) ? body.quota : null
      return {
        ...failureModel(reason ?? 'unknown', textOr(body.message, ''), retryAfterMs),
        kind,
        actionUrl: kind === 'auth' ? textOr(body.actionUrl, AUTH_CONSOLE_URL) : null,
        remaining: quota === null ? null : finiteOr(quota.remaining, null),
      }
    }

    /**
     * 取一份数据并归一成视图模型（不抛错：网络与解析失败都变成失败模型）。
     * @param {(url: string, init?: object) => Promise<Response>} fetchImpl fetch 实现。
     * @param {{ url: string }} request 请求。
     * @returns {Promise<object>} 视图模型。
     */
    async function fetchView(fetchImpl, request) {
      const init = { headers: { accept: 'application/json' }, credentials: 'same-origin' }
      let response
      try {
        response = await fetchImpl(request.url, init)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return readResult({ ok: false, reason: 'network_error', message })
      }
      let body
      try {
        body = await response.json()
      } catch {
        return readResult({ ok: false, reason: 'parse_error', message: `HTTP ${response.status}` })
      }
      return readResult(body)
    }

    /**
     * 热榜刷新计划：上一次取数时间 + 冷却间隔 = 下次可刷新时刻。
     * @param {number|null} lastFetchedAt 上次取数时间（毫秒）。
     * @param {number} now 当前时间（毫秒）。
     * @returns {{ deadline: number|null, remaining: number, ready: boolean }} 计划。
     */
    function refreshPlan(lastFetchedAt, now) {
      if (typeof lastFetchedAt !== 'number' || Number.isFinite(lastFetchedAt) === false) {
        return { deadline: null, remaining: 0, ready: true }
      }
      const deadline = lastFetchedAt + HOT_REFRESH_INTERVAL_MS
      const remaining = Math.max(0, deadline - now)
      return { deadline, remaining, ready: remaining === 0 }
    }

    /**
     * 冷却剩余：响应时刻 + `retryAfterMs` - 现在。逐秒重算才能真的倒数到 0。
     * @param {object|null} result 视图模型。
     * @param {number} at 拿到响应的时刻（毫秒）。
     * @param {number} now 当前时间（毫秒）。
     * @returns {number} 剩余毫秒，最小 0。
     */
    function remainingRetry(result, at, now) {
      if (result === null) return 0
      const start = finiteOr(at, null)
      if (start === null) return 0
      return Math.max(0, start + Math.max(0, finiteOr(result.retryAfterMs, 0)) - now)
    }

    /**
     * 毫秒 → `分:秒`（向上取整到秒，倒计时不会提前显示 0:00）。
     * @param {number} ms 毫秒。
     * @returns {string} `m:ss`。
     */
    function formatDuration(ms) {
      const seconds = Math.ceil(Math.max(0, ms) / 1000)
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    }

    /**
     * 毫秒时间戳 → 本地 `HH:MM`。
     * @param {number} timestamp 毫秒时间戳。
     * @returns {string} `HH:MM`。
     */
    function formatClock(timestamp) {
      const date = new Date(timestamp)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /**
     * Unix 秒级时间戳 → 相对时间结构（文案由字典拼，函数不碰语言）。
     * @param {number|null} createdAtSeconds 秒级时间戳。
     * @param {number} now 当前时间（毫秒）。
     * @returns {{ unit: string, count: number }|null} 相对时间；缺失返回 null。
     */
    function describeAge(createdAtSeconds, now) {
      if (typeof createdAtSeconds !== 'number' || Number.isFinite(createdAtSeconds) === false) return null
      const seconds = Math.max(0, Math.floor((now - createdAtSeconds * 1000) / 1000))
      if (seconds < MINUTE) return { unit: 'justNow', count: 0 }
      if (seconds < HOUR) return { unit: 'minute', count: Math.floor(seconds / MINUTE) }
      if (seconds < DAY) return { unit: 'hour', count: Math.floor(seconds / HOUR) }
      if (seconds < MONTH) return { unit: 'day', count: Math.floor(seconds / DAY) }
      if (seconds < YEAR) return { unit: 'month', count: Math.floor(seconds / MONTH) }
      return { unit: 'year', count: Math.floor(seconds / YEAR) }
    }

    /**
     * 行主键：优先用链接，没有链接时退到序号（宿主已保证两者至少一个非空）。
     * @param {{ url: string }} item 条目。
     * @param {number} index 序号。
     * @returns {string} 键。
     */
    function rowKey(item, index) {
      return item.url === '' ? `item-${index}` : item.url
    }

    /**
     * 热榜行。
     * @param {unknown} data 宿主 `data`。
     * @returns {object[]} 行。
     */
    function hotRows(data) {
      const items = isObject(data) && Array.isArray(data.items) ? data.items : []
      return items.map((item, index) => ({
        key: rowKey(item, index),
        title: item.title,
        url: item.url,
        summary: item.summary,
        thumbnailUrl: item.thumbnailUrl,
      }))
    }

    /**
     * 搜索结果行。
     * @param {unknown} data 宿主 `data`。
     * @returns {object[]} 行。
     */
    function searchRows(data) {
      const items = isObject(data) && Array.isArray(data.items) ? data.items : []
      return items.map((item, index) => ({
        key: rowKey(item, index),
        title: item.title,
        url: item.url,
        author: item.author,
        summary: item.summary,
      }))
    }

    /**
     * 我的创作行（`createdAt` 是秒级数字，这里转成相对时间结构）。
     * @param {unknown} data 宿主 `data`。
     * @param {number} now 当前时间（毫秒）。
     * @returns {object[]} 行。
     */
    function contentRows(data, now) {
      const items = isObject(data) && Array.isArray(data.items) ? data.items : []
      return items.map((item, index) => ({
        key: rowKey(item, index),
        title: item.title,
        url: item.url,
        type: item.type,
        summary: item.summary,
        age: describeAge(item.createdAt, now),
      }))
    }

    /**
     * 总数：只有热榜与我的创作知道（搜索响应没有 `Total`，不许编一个）。
     * @param {string} view 子视图。
     * @param {unknown} data 宿主 `data`。
     * @returns {number|null} 总数或 null。
     */
    function totalOf(view, data) {
      if (view === 'search' || !isObject(data)) return null
      return finiteOr(data.total, null)
    }

    /**
     * 本页条数。
     * @param {unknown} data 宿主 `data`。
     * @returns {number} 条数。
     */
    function pageSizeOf(data) {
      return isObject(data) ? finiteOr(data.pageSize, 0) : 0
    }

    /**
     * `ContentType` → 可读标签；识别不出的值原样返回，空值返回空串。
     * @param {string} type 类型。
     * @param {(key: string, params?: object) => string} t 翻译函数。
     * @returns {string} 标签。
     */
    function contentLabel(type, t) {
      if (typeof type !== 'string' || type === '') return ''
      const key = CONTENT_TYPES[type.toLowerCase()]
      return key === undefined ? type : t(key)
    }

    /**
     * 失败态怎么显示：文案、语气、以及要不要给「去申请密钥」按钮。
     * @param {object} result 视图模型。
     * @param {(key: string, params?: object) => string} t 翻译函数。
     * @returns {{ tone: string, message: string, detail: string, action: { label: string, url: string }|null }} 展示信息。
     */
    function describeFailureUi(result, t) {
      const detail = result.message === '' ? '' : result.message
      if (result.kind === 'auth') {
        return {
          tone: 'warning',
          message: t('error.auth'),
          detail,
          action: { label: t('error.authAction'), url: result.actionUrl },
        }
      }
      if (result.kind === 'rate') {
        return {
          tone: 'warning',
          message: t('error.rate', { time: formatDuration(result.retryAfterMs) }),
          detail,
          action: null,
        }
      }
      if (result.kind === 'quota') {
        const message =
          result.remaining === null ? t('error.quotaUnknown') : t('error.quota', { count: String(result.remaining) })
        return { tone: 'warning', message, detail, action: null }
      }
      return { tone: 'error', message: t(ERROR_KEYS[result.reason] ?? 'error.generic'), detail, action: null }
    }

    /**
     * 一行。
     * @param {string} view 子视图。
     * @param {object} row 行。
     * @param {number} index 序号。
     * @param {(key: string, params?: object) => string} t 翻译函数。
     * @returns {object} React 元素。
     */
    function renderRow(view, row, index, t) {
      const meta = []
      if (view === 'search' && row.author !== '') meta.push(row.author)
      if (view === 'contents') {
        const label = contentLabel(row.type, t)
        if (label !== '') meta.push(label)
        if (row.age !== null) meta.push(t(`age.${row.age.unit}`, { count: String(row.age.count) }))
      }
      const title =
        row.url === ''
          ? h('span', { style: styles.rowTitle }, row.title)
          : h('a', { href: row.url, target: '_blank', rel: 'noreferrer', style: styles.rowTitle }, row.title)
      return h(
        'li',
        { key: row.key, style: styles.row },
        view === 'hot' ? h('span', { style: styles.rank }, String(index + 1)) : null,
        h(
          'div',
          { style: styles.rowBody },
          title,
          meta.length === 0 ? null : h('div', { style: styles.rowMeta }, meta.join(' · ')),
          row.summary === '' ? null : h('div', { style: styles.rowSummary }, row.summary),
        ),
        view === 'hot' && row.thumbnailUrl !== ''
          ? h('img', { src: row.thumbnailUrl, alt: '', loading: 'lazy', style: styles.thumb })
          : null,
      )
    }

    /**
     * 结果区：列表 + 页脚（更新时间 / 缓存标记 / 条数 / 是否还有更多）。
     * @param {string} view 子视图。
     * @param {object} result 视图模型。
     * @param {(key: string, params?: object) => string} t 翻译函数。
     * @param {number} now 当前时间（毫秒）。
     * @returns {object} React 元素。
     */
    function renderList(view, result, t, now) {
      const data = result.data
      const rows = view === 'hot' ? hotRows(data) : view === 'search' ? searchRows(data) : contentRows(data, now)
      const footer = []
      if (result.fetchedAt !== null) footer.push(t('state.updated', { time: formatClock(result.fetchedAt) }))
      if (result.cached) footer.push(t('state.cached'))
      footer.push(t('state.pageSize', { count: String(pageSizeOf(data)) }))
      const total = totalOf(view, data)
      if (total !== null) footer.push(t('state.total', { count: String(total) }))
      if (view === 'search' && isObject(data) && data.hasMore === true) footer.push(t('search.more'))
      if (view === 'search' && isObject(data) && data.hasMore === false) footer.push(t('search.end'))
      if (view === 'contents') footer.push(t('contents.notice'))
      return h(
        'div',
        { style: styles.scroll },
        result.stale
          ? h('div', { style: styles.staleBanner }, t('state.stale', { time: formatDuration(result.retryAfterMs) }))
          : null,
        rows.length === 0
          ? h('p', { style: styles.notice }, t('state.empty'))
          : h(
              'ul',
              { style: styles.list },
              rows.map((row, index) => renderRow(view, row, index, t)),
            ),
        h('div', { style: styles.footer }, footer.join(' · ')),
      )
    }

    /**
     * 失败区。`auth` 给外链按钮，`rate` / `quota` 只给文案（冷却倒计时已在文案里）。
     * @param {object} result 视图模型。
     * @param {(key: string, params?: object) => string} t 翻译函数。
     * @returns {object} React 元素。
     */
    function renderFailure(result, t) {
      const ui = describeFailureUi(result, t)
      return h(
        'div',
        { style: { ...styles.notice, borderColor: ui.tone === 'warning' ? COLOR.warning : COLOR.error } },
        h('div', { style: styles.failureTitle }, ui.message),
        ui.detail === '' ? null : h('div', { style: styles.failureDetail }, ui.detail),
        ui.action === null
          ? null
          : h(
              'a',
              { href: ui.action.url, target: '_blank', rel: 'noreferrer', style: styles.failureAction },
              ui.action.label,
            ),
      )
    }

    /** 空状态。 */
    function idleState() {
      return { status: 'idle', result: null, at: 0 }
    }

    /** 三个子视图的初始状态。 */
    function createStates() {
      return { hot: idleState(), search: idleState(), contents: idleState() }
    }

    /** 默认 fetch（单独一层，方便测试注入）。 */
    function fetchJson(url, init) {
      return fetch(url, init)
    }

    /**
     * 一个 tab 的正文：分段切三个视图，每个视图自己一套「空闲 / 读取中 / 结果 / 失败」。
     * 所有请求都由点击触发，没有任何自动轮询，也没有挂载即取。
     * @param {object} props 插槽属性（`t` 由 `locale` 命名空间提供）。
     * @returns {object} React 元素。
     */
    function ZhihuTabBody(props) {
      const t = props.t
      const [view, setView] = react.useState(DEFAULT_VIEW)
      const [states, setStates] = react.useState(createStates)
      const [query, setQuery] = react.useState('')
      const [now, setNow] = react.useState(() => Date.now())

      const current = states[view]
      const result = current.result
      const liveRetry = remainingRetry(result, current.at, now)
      const shown = result === null ? null : { ...result, retryAfterMs: liveRetry }
      const plan = refreshPlan(states.hot.result === null ? null : states.hot.result.fetchedAt, now)
      const cooling = liveRetry > 0
      const waiting = view === DEFAULT_VIEW && plan.ready === false
      const counting = cooling || waiting

      react.useEffect(() => {
        if (!counting) return undefined
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
      }, [counting])

      const load = (target, request) => {
        setStates((previous) => ({ ...previous, [target]: { ...previous[target], status: 'loading' } }))
        fetchView(fetchJson, request).then((next) => {
          setStates((previous) => ({
            ...previous,
            [target]: { status: next.kind === 'ok' ? 'ready' : 'failed', result: next, at: Date.now() },
          }))
        })
      }

      const submitSearch = () => {
        if (query.trim() === '') return
        load('search', searchRequest(query))
      }

      const busy = current.status === 'loading'
      const exhausted = result !== null && result.kind === 'quota'

      let action = null
      if (view === 'hot') {
        const blocked = busy || exhausted || cooling || plan.ready === false
        const label =
          plan.ready === false
            ? t('hot.wait', { time: formatDuration(plan.remaining) })
            : states.hot.status === 'idle'
              ? t('hot.load')
              : t('hot.refresh')
        action = h(
          'button',
          {
            type: 'button',
            disabled: blocked,
            style: blocked ? { ...styles.action, ...styles.actionDisabled } : styles.action,
            title: plan.deadline === null ? '' : t('hot.nextAt', { time: formatClock(plan.deadline) }),
            onClick: () => load('hot', hotRequest()),
          },
          label,
        )
      } else if (view === 'contents') {
        const blocked = busy || exhausted || cooling
        action = h(
          'button',
          {
            type: 'button',
            disabled: blocked,
            style: blocked ? { ...styles.action, ...styles.actionDisabled } : styles.action,
            onClick: () => load('contents', contentsRequest()),
          },
          states.contents.status === 'idle' ? t('contents.load') : t('contents.refresh'),
        )
      }

      const body =
        shown !== null && shown.kind !== 'ok'
          ? renderFailure(shown, t)
          : shown !== null
            ? renderList(view, shown, t, now)
            : h('p', { style: styles.notice }, busy ? t('state.loading') : t(IDLE_KEYS[view]))

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.bar },
          VIEWS.map((name) =>
            h(
              'button',
              {
                key: name,
                type: 'button',
                style: name === view ? { ...styles.segment, ...styles.segmentActive } : styles.segment,
                onClick: () => setView(normalizeView(name)),
              },
              t(`view.${name}`),
            ),
          ),
          h('span', { style: styles.spacer }),
          action,
        ),
        view === 'search'
          ? h(
              'div',
              { style: styles.searchBar },
              h('input', {
                style: styles.input,
                value: query,
                placeholder: t('search.placeholder'),
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submitSearch()
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy || exhausted || cooling,
                  style: busy || exhausted || cooling ? { ...styles.action, ...styles.actionDisabled } : styles.action,
                  onClick: submitSearch,
                },
                t('search.submit'),
              ),
            )
          : null,
        body,
      )
    }

    /**
     * 注册字典、tab 类型与正文。
     * @param {object} ctx 客户端上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'zhihu: dictionaries')
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => t('tab.title'),
            guide: [
              {
                id: 'zhihu',
                order: 120,
                title: () => t('guide.title'),
                description: () => t('guide.description'),
              },
            ],
          }),
        'zhihu: type',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                locale: NS,
              },
              ZhihuTabBody,
            ),
          ),
        'zhihu: body',
      )
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote']

    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      TAB_ID,
      TAB_KIND,
      NS,
      ROUTES,
      VIEWS,
      DEFAULT_VIEW,
      LIMITS,
      HOT_REFRESH_INTERVAL_MS,
      AUTH_CONSOLE_URL,
      zh,
      en,
      ERROR_KEYS,
      FAILURE_KIND,
      CONTENT_TYPES,
      IDLE_KEYS,
      normalizeView,
      withQuery,
      hotRequest,
      searchRequest,
      contentsRequest,
      readResult,
      fetchView,
      refreshPlan,
      remainingRetry,
      formatDuration,
      formatClock,
      describeAge,
      hotRows,
      searchRows,
      contentRows,
      totalOf,
      pageSizeOf,
      contentLabel,
      describeFailureUi,
      ZhihuTabBody,
    }
    return module.exports
  },
})
