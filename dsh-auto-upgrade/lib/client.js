
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
    }

    const RESULT_FRESH_MS = 10 * 60 * 1000

    const ZH = {
      'settings.label': '自动升级',
      'overlay.title': 'dsh 更新',
      'overlay.checking': '正在检查…',
      'overlay.upToDate': '已是最新（{version}）',
      'overlay.available': '有新版本 {target}（当前 {installed}）',
      'overlay.pluginRisk': '有 {target}，但 {count} 个插件不兼容，按策略不升级',
      'overlay.downgrade': '本机版本高于发布源（{installed} > {target}）',
      'overlay.unknown': '无法确认是否有更新（{error}）',
      'overlay.cached': '今天已检查过',
      'overlay.upgrade': '升级',
      'overlay.recheck': '重新检查',
      'overlay.dismiss': '不再提示',
      'overlay.later': '稍后',
      'overlay.preflightTitle': '升级落点',
      'overlay.releaseNotes': '更新说明',
      'overlay.noReleaseNotes': '拿不到更新说明（{reason}）',
      'overlay.openOnGithub': '在 GitHub 上查看完整说明',
      'overlay.confirm': '确认升级',
      'overlay.cancel': '取消',
      'overlay.backup': '升级前备份 {path}',
      'overlay.sessionsWarning': '{count} 个会话正在执行，升级会中断它们。仍要继续？',
      'overlay.pluginBlocked': '按当前策略不升级：{count} 个插件与新版本不兼容',
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
    }

    const EN = {
      'settings.label': 'Auto upgrade',
      'overlay.title': 'dsh update',
      'overlay.checking': 'Checking…',
      'overlay.upToDate': 'Up to date ({version})',
      'overlay.available': 'New version {target} (current {installed})',
      'overlay.pluginRisk': '{target} is available but {count} plugins are incompatible; not upgrading by policy',
      'overlay.downgrade': 'Installed version is ahead of the release source ({installed} > {target})',
      'overlay.unknown': 'Cannot confirm updates ({error})',
      'overlay.cached': 'already checked today',
      'overlay.upgrade': 'Upgrade',
      'overlay.recheck': 'Re-check',
      'overlay.dismiss': 'Do not show again',
      'overlay.later': 'Later',
      'overlay.preflightTitle': 'Upgrade plan',
      'overlay.releaseNotes': 'Release notes',
      'overlay.noReleaseNotes': 'Release notes unavailable ({reason})',
      'overlay.openOnGithub': 'View full notes on GitHub',
      'overlay.confirm': 'Confirm upgrade',
      'overlay.cancel': 'Cancel',
      'overlay.backup': 'Backup before upgrading: {path}',
      'overlay.sessionsWarning': '{count} sessions are running; upgrading interrupts them. Continue anyway?',
      'overlay.pluginBlocked': 'Not upgrading by policy: {count} plugins are incompatible with the new version',
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
      // 设置页对齐官方设置行/模块平台按钮；浮层卡片对齐官方浮层（MenuSurface + Menu.list）：
      // 半透明填充 + 40px 背景模糊 + elevation-prominent（描边走 border-l1）+ radius-lg + 12/16 内边距。
      tag.textContent = [
        '.dsh-au-card,.dsh-au-section{font:var(--dsw-font-s-14,14px/22px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif));',
        'color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased;}',
        '.dsh-au-card *,.dsh-au-section *{box-sizing:border-box;}',
        '.dsh-au-card{position:fixed;right:16px;bottom:16px;z-index:9999;pointer-events:auto;width:min(400px,calc(100vw - 32px));',
        'padding:12px 16px;border:0;border-radius:var(--dsw-radius-lg,16px);',
        'background:var(--dsw-menu-surface-fill,rgba(255,255,255,.92));',
        'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));',
        '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.35));}',
        '.dsh-au-title{font:var(--dsw-font-s-strong-14,500 14px/22px var(--dsw-font-family));color:var(--dsw-alias-label-primary);}',
        '.dsh-au-line{font:var(--dsw-font-s-14,14px/22px var(--dsw-font-family));color:var(--dsw-alias-label-primary);}',
        '.dsh-au-rowtitle{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);}',
        '.dsh-au-muted{font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));color:var(--dsw-alias-label-tertiary);}',
        '.dsh-au-caption{font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family));color:var(--dsw-alias-label-tertiary);}',
        '.dsh-au-warn{color:var(--dsw-alias-state-warn-label);}',
        '.dsh-au-bad{color:var(--dsw-alias-state-error-primary);}',
        '.dsh-au-ok{color:var(--dsw-alias-state-success-primary);}',
        '.dsh-au-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;}',
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
      const watchRef = react.useRef(null)

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

      /**
       * 交接后跟着任务日志走，直到宿主把手交出去（请求失败即视为交接窗口开始）。
       * @param {string} taskId 任务 id。
       * @returns {void}
       */
      const followTask = (taskId) => {
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

      /**
       * 打开升级确认卡：先看落点，再交给用户点头。
       * @returns {Promise<void>} 完成后刷新界面。
       */
      const openUpgradePlan = async () => {
        const result = await request(API.preflight)
        if (result.ok !== true) {
          setNotice(result.error ?? 'preflight failed')
          return
        }
        const target = check?.target ?? null
        setPlan({ facts: result.preflight, target, notes: undefined })
        if (target === null) return
        // 更新说明是「锦上添花」：拿不到就如实显示拿不到，绝不影响能不能升级
        const notes = await request(`${API.notes}?version=${encodeURIComponent(target)}`)
        setPlan((previous) => (previous === null ? previous : { ...previous, notes }))
      }

      /**
       * 提交升级；会话门禁是「警告可强制」，插件不兼容则拒绝且不可绕过。
       * @param {boolean} force 是否已在会话警告上确认。
       * @returns {Promise<void>} 完成后刷新界面。
       */
      const submitUpgrade = async (force) => {
        setBusy(true)
        const result = await request(API.update, {
          method: 'POST',
          body: { version: plan?.target, force: force === true },
        })
        setBusy(false)
        if (result.ok === true) {
          setNotice(null)
          setPlan(null)
          setLastResult(null)
          setHandoff({ step: 'preflight', log: [] })
          if (typeof result.taskId === 'string') followTask(result.taskId)
          startWatchdog(watchRef, plan?.target ?? null, (state) => setHandoff((previous) => ({ ...(previous ?? { log: [] }), step: state })))
          return
        }
        if (result.code === 'E_SESSIONS_RUNNING' && result.detail?.bypassable === true && force !== true) {
          const count = result.detail?.sessions?.length ?? 0
          if (window.confirm(t('overlay.sessionsWarning', { count }))) {
            await submitUpgrade(true)
          }
          return
        }
        if (result.code === 'E_PLUGIN_INCOMPATIBLE') {
          setNotice(t('overlay.pluginBlocked', { count: result.detail?.plugins?.length ?? 0 }))
          return
        }
        setNotice(result.error ?? 'update failed')
      }

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
      else if (decision === 'update-with-plugin-risk') line = t('overlay.pluginRisk', { target, count: check.incompatible?.length ?? 0 })
      else if (decision === 'downgrade-guard') line = t('overlay.downgrade', { installed, target: target ?? '?' })
      else line = t('overlay.unknown', { error: check?.registryError ?? 'unknown' })

      const children = [h('div', { key: 'title', className: 'dsh-au-title' }, t('overlay.title'))]
      if (line !== '') {
        children.push(h('div', { key: 'line', className: decision === 'update-with-plugin-risk' ? 'dsh-au-warn dsh-au-line' : 'dsh-au-line' }, line))
      }
      if (check?.cached === true) children.push(h('div', { key: 'cached', className: 'dsh-au-muted' }, t('overlay.cached')))
      if (notice !== null) children.push(h('div', { key: 'notice', className: 'dsh-au-warn' }, notice))

      if (lastResult !== null && handoff === null) {
        children.push(h('div', {
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
        children.push(h('div', { key: 'handoff', className: 'dsh-au-warn' }, stepText))
        if ((handoff.log ?? []).length > 0) {
          children.push(h('div', { key: 'log', className: 'dsh-au-pre' }, handoff.log.join('\n')))
        }
      } else if (plan !== null) {
        const facts = plan.facts ?? {}
        children.push(
          h('div', { key: 'plan', className: 'dsh-au-panel' }, [
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
              h('button', { key: 'go', className: 'dsh-au-btn dsh-au-primary', disabled: busy, onClick: () => submitUpgrade(false) }, t('overlay.confirm')),
              h('button', { key: 'no', className: 'dsh-au-btn', onClick: () => setPlan(null) }, t('overlay.cancel')),
            ]),
          ]),
        )
      } else {
        const actions = []
        if (decision === 'update-available' || decision === 'update-with-plugin-risk') {
          actions.push(h('button', {
            key: 'up',
            className: 'dsh-au-btn dsh-au-primary',
            disabled: busy || decision === 'update-with-plugin-risk',
            onClick: openUpgradePlan,
          }, t('overlay.upgrade')))
        }
        actions.push(h('button', { key: 're', className: 'dsh-au-btn', disabled: busy, onClick: () => runCheck(true) }, t('overlay.recheck')))
        actions.push(h('button', { key: 'di', className: 'dsh-au-btn', onClick: dismissForever }, t('overlay.dismiss')))
        actions.push(h('button', { key: 'la', className: 'dsh-au-btn', onClick: () => setHidden(true) }, t('overlay.later')))
        children.push(h('div', { key: 'actions', className: 'dsh-au-row' }, actions))
      }

      return h('div', { className: 'dsh-au-card', 'data-shell-overlay': 'dsh-auto-upgrade' }, children)
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
      const [diagnostics, setDiagnostics] = react.useState({ log: [], result: null, payload: null })
      const [saved, setSaved] = react.useState(false)
      const [busy, setBusy] = react.useState(false)
      const [notice, setNotice] = react.useState(null)
      const watchRef = react.useRef(null)

      const refresh = react.useCallback(async () => {
        const snapshot = await request(API.status)
        if (snapshot.ok === true) setState(snapshot)
        const inventory = await request(API.plugins)
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
          h('div', { key: 'l', className: 'dsh-au-title' }, t('settings.plugins')),
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
    return module.exports
  },
})
