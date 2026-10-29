
/**
 * 浏览器半边：`shell.overlay` 浮层 + `settings.section` 设置页。
 *
 * 无构建步骤，手写并包在 `window.__ModuleLoader__.load({id, factory})` 里；
 * 与宿主共享的路由常量在本文件复制一份，由 `test/client-protocol.test.mjs` 保证一致。
 *
 * 升级交接期间本页面会被断开（宿主进程正常退出、helper 装完再拉起新进程），
 * 所以这里的 watchdog 只做一件事：轮询 `GET /status`，等新宿主应答后 `location.reload()`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-auto-upgrade',
  factory: (require) => {
    // ModuleLoader 只给 `require`，导出的模块对象要自己造并 return（与生态里其它插件一致）。
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement
    const NS = 'dsh-auto-upgrade'

    const API = {
      status: '/api/dsh-auto-upgrade/status',
      checkAuto: '/api/dsh-auto-upgrade/check/auto',
      checkRun: '/api/dsh-auto-upgrade/check/run',
      preflight: '/api/dsh-auto-upgrade/preflight',
      plugins: '/api/dsh-auto-upgrade/plugins',
      pluginAction: '/api/dsh-auto-upgrade/plugins/action',
      policy: '/api/dsh-auto-upgrade/policy',
      settings: '/api/dsh-auto-upgrade/settings',
      update: '/api/dsh-auto-upgrade/update',
      rollback: '/api/dsh-auto-upgrade/rollback',
      task: '/api/dsh-auto-upgrade/task',
      restart: '/api/dsh-auto-upgrade/restart',
      restartDiagnostics: '/api/dsh-auto-upgrade/restart/diagnostics',
      notes: '/api/dsh-auto-upgrade/notes',
      reportIssue: '/api/dsh-auto-upgrade/report-issue',
    }

    const RESULT_FRESH_MS = 10 * 60 * 1000

    const ZH = {
      'settings.label': '自动升级',
      'overlay.title': 'dsh 更新',
      'overlay.checking': '正在检查…',
      'overlay.upToDate': '已是最新（{version}）',
      'overlay.available': '有新版本 {target}（当前 {installed}）',
      'overlay.pluginCannotUpgrade': '不能升级到 {target}：',
      'overlay.requires': '要求 {requirement}',
      'overlay.requirementExact': '{name} 精确 {range}',
      'overlay.requirementRange': '{name} {range}',
      'overlay.pluginRequirements': '要求明细（{count} 项）',
      'overlay.requirementsMore': '等 {count} 项',
      'overlay.pluginFix': '→ 修法：放宽该插件的 peer 声明后重跑其装配验收（scripts/pipeline/install-check.sh <插件目录>）；或为该版本组合申请版本豁免（dsh plugin --profile web allow-version …）',
      'overlay.reportIssue': '开 issue 记录这个不兼容',
      'overlay.reportIssueCreated': '已记录为 issue',
      'overlay.reportIssueFailed': '开 issue 失败：{error}',
      'overlay.downgrade': '本机版本高于发布源（{installed} > {target}）',
      'overlay.downgradeDetail': '当前渠道 {channel} 最新 {target}，本机 {installed}',
      'overlay.downgradeHint': '把发布渠道改成 {channel} 就能继续升级',
      'overlay.switchChannel': '切到 {channel}',
      'overlay.unknown': '无法确认是否有更新（{error}）',
      'overlay.cached': '今天已检查过',
      'overlay.upgrade': '升级',
      'overlay.dismiss': '不再提示',
      'overlay.close': '关闭',
      'overlay.preflightTitle': '升级落点',
      'overlay.releaseNotes': '更新说明',
      'overlay.noReleaseNotes': '拿不到更新说明（{reason}）',
      'overlay.openOnGithub': '在 GitHub 上查看完整说明',
      'overlay.confirm': '确认升级',
      'overlay.cancel': '取消',
      'overlay.backup': '升级前备份 {path}',
      'overlay.sessionsWarning': '{count} 个会话正在执行，升级会中断它们。仍要继续？',
      'overlay.handingOff': '正在交接给升级助手（{step}）…',
      'overlay.reconnecting': '服务重启中，页面会自动重新连接…',
      'overlay.upgradedTo': '已升级到 {version}',
      'overlay.rolledBackTo': '已回滚到 {version}',
      'overlay.failedAt': '上次升级失败（{step}），服务已按原样恢复',
      'overlay.log': '过程日志',
      'settings.channel': '发布渠道',
      'settings.channelLatest': 'latest（跟随 npm 默认）',
      'settings.channelNext': 'next',
      'settings.channelAlpha': 'alpha',
      'settings.channelExact': '指定精确版本',
      'settings.exactVersion': '精确版本号',
      'settings.dailyCheck': '当天首次使用时自动检测',
      'settings.overlay': '显示浮层',
      'settings.dismissedHint': '浮层已被「不再提示」关闭',
      'settings.reEnable': '重新启用提示',
      'settings.save': '保存',
      'settings.saved': '已保存',
      'settings.checkNow': '立即检查',
      'settings.preflight': '本机体检',
      'settings.plugins': '已装插件兼容性',
      'settings.pluginsFor': '已装插件兼容性（按 {target} 评估）',
      'settings.pluginsForInstalled': '已装插件兼容性（按本机已装版本评估）',
      'settings.pluginOk': '兼容',
      'settings.pluginBad': '不兼容',
      'settings.pluginExempt': '已豁免',
      'settings.pluginUnknown': '信息不足',
      'settings.detail': '不兼容详情',
      'settings.noPlugins': '没有第三方插件',
      'settings.restartLog': '重启/升级日志',
      'settings.result': '上次交接结果',
      'settings.rollback': '回滚到 {version}',
      'settings.restartService': '重启服务',
      'settings.empty': '（暂无）',
      'settings.pendingRestart': '上次交接：{mode} {from} → {to}',
      'settings.updateAvailable': '发现新版本 {target}（当前 {installed}）',
    }

    const EN = {
      'settings.label': 'Auto upgrade',
      'overlay.title': 'dsh update',
      'overlay.checking': 'Checking…',
      'overlay.upToDate': 'Up to date ({version})',
      'overlay.available': 'New version {target} (current {installed})',
      'overlay.pluginCannotUpgrade': 'Cannot upgrade to {target}:',
      'overlay.requires': 'requires {requirement}',
      'overlay.requirementExact': '{name} exactly {range}',
      'overlay.requirementRange': '{name} {range}',
      'overlay.pluginRequirements': 'Unmet requirements ({count})',
      'overlay.requirementsMore': 'and {count} more',
      'overlay.pluginFix': '→ Fix: widen the plugin peer declaration and re-run its assembly check (scripts/pipeline/install-check.sh <plugin dir>); or request a version exemption for this combination (dsh plugin --profile web allow-version …)',
      'overlay.reportIssue': 'Open an issue for this incompatibility',
      'overlay.reportIssueCreated': 'Recorded as issue',
      'overlay.reportIssueFailed': 'Could not open the issue: {error}',
      'overlay.downgrade': 'Installed version is ahead of the release source ({installed} > {target})',
      'overlay.downgradeDetail': 'Channel {channel} latest is {target}; installed {installed}',
      'overlay.downgradeHint': 'Switch the release channel to {channel} to keep upgrading',
      'overlay.switchChannel': 'Switch to {channel}',
      'overlay.unknown': 'Cannot confirm updates ({error})',
      'overlay.cached': 'already checked today',
      'overlay.upgrade': 'Upgrade',
      'overlay.dismiss': 'Do not show again',
      'overlay.close': 'Close',
      'overlay.preflightTitle': 'Upgrade plan',
      'overlay.releaseNotes': 'Release notes',
      'overlay.noReleaseNotes': 'Release notes unavailable ({reason})',
      'overlay.openOnGithub': 'View full notes on GitHub',
      'overlay.confirm': 'Confirm upgrade',
      'overlay.cancel': 'Cancel',
      'overlay.backup': 'Backup before upgrading: {path}',
      'overlay.sessionsWarning': '{count} sessions are running; upgrading interrupts them. Continue anyway?',
      'overlay.handingOff': 'Handing over to the upgrade helper ({step})…',
      'overlay.reconnecting': 'Service is restarting; this page will reconnect automatically…',
      'overlay.upgradedTo': 'Upgraded to {version}',
      'overlay.rolledBackTo': 'Rolled back to {version}',
      'overlay.failedAt': 'The last upgrade failed ({step}); the service was restored as-is',
      'overlay.log': 'Progress log',
      'settings.channel': 'Release channel',
      'settings.channelLatest': 'latest (npm default)',
      'settings.channelNext': 'next',
      'settings.channelAlpha': 'alpha',
      'settings.channelExact': 'Exact version',
      'settings.exactVersion': 'Exact version',
      'settings.dailyCheck': 'Check on the first page load of the day',
      'settings.overlay': 'Show the overlay',
      'settings.dismissedHint': 'The overlay was turned off by "Do not show again"',
      'settings.reEnable': 'Re-enable the overlay',
      'settings.save': 'Save',
      'settings.saved': 'Saved',
      'settings.checkNow': 'Check now',
      'settings.preflight': 'Local preflight',
      'settings.plugins': 'Installed plugin compatibility',
      'settings.pluginsFor': 'Installed plugin compatibility (evaluated against {target})',
      'settings.pluginsForInstalled': 'Installed plugin compatibility (evaluated against the installed version)',
      'settings.pluginOk': 'compatible',
      'settings.pluginBad': 'incompatible',
      'settings.pluginExempt': 'exempted',
      'settings.pluginUnknown': 'unknown',
      'settings.detail': 'Incompatibility details',
      'settings.noPlugins': 'No third-party plugins',
      'settings.restartLog': 'Restart / upgrade log',
      'settings.result': 'Last handoff result',
      'settings.rollback': 'Roll back to {version}',
      'settings.restartService': 'Restart service',
      'settings.empty': '(none)',
      'settings.pendingRestart': 'Last handoff: {mode} {from} → {to}',
      'settings.updateAvailable': 'New version {target} (current {installed})',
    }

    /**
     * 造一个字典翻译函数（没有 locale 服务时的兜底）。
     * @param {Record<string,string>} dict 字典。
     * @returns {(key:string, params?:Record<string,unknown>) => string} 翻译函数。
     */
    const makeT = (dict) => (key, params) => {
      const template = dict[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
    }

    const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

    /**
     * 解析版本号。规则与 `lib/host/semver.js` 一致——浏览器半边没有构建步骤、没法 import 宿主模块，
     * 只能在本地复刻这一小段；`test/client-upgrade-entry.test.mjs` 用宿主那份做逐对比对，防止两处漂移。
     * @param {unknown} value 版本文本。
     * @returns {{major:number,minor:number,patch:number,pre:Array<string|number>}|undefined} 解析结果；非法返回 undefined。
     */
    function parseVersion(value) {
      if (typeof value !== 'string') return undefined
      const m = VERSION_RE.exec(value.trim())
      if (m === null) return undefined
      const pre = m[4] === undefined ? [] : m[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre }
    }

    /**
     * 比较两个版本（semver.org §11，语义与宿主 `compareVersions` 相同）。
     * @param {string} a 左值。
     * @param {string} b 右值。
     * @returns {number} a<b 返回负数，a>b 返回正数，相等或不可比返回 0。
     */
    function compareVersions(a, b) {
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
     * 降级护栏的出路：从检测结果 `tags`（渠道 → 版本）里挑版本号最高的那个渠道。
     * 全相等、缺失或都不可比时返回 undefined——没有「更好的渠道」可以指，就不给误导性的建议。
     * @param {Record<string,string>|null|undefined} tags 渠道表。
     * @returns {string|undefined} 建议渠道名。
     */
    function suggestChannel(tags) {
      if (tags === null || tags === undefined || typeof tags !== 'object') return undefined
      const entries = Object.keys(tags)
        .filter((channel) => parseVersion(tags[channel]) !== undefined)
        .map((channel) => [channel, tags[channel]])
      if (entries.length === 0) return undefined
      let best = entries[0]
      let distinct = false
      for (let i = 1; i < entries.length; i += 1) {
        const delta = compareVersions(entries[i][1], best[1])
        if (delta > 0) {
          best = entries[i]
          distinct = true
        } else if (delta < 0) {
          distinct = true
        }
      }
      return distinct ? best[0] : undefined
    }

    /**
     * 同源 JSON 请求；任何失败都返回 `{ ok:false, error }`，绝不抛给 React。
     * @param {string} url 路径。
     * @param {{method?:string, body?:unknown}} [options] 选项。
     * @returns {Promise<any>} 解析后的结果。
     */
    async function request(url, options = {}) {
      try {
        const response = await fetch(url, {
          method: options.method ?? 'GET',
          cache: 'no-store',
          headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        })
        const payload = await response.json().catch(() => ({}))
        return { ...payload, httpStatus: response.status }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), httpStatus: 0 }
      }
    }

    /**
     * 注入一次插件样式。
     * @returns {void}
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-auto-upgrade"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-auto-upgrade'
      // 全部走 dsh 自己的设计 token（字体/字号/圆角/控件尺寸/语义色）。
      // 设置页对齐官方设置行 /「模块平台」按钮；浮层**逐字照抄**官方账号通知卡
      // （@deepseek-ai/dsh-client-ui-settings-account 的 AccountNotice.module.css，前缀 zwW4-W_ → dsh-au-）：
      // 280px 白卡 + elevation-panel + 16px 圆角 + 20px 内边距 + 14/22 正文 + 右上 18×18 关闭。
      tag.textContent = [
        '.dsh-au-card,.dsh-au-section{font:var(--dsw-font-s-14,14px/22px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif));',
        'color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased;}',
        '.dsh-au-card *,.dsh-au-section *{box-sizing:border-box;}',
        // 浮层：官方 AccountNotice.module.css 原文（zwW4-W_ → dsh-au-）。相对原文只多两处，均为
        // 宿主环境/内容形态所需：卡片根 pointer-events:auto（overlayLayer 是 pointer-events:none，
        // 卡片必须自己吃点击）；.copy 的滚动上限（本插件内容可能比一条通知长）。
        '.dsh-au-stack{z-index:40;isolation:isolate;width:280px;max-width:calc(100vw - 16px);position:fixed;}',
        '.dsh-au-card{box-sizing:border-box;background:var(--dsw-specific-input-major);width:100%;box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-secondary);z-index:calc(0 - var(--notice-depth));transform:translateY(calc(-4px * var(--notice-depth))) scaleX(var(--notice-scale));transform-origin:top;border:0;border-radius:16px;padding:20px;font-size:14px;line-height:22px;transition:transform .25s ease-out;position:relative;pointer-events:auto;}',
        '.dsh-au-card[data-front="false"]{pointer-events:none;height:100%;position:absolute;inset:0;overflow:hidden;}',
        '@media (prefers-reduced-motion:reduce){.dsh-au-card{transition:none;}}',
        '.dsh-au-copy{overflow-wrap:anywhere;flex-direction:column;gap:2px;display:flex;max-height:calc(100vh - 200px);overflow:auto;}',
        '.dsh-au-copy p{white-space:pre-wrap;margin:0;}',
        // 标题行：官方原文，但只作用于浮层卡片内 —— `.dsh-au-title` 也被设置页的分组标题复用，
        // 设置页必须保持原样（`strong-14` 500/22、块级），所以官方那套只加 `.dsh-au-card` 后代限定。
        '.dsh-au-title{font:var(--dsw-font-s-strong-14,500 14px/22px var(--dsw-font-family));color:var(--dsw-alias-label-primary);}',
        '.dsh-au-card .dsh-au-title{align-items:flex-start;gap:2px;font-weight:500;line-height:20px;display:flex;}',
        '.dsh-au-icon{width:14px;height:14px;color:var(--dsw-alias-brand-primary-new-colorprimary-new-color);flex:none;margin-top:1px;display:flex;}',
        '.dsh-au-close{width:18px;height:18px;color:var(--dsw-alias-label-caption);cursor:pointer;background:0 0;border:0;justify-content:center;align-items:center;padding:4px;display:flex;position:absolute;top:6px;right:6px;}',
        '.dsh-au-close:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:4px;}',
        '.dsh-au-rowtitle{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);}',
        '.dsh-au-muted{font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));color:var(--dsw-alias-label-tertiary);}',
        '.dsh-au-caption{font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));color:var(--dsw-alias-label-tertiary);}',
        '.dsh-au-warn{color:var(--dsw-alias-state-warn-label);}',
        '.dsh-au-bad{color:var(--dsw-alias-state-error-primary);}',
        '.dsh-au-ok{color:var(--dsw-alias-state-success-primary);}',
        '.dsh-au-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;}',
        // 门禁拒绝块里的「开 issue」一行：与卡片动作行分开（动作行只放升级/不再提示）。
        '.dsh-au-issue{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;}',
        // 浮层里的动作：官方 Button 的小尺寸 + 描边变体（sm = 28px / radius-sm / 12-18 /
        // border 0.5px border-l3 + hover 填充）；主操作是同一尺寸的 primary 实心。
        '.dsh-au-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;',
        'border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);',
        'font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));cursor:pointer;white-space:nowrap;}',
        '.dsh-au-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
        '.dsh-au-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active);}',
        '.dsh-au-btn:disabled{cursor:not-allowed;opacity:.4;}',
        '.dsh-au-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}',
        '.dsh-au-primary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}',
        '.dsh-au-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
        // 输入控件：文本输入照 primitives/Input.module.css，下拉照官方的「模块平台」灰底按钮
        '.dsh-au-input{height:32px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l4);',
        'border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
        'font:var(--dsw-font-s-14,14px/22px var(--dsw-font-family));}',
        '.dsh-au-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);}',
        '.dsh-au-input::placeholder{color:var(--dsw-alias-label-dimmed);}',
        '.dsh-au-select{appearance:none;height:36px;padding:0 32px 0 14px;border:none;border-radius:var(--dsw-radius-md,12px);',
        'background-color:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14,14px/22px var(--dsw-font-family));',
        'cursor:pointer;background-repeat:no-repeat;background-position:right 12px center;background-size:12px;',
        'background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 12 12%22%3E%3Cpath d=%22M2.5 4.5 6 8l3.5-3.5%22 fill=%22none%22 stroke=%22%238a8f98%22 stroke-width=%221.4%22 stroke-linecap=%22round%22/%3E%3C/svg%3E");}',
        '.dsh-au-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}',
        // 设置页的按钮：照官方「模块平台」灰底按钮（bg-module-platform / 36px / radius-md / 0 14px）
        '.dsh-au-selectbtn{display:inline-flex;align-items:center;justify-content:center;gap:12px;height:36px;padding:0 14px;border:none;',
        'border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);',
        'font:var(--dsw-font-s-14,14px/22px var(--dsw-font-family));cursor:pointer;}',
        '.dsh-au-selectbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
        '.dsh-au-selectbtn:disabled{cursor:not-allowed;opacity:.4;}',
        '.dsh-au-selectbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}',
        // 设置页里的主操作（升级 / 确认升级）：同样是 36px 模块平台尺寸，但走 primary 实心
        '.dsh-au-selectbtn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}',
        '.dsh-au-selectbtn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
        // 设置行：照官方 Pt1bsG_row（space-between / 16px 0 / 0.5px 分隔线）
        '.dsh-au-setting{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:16px 0;',
        'border-bottom:0.5px solid var(--dsw-alias-border-l2);}',
        '.dsh-au-setting:last-child{border-bottom:none;}',
        '.dsh-au-setting-text{min-width:0;}',
        '.dsh-au-setting-desc{font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));color:var(--dsw-alias-label-tertiary);margin-top:2px;}',
        '.dsh-au-setting-control{flex:0 0 auto;display:flex;align-items:center;gap:8px;}',
        // 开关：逐字照 primitives/Switch.module.css（含 aria-checked 驱动状态）
        '.dsh-au-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;',
        'corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;}',
        '.dsh-au-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);}',
        '.dsh-au-switch:disabled{cursor:default;opacity:.5;}',
        '.dsh-au-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;}',
        '.dsh-au-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease;}',
        '.dsh-au-switch[aria-checked="false"] .dsh-au-thumb{background:var(--dsw-alias-switch-thumb);}',
        '.dsh-au-switch[aria-checked="true"] .dsh-au-thumb{transform:translateX(16px);}',
        // 分组卡片：用设置页自己的卡片 token
        '.dsh-au-panel{margin-top:12px;padding:12px 14px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));',
        'border:0.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-lg,16px);}',
        '.dsh-au-list{margin:6px 0 0;padding-left:18px;}',
        '.dsh-au-list li{margin:2px 0;}',
        '.dsh-au-details>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13,13px/20px var(--dsw-font-family));}',
        '.dsh-au-details>summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);outline-offset:1px;}',
        '.dsh-au-detail-body{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));word-break:break-word;margin:4px 0 0;}',
        '.dsh-au-notes{max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:4px 0 0;',
        'color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));}',
        '.dsh-au-notes-link{display:inline-block;margin-top:6px;color:var(--dsw-alias-state-business-primary);',
        'font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));text-decoration:none;}',
        '.dsh-au-notes-link:hover{text-decoration:underline;}',
        '.dsh-au-pre{max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word;',
        'font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;',
        'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-sm,8px);',
        'padding:8px 10px;margin-top:6px;}',
        '.dsh-au-section{display:flex;flex-direction:column;}',
      ].join('')
      document.head.appendChild(tag)
    }

    /**
     * 升级交接后的重连 watchdog：轮询 /status，等新宿主应答就重载页面。
     * @param {{current:any}} ref 保存定时器的 ref。
     * @param {string|null} expected 期望的新版本（restart 时为 null）。
     * @param {(text:string)=>void} onState 状态回调。
     * @returns {void}
     */
    function startWatchdog(ref, expected, onState) {
      if (ref.current !== null) return
      let sawDown = false
      const tick = async () => {
        const snapshot = await request(API.status)
        if (snapshot.ok !== true) {
          sawDown = true
          onState('reconnecting')
          return
        }
        if (sawDown || (expected !== null && snapshot.dsh?.installed === expected)) {
          if (ref.current !== null) {
            clearInterval(ref.current)
            ref.current = null
          }
          if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
            onState('upgraded')
            window.location.reload()
          }
        }
      }
      ref.current = setInterval(tick, 2000)
      void tick()
    }

    /**
     * 交接后跟着任务日志走，直到宿主把手交出去（请求失败即视为交接窗口开始）。
     * 浮层与设置页共用同一份实现，只注入各自的 state setter。
     * @param {(updater:any)=>void} setHandoff 交接状态 setter。
     * @returns {(taskId:string)=>void} 跟随函数。
     */
    function makeTaskFollower(setHandoff) {
      return (taskId) => {
        let cursor = 0
        const step = async () => {
          const result = await request(`${API.task}?taskId=${taskId}&since=${cursor}`)
          if (result.ok !== true) return
          cursor = result.task?.cursor ?? cursor
          setHandoff((previous) => ({
            step: result.task?.phase ?? 'unknown',
            log: [...(previous?.log ?? []), ...(result.task?.log ?? [])].slice(-12),
          }))
          if (result.task?.finishedAt === null) setTimeout(step, 700)
        }
        void step()
      }
    }

    /**
     * 升级流程控制器：预检 → 更新说明 → 提交 → 两条门禁 → 交接 watchdog。
     * 浮层与设置页各自造一个，但跑的是**同一份代码**（只注入各自的 state），避免两处漂移。
     * @param {object} io 界面接口：`t` / `watchRef` / `getTarget` 与各自的 state setter。
     * @returns {{openPlan:(target:string|null)=>Promise<void>, submit:(force:boolean)=>Promise<void>, switchChannel:(channel:string)=>Promise<void>}} 控制器。
     */
    function createUpgradeFlow(io) {
      const followTask = makeTaskFollower(io.setHandoff)

      /**
       * 打开升级确认卡：先看落点，再交给用户点头。
       * @param {string|null} target 目标版本。
       * @returns {Promise<void>} 完成后刷新界面。
       */
      const openPlan = async (target) => {
        const result = await request(API.preflight)
        if (result.ok !== true) {
          io.setNotice(result.error ?? 'preflight failed')
          return
        }
        io.setPlan({ facts: result.preflight, target, notes: undefined })
        if (target === null || target === undefined) return
        // 更新说明是「锦上添花」：拿不到就如实显示拿不到，绝不影响能不能升级
        const notes = await request(`${API.notes}?version=${encodeURIComponent(target)}`)
        io.setPlan((previous) => (previous === null ? previous : { ...previous, notes }))
      }

      /**
       * 提交升级；会话门禁是「警告可强制」，插件不兼容则拒绝且不可绕过。
       * @param {boolean} force 是否已在会话警告上确认。
       * @returns {Promise<void>} 完成后刷新界面。
       */
      const submit = async (force) => {
        io.setBusy(true)
        const result = await request(API.update, {
          method: 'POST',
          body: { version: io.getTarget(), force: force === true },
        })
        io.setBusy(false)
        if (result.ok === true) {
          io.setNotice(null)
          io.setPlan(null)
          io.setBlocked(null)
          if (typeof io.setLastResult === 'function') io.setLastResult(null)
          io.setHandoff({ step: 'preflight', log: [] })
          if (typeof result.taskId === 'string') followTask(result.taskId)
          startWatchdog(io.watchRef, io.getTarget() ?? null, (state) => io.setHandoff((previous) => ({ ...(previous ?? { log: [] }), step: state })))
          return
        }
        if (result.code === 'E_SESSIONS_RUNNING' && result.detail?.bypassable === true && force !== true) {
          const count = result.detail?.sessions?.length ?? 0
          if (window.confirm(io.t('overlay.sessionsWarning', { count }))) {
            await submit(true)
          }
          return
        }
        if (result.code === 'E_PLUGIN_INCOMPATIBLE') {
          // 门禁拒绝时不再只说“有几个”：把宿主回报的插件与未满足要求原样交给共用渲染点名。
          io.setBlocked({ target: io.getTarget(), plugins: result.detail?.plugins ?? [] })
          return
        }
        io.setNotice(result.error ?? 'update failed')
      }

      /**
       * 换渠道并立刻重跑检测——降级护栏的出路。这是用户显式点击，允许改自己的策略。
       * @param {string} channel 渠道名。
       * @returns {Promise<void>} 完成。
       */
      const switchChannel = async (channel) => {
        io.setBusy(true)
        const saved = await request(API.policy, { method: 'POST', body: { channel } })
        if (saved.ok !== true) {
          io.setBusy(false)
          io.setNotice(saved.error ?? 'policy failed')
          return
        }
        const checked = await request(API.checkRun, { method: 'POST', body: { force: true } })
        io.setBusy(false)
        if (checked.ok === true) {
          if (typeof io.onChecked === 'function') io.onChecked(checked)
        } else {
          io.setNotice(checked.error ?? 'check failed')
        }
      }

      return { openPlan, submit, switchChannel }
    }

    /**
     * 升级计划卡：版本对比 / npm 路径 / 备份路径 + 更新说明 + 确认/取消。
     * 浮层与设置页共用同一份渲染（按钮各自传自己的类名，尺寸才跟各自界面一致）。
     * @param {{t:Function, plan:any, busy:boolean, confirmClass:string, cancelClass:string, onConfirm:Function, onCancel:Function}} props 输入。
     * @returns {any} React 元素。
     */
    function renderPlanPanel({ t, plan, busy, confirmClass, cancelClass, onConfirm, onCancel }) {
      const facts = plan.facts ?? {}
      return h('div', { key: 'plan', className: 'dsh-au-panel' }, [
        h('div', { key: 'l', className: 'dsh-au-title' }, t('overlay.preflightTitle')),
        h('ul', { key: 'ul', className: 'dsh-au-list' }, [
          h('li', { key: 'v' }, `${facts.dsh?.version ?? '?'} → ${plan.target ?? '?'}`),
          h('li', { key: 'n' }, `npm: ${facts.npm?.command ?? '?'}${facts.npm?.matchesInstall === false ? ' ⚠' : ''}`),
          h('li', { key: 'b' }, t('overlay.backup', { path: facts.paths?.backupBase ?? '?' })),
        ]),
        plan.notes === undefined || plan.notes === null
          ? null
          : plan.notes.available === true
            ? h('details', { key: 'notes', className: 'dsh-au-details' }, [
              h('summary', { key: 's' }, `${t('overlay.releaseNotes')}${plan.notes.tag === undefined ? '' : ` · ${plan.notes.tag}`}`),
              (plan.notes.plain ?? plan.notes.notes ?? '') === ''
                ? h('div', { key: 'b', className: 'dsh-au-notes' }, t('overlay.noReleaseNotes', { reason: 'empty body' }))
                : h('div', { key: 'b', className: 'dsh-au-notes' }, plan.notes.plain ?? plan.notes.notes),
              plan.notes.url === undefined
                ? null
                : h('a', {
                  key: 'u',
                  className: 'dsh-au-notes-link',
                  href: plan.notes.url,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                }, t('overlay.openOnGithub')),
            ])
            : h('div', { key: 'notes', className: 'dsh-au-caption' }, t('overlay.noReleaseNotes', { reason: plan.notes.reason ?? plan.notes.error ?? '?' })),
        h('div', { key: 'actions', className: 'dsh-au-row' }, [
          h('button', { key: 'go', className: confirmClass, disabled: busy, onClick: onConfirm }, t('overlay.confirm')),
          h('button', { key: 'no', className: cancelClass, onClick: onCancel }, t('overlay.cancel')),
        ]),
      ])
    }

    /**
     * 官方账号通知卡的铃铛图标（14×14，两条 path 从 AccountNotice 的 JSX 逐字取出）。
     * @param {number} size 边长（px）。
     * @returns {any} SVG 元素。
     */
    function noticeIcon(size) {
      return h('svg', { width: size, height: size, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' }, [
        h('path', {
          key: 'body',
          d: 'M3.6355 6.93969C3.6355 4.8398 5.33779 3.1375 7.43768 3.1375C9.53757 3.1375 11.23987 4.8398 11.23987 6.93968V11.363H3.6355V6.93969Z',
          fill: 'currentColor',
          fillOpacity: '0.2',
          stroke: 'currentColor',
          strokeWidth: '0.875',
        }),
        h('path', {
          key: 'base',
          d: 'M1.641 11.3645H12.36M5.053 13.3095H8.9479M7.4375 4.27422V2.70137912',
          stroke: 'currentColor',
          strokeWidth: '0.875',
        }),
      ])
    }

    /**
     * 降级护栏的出路：本机版本 / 当前渠道最新版，以及「把渠道改成 <建议渠道>」与按钮。
     * 浮层与设置页共用同一份渲染。
     * @param {{t:Function, check:any, channel:any, suggested:string|undefined, busy:boolean, buttonClass:string, onSwitch:Function}} props 输入。
     * @returns {any[]} 节点数组（详情行 + 可选的提示行与动作行）。
     */
    function renderDowngradeExit({ t, check, channel, suggested, busy, buttonClass, onSwitch }) {
      const nodes = [
        h('div', { key: 'downgrade-detail', className: 'dsh-au-muted' }, t('overlay.downgradeDetail', {
          channel: channel ?? '?',
          target: check?.target ?? '?',
          installed: check?.installed ?? '?',
        })),
      ]
      if (suggested !== undefined) {
        nodes.push(h('div', { key: 'downgrade-hint', className: 'dsh-au-line' }, t('overlay.downgradeHint', { channel: suggested })))
        nodes.push(h('div', { key: 'downgrade-switch', className: 'dsh-au-row' }, [
          h('button', {
            key: 'sw',
            className: buttonClass,
            disabled: busy,
            onClick: () => onSwitch(suggested),
          }, t('overlay.switchChannel', { channel: suggested })),
        ]))
      }
      return nodes
    }

    /**
     * 把一条「未满足的 peer」格式化成 `名字 精确 版本`（范围不是精确版本时原样给出）。
     * 取值全部来自官方 `evaluatePluginCompatibility` 的 `requirements`，这里只做显示，不自己算范围。
     * @param {Function} t 翻译函数。
     * @param {[string, string]} entry 名字与声明范围。
     * @returns {string} 显示文本。
     */
    function formatRequirement(t, entry) {
      const [name, range] = entry
      const exact = typeof range === 'string' && parseVersion(range) !== undefined
      return exact
        ? t('overlay.requirementExact', { name, range })
        : t('overlay.requirementRange', { name, range })
    }

    /**
     * 门禁拒绝的共用渲染：点名不兼容插件 + 要求明细（最多 3 条，其余折叠）+ 修法 + 开 issue。
     * 浮层与设置页共用这一份；各写一份必然漂移（`test/client-upgrade-entry.test.mjs` 有计数守卫）。
     * @param {{t:Function, target:string|null, plugins:object[], busy:boolean, buttonClass:string, report:any, onReport:Function}} props 输入。
     * @returns {any} React 元素。
     */
    function renderPluginBlock({ t, target, plugins, busy, buttonClass, report, onReport }) {
      const list = Array.isArray(plugins) ? plugins : []
      const rows = []
      for (const plugin of list) {
        const requirements = Object.entries(plugin.peers ?? {})
        const shown = requirements.slice(0, 3)
        const rest = requirements.length - shown.length
        const first = shown.length === 0 ? '' : formatRequirement(t, shown[0])
        rows.push(h('div', { key: `plugin-${plugin.name}`, className: 'dsh-au-warn' }, [
          h('div', { key: 'name' }, `${plugin.name}@${plugin.version}${first === '' ? '' : ` ${t('overlay.requires', { requirement: first })}`}`),
          requirements.length === 0
            ? null
            : h('details', { key: 'detail', className: 'dsh-au-details' }, [
              h('summary', { key: 'summary' }, t('overlay.pluginRequirements', { count: requirements.length })),
              h('div', { key: 'body', className: 'dsh-au-detail-body' }, [
                ...shown.map((entry, index) => h('div', { key: `r${index}` }, formatRequirement(t, entry))),
                rest === 0 ? null : h('div', { key: 'more' }, t('overlay.requirementsMore', { count: rest })),
              ]),
            ]),
        ]))
      }

      let issue
      if (report !== null && report !== undefined && report.ok === true) {
        // 成功后保持可见：`#N` 本身就是链接。
        issue = h('div', { key: 'issue', className: 'dsh-au-issue' }, [
          h('span', { key: 'text', className: 'dsh-au-muted' }, t('overlay.reportIssueCreated')),
          h('a', {
            key: 'link',
            className: 'dsh-au-notes-link',
            href: report.url,
            target: '_blank',
            rel: 'noreferrer noopener',
          }, `#${report.number}`),
        ])
      } else if (report !== null && report !== undefined && typeof report.error === 'string') {
        issue = h('div', { key: 'issue', className: 'dsh-au-warn' }, t('overlay.reportIssueFailed', { error: report.error }))
      } else {
        const pending = report !== null && report !== undefined && report.pending === true
        issue = h('div', { key: 'issue', className: 'dsh-au-issue' }, [
          h('button', {
            key: 'button',
            className: buttonClass,
            disabled: busy || pending,
            onClick: () => onReport(target),
          }, t('overlay.reportIssue')),
        ])
      }

      return h('div', { key: 'plugins', className: 'dsh-au-panel' }, [
        h('div', { key: 'head', className: 'dsh-au-warn' }, t('overlay.pluginCannotUpgrade', { target: target ?? '?' })),
        ...rows,
        h('div', { key: 'fix', className: 'dsh-au-muted' }, t('overlay.pluginFix')),
        issue,
      ])
    }

    /**
     * 造一个「开 issue」提交器，浮层与设置页共用同一份实现。
     * @param {(state:any)=>void} setReport 结果 setter。
     * @returns {(target:string|null)=>Promise<void>} 提交函数。
     */
    function makeIssueReporter(setReport) {
      return async (target) => {
        if (target === null || target === undefined) return
        setReport({ pending: true })
        const result = await request(API.reportIssue, { method: 'POST', body: { target } })
        if (result.ok === true) {
          setReport({ ok: true, number: result.number, url: result.url, created: result.created })
        } else {
          setReport({ error: result.error ?? 'report failed' })
        }
      }
    }

    /**
     * 关闭图标：官方用的是 `@deepseek-ai/dsh-client-ui-primitives` 的 `IconCloseOutlineRegular`（size 10），
     * 该包在 dsh 0.2.1 的安装树里已不存在（实现被内联进各 bundle），所以按同尺寸内联一个等价的 10×10 ×。
     * @param {number} size 边长（px）。
     * @returns {any} SVG 元素。
     */
    function closeIcon(size) {
      return h('svg', { width: size, height: size, viewBox: '0 0 10 10', fill: 'none' }, [
        h('path', {
          key: 'cross',
          d: 'M1.75 1.75 8.25 8.25M8.25 1.75 1.75 8.25',
          stroke: 'currentColor',
          strokeWidth: '1.25',
          strokeLinecap: 'round',
        }),
      ])
    }

    /**
     * 浮层：检测结果 + 升级入口，不打断当前工作。
     * @param {{t?:Function}} props 框架注入的属性。
     * @returns {any} React 元素。
     */
    function AutoUpgradeOverlay(props) {
      ensureStyles()
      const t = typeof props.t === 'function' ? props.t : makeT(ZH)
      const [status, setStatus] = react.useState(null)
      const [check, setCheck] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [notice, setNotice] = react.useState(null)
      const [plan, setPlan] = react.useState(null)
      const [hidden, setHidden] = react.useState(false)
      const [handoff, setHandoff] = react.useState(null)
      const [lastResult, setLastResult] = react.useState(null)
      const [blocked, setBlocked] = react.useState(null)
      const [report, setReport] = react.useState(null)
      const watchRef = react.useRef(null)
      const [position, setPosition] = react.useState(null)

      // 位置逐条对齐官方 AccountNoticeStack：锚点是侧栏底部账号按钮的左边/上边，
      // left = max(8, min(anchor.left, innerWidth - 288))，bottom = max(8, innerHeight - anchor.top + 4)；
      // 量到之前整栈 visibility:hidden；锚点按「语义选择器 → 中文 aria-label → 左下角兜底」回退。
      react.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        let element = null
        let observer = null
        let timer = null
        let attempts = 0
        const update = () => {
          if (element === null) return
          const rect = element.getBoundingClientRect()
          setPosition({
            left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 288))}px`,
            bottom: `${Math.max(8, window.innerHeight - rect.top + 4)}px`,
          })
        }
        const find = () => {
          const node = document.querySelector('button[aria-haspopup="menu"][data-signed-out]')
            ?? document.querySelector('button[aria-label="账号菜单"]')
          if (node !== null) {
            element = node
            update()
            if (typeof ResizeObserver === 'function') {
              observer = new ResizeObserver(update)
              observer.observe(node)
            }
            window.addEventListener('resize', update)
            window.addEventListener('scroll', update, true)
            return
          }
          attempts += 1
          if (attempts < 60) timer = window.setTimeout(find, 250)
          else setPosition({ left: '8px', bottom: '16px' })
        }
        find()
        return () => {
          if (timer !== null) window.clearTimeout(timer)
          if (observer !== null) observer.disconnect()
          window.removeEventListener('resize', update)
          window.removeEventListener('scroll', update, true)
        }
      }, [])

      const loadStatus = react.useCallback(async () => {
        const result = await request(API.status)
        if (result.ok === true) setStatus(result)
        return result
      }, [])

      const runCheck = react.useCallback(async (force) => {
        setBusy(true)
        setNotice(null)
        const result = await request(API.checkAuto, { method: 'POST', body: { force: force === true } })
        setBusy(false)
        if (result.ok === true) {
          setCheck(result)
          setHidden(false)
        } else {
          setNotice(result.error ?? 'check failed')
        }
        return result
      }, [])

      react.useEffect(() => {
        let cancelled = false
        ;(async () => {
          const snapshot = await loadStatus()
          if (cancelled || snapshot?.ok !== true) return
          if (snapshot.settings?.dismissed === true || snapshot.settings?.overlay === false) setHidden(true)
          const today = new Date().toISOString().slice(0, 10)
          const lastCheck = snapshot.lastCheck
          const checkedToday = lastCheck?.date === today || lastCheck?.checkedAt?.slice(0, 10) === today
          // 当天已经检测过：直接把上次结论铺上（标注 cached），否则浮层会永远停在「正在检查…」
          if (lastCheck != null) setCheck({ ...lastCheck, cached: true })
          if (snapshot.policy?.dailyCheck !== false && !checkedToday) await runCheck(false)
          const diagnostics = await request(API.restartDiagnostics)
          if (cancelled || diagnostics.ok !== true || diagnostics.result == null) return
          const finished = Date.parse(diagnostics.result.finishedAt ?? '')
          if (Number.isFinite(finished) && Date.now() - finished < RESULT_FRESH_MS) {
            setLastResult(diagnostics.result)
            if (snapshot.pendingRestart !== null && snapshot.pendingRestart !== undefined) setHidden(false)
          }
        })()
        return () => {
          cancelled = true
          if (watchRef.current !== null) {
            clearInterval(watchRef.current)
            watchRef.current = null
          }
        }
      }, [loadStatus, runCheck])

      // 升级流程（预检 → 计划 → 提交 → 门禁 → 交接）与设置页共用同一份实现。
      const flow = createUpgradeFlow({
        t,
        watchRef,
        getTarget: () => plan?.target ?? null,
        setBusy,
        setNotice,
        setPlan,
        setBlocked,
        setHandoff,
        setLastResult,
        onChecked: (result) => { setCheck(result); setHidden(false) },
      })
      const reportIssue = makeIssueReporter(setReport)

      const dismissForever = async () => {
        setHidden(true)
        await request(API.settings, { method: 'POST', body: { dismissed: true } })
      }

      if (hidden) return null

      const decision = check?.decision
      const installed = check?.installed ?? status?.dsh?.installed ?? '?'
      const target = check?.target ?? null
      let line
      if (handoff !== null) line = ''
      else if (check === null) line = t('overlay.checking')
      else if (decision === 'up-to-date') line = t('overlay.upToDate', { version: installed })
      else if (decision === 'update-available') line = t('overlay.available', { target, installed })
      // 有风险时不再用「N 个插件不兼容」这种没有名字的文案：正文交给 renderPluginBlock 点名。
      else if (decision === 'update-with-plugin-risk') line = ''
      else if (decision === 'downgrade-guard') line = t('overlay.downgrade', { installed, target: target ?? '?' })
      else line = t('overlay.unknown', { error: check?.registryError ?? 'unknown' })

      // 被门禁挡住时点名插件：优先用宿主 409 回传的那份，其次用本次检测结果。
      const blockers = blocked !== null && Array.isArray(blocked.plugins) && blocked.plugins.length > 0
        ? blocked.plugins
        : (decision === 'update-with-plugin-risk' ? (check?.incompatible ?? []) : [])
      const blockTarget = blocked?.target ?? target

      const actions = []
      const copy = [h('div', { key: 'title', className: 'dsh-au-title' }, [
        h('span', { key: 'icon', className: 'dsh-au-icon', 'aria-hidden': 'true' }, noticeIcon(14)),
        h('span', { key: 'text' }, t('overlay.title')),
      ])]
      if (line !== '') {
        copy.push(h('p', { key: 'line', className: decision === 'update-with-plugin-risk' ? 'dsh-au-warn' : undefined }, line))
      }
      if (check?.cached === true) copy.push(h('p', { key: 'cached', className: 'dsh-au-muted' }, t('overlay.cached')))
      if (notice !== null) copy.push(h('p', { key: 'notice', className: 'dsh-au-warn' }, notice))

      // 降级护栏只说现象会让人无路可走：点出跨线的渠道，并给一个「切过去」的出口。
      if (decision === 'downgrade-guard') {
        copy.push(...renderDowngradeExit({
          t,
          check,
          channel: check?.channel,
          suggested: suggestChannel(check?.tags),
          busy,
          buttonClass: 'dsh-au-btn dsh-au-primary',
          onSwitch: (channel) => flow.switchChannel(channel),
        }))
      }

      // 门禁拒绝时点名是哪个插件、卡在哪条要求，并给出一条可执行的修法 + 一键开 issue。
      if (blockers.length > 0) {
        copy.push(renderPluginBlock({
          t,
          target: blockTarget,
          plugins: blockers,
          busy,
          buttonClass: 'dsh-au-btn',
          report,
          onReport: reportIssue,
        }))
      }

      if (lastResult !== null && handoff === null) {
        copy.push(h('p', {
          key: 'result',
          className: lastResult.ok === true ? 'dsh-au-ok' : 'dsh-au-warn',
        }, lastResult.ok === true
          ? (lastResult.mode === 'rollback'
            ? t('overlay.rolledBackTo', { version: lastResult.to ?? '?' })
            : t('overlay.upgradedTo', { version: lastResult.to ?? '?' }))
          : t('overlay.failedAt', { step: lastResult.failedStep ?? '?' })))
      }

      if (handoff !== null) {
        const stepText = handoff.step === 'reconnecting'
          ? t('overlay.reconnecting')
          : t('overlay.handingOff', { step: handoff.step ?? '…' })
        copy.push(h('p', { key: 'handoff', className: 'dsh-au-warn' }, stepText))
        if ((handoff.log ?? []).length > 0) {
          copy.push(h('pre', { key: 'log', className: 'dsh-au-pre' }, handoff.log.join('\n')))
        }
      } else if (plan !== null) {
        copy.push(renderPlanPanel({
          t,
          plan,
          busy,
          confirmClass: 'dsh-au-btn dsh-au-primary',
          cancelClass: 'dsh-au-btn',
          onConfirm: () => flow.submit(false),
          onCancel: () => setPlan(null),
        }))
      } else {
        if (decision === 'update-available' || decision === 'update-with-plugin-risk') {
          actions.push(h('button', {
            key: 'up',
            className: 'dsh-au-btn dsh-au-primary',
            disabled: busy || decision === 'update-with-plugin-risk',
            onClick: () => flow.openPlan(target),
          }, t('overlay.upgrade')))
        }
        actions.push(h('button', { key: 'di', className: 'dsh-au-btn', onClick: dismissForever }, t('overlay.dismiss')))
      }

      return h('div', {
        className: 'dsh-au-stack',
        style: position === null ? { visibility: 'hidden' } : position,
      }, [
        h('aside', {
          key: 'card',
          className: 'dsh-au-card',
          'data-front': 'true',
          'data-shell-overlay': 'dsh-auto-upgrade',
          style: { '--notice-depth': 0, '--notice-scale': 1 },
        }, [
          h('div', { key: 'copy', role: 'status', className: 'dsh-au-copy' }, copy),
          actions.length === 0 ? null : h('div', { key: 'actions', className: 'dsh-au-row' }, actions),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dsh-au-close',
            'aria-label': t('overlay.close'),
            onClick: () => setHidden(true),
          }, closeIcon(10)),
        ]),
      ])
    }

    /**
     * 设置页：渠道、当日检测、体检详情、插件兼容表、交接结果、回滚与重启。
     * @param {{t?:Function}} props 框架注入的属性。
     * @returns {any} React 元素。
     */
    function AutoUpgradeSettings(props) {
      ensureStyles()
      const t = typeof props.t === 'function' ? props.t : makeT(ZH)
      const [state, setState] = react.useState(null)
      const [preflightFacts, setPreflightFacts] = react.useState(null)
      const [plugins, setPlugins] = react.useState([])
      const [pluginsTarget, setPluginsTarget] = react.useState(null)
      const [diagnostics, setDiagnostics] = react.useState({ log: [], result: null, payload: null })
      const [saved, setSaved] = react.useState(false)
      const [busy, setBusy] = react.useState(false)
      const [notice, setNotice] = react.useState(null)
      const [plan, setPlan] = react.useState(null)
      const [blocked, setBlocked] = react.useState(null)
      const [report, setReport] = react.useState(null)
      const [progress, setProgress] = react.useState(null)
      const watchRef = react.useRef(null)

      const refresh = react.useCallback(async () => {
        const snapshot = await request(API.status)
        if (snapshot.ok === true) setState(snapshot)
        // 插件表必须按**判定目标版本**取数：宿主默认用已装版本，会和这次的升级结论自相矛盾。
        const judged = snapshot.ok === true ? (snapshot.lastCheck?.target ?? null) : null
        setPluginsTarget(judged)
        const inventory = await request(judged === null ? API.plugins : `${API.plugins}?version=${encodeURIComponent(judged)}`)
        if (inventory.ok === true) setPlugins(inventory.plugins ?? [])
        const result = await request(API.restartDiagnostics)
        if (result.ok === true) {
          setDiagnostics({ log: result.log ?? [], result: result.result ?? null, payload: result.payload ?? null })
        }
      }, [])

      react.useEffect(() => {
        refresh()
        return () => {
          if (watchRef.current !== null) {
            clearInterval(watchRef.current)
            watchRef.current = null
          }
        }
      }, [refresh])

      const policy = state?.policy ?? { channel: 'latest', exactVersion: '', dailyCheck: true }
      const settings = state?.settings ?? { overlay: true, dismissed: false }
      const capabilities = state?.capabilities ?? {}

      // 检测结论直接用上次那一次（设置页不重复打 registry）；点「立即检查」会刷新它。
      const check = state?.lastCheck ?? null
      const decision = check?.decision
      const target = check?.target ?? null
      const installed = check?.installed ?? state?.dsh?.installed ?? '?'
      const hasUpdate = decision === 'update-available' || decision === 'update-with-plugin-risk'
      // 设置页与浮层同样点名：优先用宿主 409 回传的插件，其次用本次检测结果。
      const blockers = blocked !== null && Array.isArray(blocked.plugins) && blocked.plugins.length > 0
        ? blocked.plugins
        : (decision === 'update-with-plugin-risk' ? (check?.incompatible ?? []) : [])
      const blockTarget = blocked?.target ?? target

      // 升级流程与浮层共用同一份实现；浮层是否被 dismissed / hidden 都不影响这里。
      const flow = createUpgradeFlow({
        t,
        watchRef,
        getTarget: () => plan?.target ?? null,
        setBusy,
        setNotice,
        setPlan,
        setBlocked,
        setHandoff: setProgress,
        onChecked: () => { void refresh() },
      })
      const reportIssue = makeIssueReporter(setReport)

      const savePolicy = async (patch) => {
        setBusy(true)
        const result = await request(API.policy, { method: 'POST', body: patch })
        setBusy(false)
        if (result.ok === true) {
          setSaved(true)
          setTimeout(() => setSaved(false), 1500)
          await refresh()
        } else {
          setNotice(result.error ?? 'save failed')
        }
      }
      const saveSettings = async (patch) => {
        setBusy(true)
        await request(API.settings, { method: 'POST', body: patch })
        setBusy(false)
        await refresh()
      }
      const runPreflight = async () => {
        setBusy(true)
        const result = await request(API.preflight)
        setBusy(false)
        if (result.ok === true) setPreflightFacts(result.preflight)
      }
      const checkNow = async () => {
        setBusy(true)
        await request(API.checkRun, { method: 'POST', body: { force: true } })
        setBusy(false)
        await refresh()
      }

      /**
       * 触发一次交接（回滚 / 只重启），随后进入重连 watchdog。
       * @param {string} url 端点。
       * @param {object} body 请求体。
       * @param {string|null} expected 期望版本。
       * @returns {Promise<void>} 完成。
       */
      const handoff = async (url, body, expected) => {
        setBusy(true)
        const result = await request(url, { method: 'POST', body })
        setBusy(false)
        if (result.ok !== true) {
          setNotice(result.error ?? 'handoff failed')
          return
        }
        setNotice(t('overlay.reconnecting'))
        startWatchdog(watchRef, expected, (phase) => {
          if (phase === 'reconnecting') setNotice(t('overlay.reconnecting'))
        })
      }

      /**
       * 一行设置：左标题（+可选描述）/ 右控件，行间 0.5px 分隔线（照官方设置行）。
       * @param {string} key React key。
       * @param {any} title 标题节点。
       * @param {any} control 右侧控件；null 表示纯文本行。
       * @param {any} [description] 标题下的描述（12/18 tertiary）。
       * @returns {any} 行元素。
       */
      const settingRow = (key, title, control, description) => h('div', { key, className: 'dsh-au-setting' }, [
        h('div', { key: 'text', className: 'dsh-au-setting-text' }, [
          h('div', { key: 't' }, title),
          description === undefined ? null : h('div', { key: 'd', className: 'dsh-au-setting-desc' }, description),
        ]),
        control === null ? null : h('div', { key: 'c', className: 'dsh-au-setting-control' }, control),
      ])

      /**
       * 官方样式的开关（36x20 胶囊，aria-checked 驱动）。
       * @param {string} key React key。
       * @param {boolean} checked 状态。
       * @param {() => void} onToggle 切换回调。
       * @returns {any} 开关元素。
       */
      const toggle = (key, checked, onToggle) => h('button', {
        key,
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        className: 'dsh-au-switch',
        disabled: busy,
        onClick: onToggle,
      }, h('span', { key: 't', className: 'dsh-au-thumb' }))

      const pluginRows = plugins.map((plugin) => settingRow(
        plugin.name,
        `${plugin.name}@${plugin.version}`,
        h('span', {
          key: 's',
          className: plugin.compatible === false
            ? (plugin.exempted === true ? 'dsh-au-warn' : 'dsh-au-bad')
            : (plugin.known === false ? 'dsh-au-muted' : 'dsh-au-ok'),
        }, plugin.compatible === false
          ? (plugin.exempted === true ? t('settings.pluginExempt') : t('settings.pluginBad'))
          : (plugin.known === false ? t('settings.pluginUnknown') : t('settings.pluginOk'))),
        plugin.detail === undefined ? undefined : h('details', { key: 'd', className: 'dsh-au-details' }, [
          h('summary', { key: 's' }, t('settings.detail')),
          h('div', { key: 'b', className: 'dsh-au-detail-body' }, plugin.detail),
        ]),
      ))

      const pending = state?.pendingRestart ?? null
      const resultLine = diagnostics.result === null
        ? t('settings.empty')
        : (diagnostics.result.ok === true
          ? `${t('overlay.upgradedTo', { version: diagnostics.result.to ?? '?' })} (${diagnostics.result.mode})`
          : `${t('overlay.failedAt', { step: diagnostics.result.failedStep ?? '?' })}`)

      return h('div', { 'data-dsh-auto-upgrade': 'settings', className: 'dsh-au-section' }, [
        notice === null ? null : h('div', { key: 'notice', className: 'dsh-au-warn' }, notice),
        progress === null ? null : h('div', { key: 'progress', className: 'dsh-au-panel' }, [
          h('div', { key: 'l', className: 'dsh-au-warn' }, progress.step === 'reconnecting'
            ? t('overlay.reconnecting')
            : t('overlay.handingOff', { step: progress.step ?? '…' })),
          (progress.log ?? []).length === 0 ? null : h('div', { key: 'pre', className: 'dsh-au-pre' }, progress.log.join('\n')),
        ]),
        // 升级入口在设置页常驻（浮层被 dismissed / hidden 都不影响这里）；计划卡与浮层同一份渲染。
        hasUpdate ? h('div', { key: 'update', className: 'dsh-au-panel' }, [
          settingRow(
            'available',
            t('settings.updateAvailable', { target: target ?? '?', installed }),
            h('button', {
              key: 'up',
              className: 'dsh-au-selectbtn dsh-au-selectbtn-primary',
              disabled: busy || decision === 'update-with-plugin-risk',
              onClick: () => flow.openPlan(target),
            }, t('overlay.upgrade')),
          ),
        ]) : null,
        blockers.length > 0 ? renderPluginBlock({
          t,
          target: blockTarget,
          plugins: blockers,
          busy,
          buttonClass: 'dsh-au-selectbtn',
          report,
          onReport: reportIssue,
        }) : null,
        plan !== null ? renderPlanPanel({
          t,
          plan,
          busy,
          confirmClass: 'dsh-au-selectbtn dsh-au-selectbtn-primary',
          cancelClass: 'dsh-au-selectbtn',
          onConfirm: () => flow.submit(false),
          onCancel: () => setPlan(null),
        }) : null,
        // 降级护栏的出路：本机 / 渠道最新版 + 「切到 <建议渠道>」。
        decision === 'downgrade-guard' ? h('div', { key: 'downgrade', className: 'dsh-au-panel' }, [
          h('div', { key: 'l', className: 'dsh-au-title' }, t('overlay.title')),
          h('div', { key: 'line', className: 'dsh-au-line' }, t('overlay.downgrade', { installed, target: target ?? '?' })),
          ...renderDowngradeExit({
            t,
            check,
            channel: check?.channel,
            suggested: suggestChannel(check?.tags),
            busy,
            buttonClass: 'dsh-au-selectbtn dsh-au-selectbtn-primary',
            onSwitch: (channel) => flow.switchChannel(channel),
          }),
        ]) : null,
        h('div', { key: 'channel', className: 'dsh-au-panel' }, [
          settingRow('channel', t('settings.channel'), h('select', {
            key: 's',
            className: 'dsh-au-select',
            value: policy.channel,
            disabled: busy,
            onChange: (event) => savePolicy({ channel: event.target.value }),
          }, [
            h('option', { key: 'latest', value: 'latest' }, t('settings.channelLatest')),
            h('option', { key: 'next', value: 'next' }, t('settings.channelNext')),
            h('option', { key: 'alpha', value: 'alpha' }, t('settings.channelAlpha')),
            h('option', { key: 'exact', value: 'exact' }, t('settings.channelExact')),
          ])),
          policy.channel === 'exact'
            ? settingRow('exact', t('settings.exactVersion'), h('input', {
              key: 'v',
              className: 'dsh-au-input',
              defaultValue: policy.exactVersion,
              placeholder: '0.2.0-rc.2',
              onBlur: (event) => savePolicy({ channel: 'exact', exactVersion: event.target.value.trim() }),
            }))
            : null,
          settingRow('daily', t('settings.dailyCheck'), toggle('sw', policy.dailyCheck !== false, () => savePolicy({ dailyCheck: policy.dailyCheck === false }))),
          settingRow('overlay', t('settings.overlay'), toggle('sw', settings.overlay !== false, () => saveSettings({ overlay: settings.overlay === false }))),
          settings.dismissed === true
            ? settingRow('dismissed', t('settings.dismissedHint'), h('button', {
              key: 're',
              className: 'dsh-au-selectbtn',
              disabled: busy,
              onClick: () => saveSettings({ dismissed: false }),
            }, t('settings.reEnable')))
            : null,
          h('div', { key: 'actions', className: 'dsh-au-row' }, [
            h('button', { key: 'c', className: 'dsh-au-selectbtn', disabled: busy, onClick: checkNow }, t('settings.checkNow')),
            h('button', { key: 'p', className: 'dsh-au-selectbtn', disabled: busy, onClick: runPreflight }, t('settings.preflight')),
            capabilities.restart === true
              ? h('button', {
                key: 'r',
                className: 'dsh-au-selectbtn',
                disabled: busy,
                onClick: () => handoff(API.restart, {}, null),
              }, t('settings.restartService'))
              : null,
            pending?.from != null && capabilities.rollback === true
              ? h('button', {
                key: 'rb',
                className: 'dsh-au-selectbtn',
                disabled: busy,
                onClick: () => handoff(API.rollback, { version: pending.from, force: true }, pending.from),
              }, t('settings.rollback', { version: pending.from }))
              : null,
            saved ? h('span', { key: 'saved', className: 'dsh-au-ok' }, t('settings.saved')) : null,
          ]),
        ]),
        preflightFacts === null ? null : h('div', { key: 'facts', className: 'dsh-au-panel' }, [
          h('div', { key: 'l', className: 'dsh-au-title' }, t('settings.preflight')),
          h('div', { key: 'pre', className: 'dsh-au-pre' }, JSON.stringify(preflightFacts, null, 2)),
        ]),
        h('div', { key: 'plugins', className: 'dsh-au-panel' }, [
          h('div', { key: 'l', className: 'dsh-au-title' }, pluginsTarget === null
            ? t('settings.pluginsForInstalled')
            : t('settings.pluginsFor', { target: pluginsTarget })),
          pluginRows.length === 0
            ? h('div', { key: 'e', className: 'dsh-au-muted' }, t('settings.noPlugins'))
            : h('div', { key: 'rows' }, pluginRows),
        ]),
        h('div', { key: 'handoff', className: 'dsh-au-panel' }, [
          h('div', { key: 'l', className: 'dsh-au-title' }, t('settings.result')),
          settingRow('result', resultLine, null),
          pending === null ? null : h('div', { key: 'p', className: 'dsh-au-muted' }, t('settings.pendingRestart', {
            mode: pending.mode ?? '?',
            from: pending.from ?? '?',
            to: pending.to ?? '?',
          })),
        ]),
        h('div', { key: 'restart', className: 'dsh-au-panel' }, [
          h('div', { key: 'l', className: 'dsh-au-title' }, t('settings.restartLog')),
          h('div', { key: 'pre', className: 'dsh-au-pre' }, diagnostics.log.length === 0 ? t('settings.empty') : diagnostics.log.join('\n')),
        ]),
      ])
    }

    /**
     * 客户端入口。
     * @param {any} ctx 客户端上下文。
     * @returns {void}
     */
    function apply(ctx) {
      ctx.inject(['slots', 'locale'], (scope) => {
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'dsh-auto-upgrade: dictionaries')
        }
        const bind = locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : makeT(ZH)

        const overlayOptions = { name: 'shell.overlay', id: 'dsh-auto-upgrade', order: 1000 }
        if (locale !== undefined) overlayOptions.locale = NS
        scope.slots.inject('shell.overlay', () => scope.slots.register(overlayOptions, AutoUpgradeOverlay))

        const sectionOptions = {
          name: 'settings.section',
          id: 'dsh-auto-upgrade',
          order: 40,
          label: () => bind('settings.label'),
        }
        if (locale !== undefined) sectionOptions.locale = NS
        scope.slots.inject('settings.section', () => scope.slots.register(sectionOptions, AutoUpgradeSettings))
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 导出给单测（`test/client-upgrade-entry.test.mjs`）：降级护栏「建议渠道」的纯函数。
    exports.suggestChannel = suggestChannel
    return module.exports
  },
})
