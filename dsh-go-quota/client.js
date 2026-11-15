/**
 * 浏览器半边：输入框下方那行统计 pill 里的「额度」，点开是三个窗口的进度面板。
 * 样式全部沿用 dsh 的设计 token，与相邻的统计 pill、上下文浮层保持同一套皮肤。
 */
window.__ModuleLoader__.load({
  id: 'dsh-go-quota',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const reactDom = require('react-dom')
    const h = react.createElement
    const NS = 'dsh-go-quota'
    const ENDPOINT = '/plugins/go-quota/usage'
    const FRESH_MS = 60000

    const ZH = {
      'pill.label': '额度',
      'pill.title': 'OpenCode GO 额度（5 小时窗口已用）',
      'panel.title': 'OpenCode GO 额度',
      'window.rolling': '5 小时',
      'window.weekly': '本周',
      'window.monthly': '本月',
      'used': '{percent}% 已用',
      'reset.in': '{time}后重置',
      'reset.now': '即将重置',
      'updated': '{time} 更新',
      'state.loading': '查询中…',
      'state.failed': '刷新失败，显示上次结果',
      'state.busy': '刷新中…',
      'state.nokey': '未配置 OPENCODE_GO_API_KEY',
      'state.unauthorized': 'key 无效或未订阅 GO',
      'state.unavailable': '额度不可用',
      'unit.day': '天',
      'unit.hour': '小时',
      'unit.minute': '分钟',
    }

    const EN = {
      'pill.label': 'Quota',
      'pill.title': 'OpenCode GO quota (5-hour window used)',
      'panel.title': 'OpenCode GO quota',
      'window.rolling': '5 hours',
      'window.weekly': 'This week',
      'window.monthly': 'This month',
      'used': '{percent}% used',
      'reset.in': 'resets in {time}',
      'reset.now': 'resetting now',
      'updated': 'updated {time}',
      'state.loading': 'Loading…',
      'state.failed': 'Refresh failed, showing last result',
      'state.busy': 'Refreshing…',
      'state.nokey': 'OPENCODE_GO_API_KEY is not configured',
      'state.unauthorized': 'Key invalid or no GO subscription',
      'state.unavailable': 'Quota unavailable',
      'unit.day': 'd',
      'unit.hour': 'h',
      'unit.minute': 'm',
    }

    /**
     * 无 locale 服务时的退化翻译。
     * @param {Record<string, string>} dict 字典。
     * @returns {(key: string, vars?: Record<string, string|number>) => string} 翻译函数。
     */
    function makeT(dict) {
      return (key, vars) => {
        const text = dict[key] ?? key
        if (vars === undefined) return text
        return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
      }
    }

    /** 注入一次插件样式（幂等）。 */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-go-quota"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-go-quota'
      tag.textContent = [
        '.dsh-gq-anchor{display:inline-flex;flex:none;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));}',
        '.dsh-gq-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;padding:1px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer;}',
        '.dsh-gq-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}',
        '@media (hover:hover){.dsh-gq-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}}',
        '.dsh-gq-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(264px,calc(100vw - 24px));padding:12px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:default;max-width:calc(100vw - 24px);max-height:calc(100dvh - 12px - max(12px,var(--dsh-frame-overlay-top,12px)));overflow-y:auto;position-area:none;top:max(12px,var(--dsh-frame-overlay-top,12px));bottom:max(12px,calc(anchor(top) + 8px));left:max(12px,anchor(left));right:12px;position-try-fallbacks:--dsh-gq-window,--dsh-gq-opposite,--dsh-gq-wide-opposite,--dsh-gq-tall;align-self:end;justify-self:start;height:fit-content;margin:0;}',
        '@position-try --dsh-gq-window{position-area:none;top:max(12px,var(--dsh-frame-overlay-top,12px));bottom:max(12px,calc(anchor(top) + 8px));left:12px;right:12px;margin:0;align-self:safe end;justify-self:safe end;}',
        '@position-try --dsh-gq-opposite{top:max(12px,calc(anchor(bottom) + 8px));bottom:12px;align-self:start;}',
        '@position-try --dsh-gq-wide-opposite{top:max(12px,calc(anchor(bottom) + 8px));bottom:12px;left:12px;right:12px;align-self:start;justify-self:safe end;}',
        '@position-try --dsh-gq-tall{position-area:none;top:max(12px,var(--dsh-frame-overlay-top,12px));bottom:12px;left:max(12px,anchor(left));right:12px;margin:0;align-self:safe start;justify-self:start;}',
        '.dsh-gq-title{display:flex;align-items:center;gap:6px;}',
        '.dsh-gq-title-label{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-weight:500;}',
        '.dsh-gq-title-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:11px;}',
        '.dsh-gq-rule{height:1px;background:var(--dsw-alias-border-l2);margin:8px 0 2px;}',
        '.dsh-gq-row{padding:6px 0;}',
        '.dsh-gq-head{display:flex;align-items:baseline;gap:8px;}',
        '.dsh-gq-win{color:var(--dsw-alias-label-secondary);}',
        '.dsh-gq-val{margin-left:auto;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}',
        '.dsh-gq-bar{margin:6px 0 4px;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;}',
        '.dsh-gq-fill{height:100%;border-radius:999px;background:var(--dsw-alias-label-tertiary);transition:width .2s ease;}',
        '.dsh-gq-fill.is-warn{background:var(--dsw-alias-state-warn-primary);}',
        '.dsh-gq-fill.is-danger{background:var(--dsw-alias-state-error-primary);}',
        '.dsh-gq-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;}',
        '.dsh-gq-foot{margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;}',
      ].join('')
      document.head.appendChild(tag)
    }

    /** 三段式圆环图标，呼应三个窗口。 */
    function QuotaIcon() {
      const arcs = [
        { d: 'M7 1.5 A5.5 5.5 0 0 1 12.5 7', opacity: 0.35 },
        { d: 'M12.5 7 A5.5 5.5 0 0 1 7 12.5', opacity: 0.6 },
        { d: 'M7 12.5 A5.5 5.5 0 0 1 1.5 7', opacity: 1 },
      ]
      return h(
        'svg',
        {
          viewBox: '0 0 14 14',
          width: 14,
          height: 14,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.5,
          'stroke-linecap': 'round',
        },
        arcs.map((arc, index) => h('path', { key: index, d: arc.d, opacity: arc.opacity })),
      )
    }

    /**
     * 把重置时刻算成「4 小时 37 分」。
     * @param {string} resetsAt ISO 时间。
     * @param {(key: string) => string} t 翻译函数。
     * @returns {string} 相对时间。
     */
    function relative(resetsAt, t) {
      const target = Date.parse(resetsAt)
      if (!Number.isFinite(target)) return ''
      const minutes = Math.round((target - Date.now()) / 60000)
      if (minutes <= 0) return t('reset.now')
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const rest = minutes % 60
      const parts = []
      if (days > 0) parts.push(days + t('unit.day'))
      if (hours > 0) parts.push(hours + t('unit.hour'))
      if (days === 0 && rest > 0) parts.push(rest + t('unit.minute'))
      return t('reset.in', { time: parts.join('') || '1' + t('unit.minute') })
    }

    /**
     * 阈值色：80% 起黄、95% 起红。
     * @param {number} percent 已用百分比。
     * @returns {string} 空串 / is-warn / is-danger。
     */
    function tone(percent) {
      if (percent >= 95) return 'is-danger'
      if (percent >= 80) return 'is-warn'
      return ''
    }

    /**
     * 额度 pill。
     * @param {{t: (key: string, vars?: Record<string, string|number>) => string}} props 翻译函数。
     * @returns {any} 元素。
     */
    function GoQuotaPill({ t }) {
      const [state, setState] = react.useState({ data: null, fetchedAt: 0, busy: false, error: null })
      const [open, setOpen] = react.useState(false)
      const stateRef = react.useRef(state)
      const rootRef = react.useRef(null)
      const panelRef = react.useRef(null)
      const anchorName = '--dsh-gq-' + react.useId().replace(/:/g, '')

      stateRef.current = state

      const load = react.useCallback(async (force) => {
        const snapshot = stateRef.current
        if (!force && snapshot.data !== null && Date.now() - snapshot.fetchedAt < FRESH_MS) return
        if (snapshot.busy) return
        setState((prev) => ({ ...prev, busy: true }))
        try {
          const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' })
          const body = await response.json()
          if (body?.ok === true) {
            setState({ data: body, fetchedAt: Date.now(), busy: false, error: null })
          } else {
            setState((prev) => ({ ...prev, busy: false, error: body?.code ?? 'unavailable' }))
          }
        } catch {
          setState((prev) => ({ ...prev, busy: false, error: 'network' }))
        }
      }, [])

      react.useEffect(() => { void load(false) }, [load])

      react.useEffect(() => {
        if (!open) return
        void load(false)
        const onPointerDown = (event) => {
          const node = event.target
          if (rootRef.current?.contains(node) || panelRef.current?.contains(node)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open, load])

      const windows = state.data?.windows ?? []
      const rolling = windows.find((item) => item.key === 'rolling')
      const percent = rolling === undefined ? null : Math.round(rolling.percent)
      const reading = percent === null ? '--' : percent + '%'
      const summary = windows.length === 0
        ? t('pill.title')
        : windows.map((item) => t('window.' + item.key) + ' ' + Math.round(item.percent) + '%').join(' · ')

      const trigger = h(
        'button',
        {
          type: 'button',
          className: 'dsh-gq-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': t('panel.title') + ' · ' + summary,
          title: summary,
          onClick: () => { setOpen(!open) },
        },
        h(QuotaIcon, null),
        h('span', null, t('pill.label') + ' ' + reading),
      )

      const panel = open && windows.length > 0
        ? reactDom.createPortal(
          h(
            'div',
            {
              ref: panelRef,
              className: 'dsh-gq-panel',
              style: { positionAnchor: anchorName },
              role: 'dialog',
              'aria-label': t('panel.title'),
            },
            h(
              'div',
              { className: 'dsh-gq-title' },
              h('span', { className: 'dsh-gq-title-label' }, h(QuotaIcon, null), t('panel.title')),
              h('span', { className: 'dsh-gq-title-meta' }, state.fetchedAt === 0 ? '' : t('updated', { time: new Date(state.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })),
            ),
            h('div', { className: 'dsh-gq-rule' }),
            windows.map((item) => h(
              'div',
              { key: item.key, className: 'dsh-gq-row' },
              h(
                'div',
                { className: 'dsh-gq-head' },
                h('span', { className: 'dsh-gq-win' }, t('window.' + item.key)),
                h('span', { className: 'dsh-gq-val' }, t('used', { percent: Math.round(item.percent) })),
              ),
              h(
                'div',
                { className: 'dsh-gq-bar' },
                h('div', { className: 'dsh-gq-fill ' + tone(item.percent), style: { width: item.percent + '%' } }),
              ),
              h('div', { className: 'dsh-gq-meta' }, relative(item.resetsAt, t)),
            )),
            h(
              'div',
              { className: 'dsh-gq-foot' },
              state.error === null ? (state.busy ? t('state.busy') : '') : t('state.failed'),
            ),
          ),
          document.body,
        )
        : null

      return h(
        'span',
        { ref: rootRef, style: { anchorName }, className: 'dsh-gq-anchor' },
        trigger,
        panel,
      )
    }

    /**
     * 把 `t` 绑进组件。
     * @param {any} Component 组件。
     * @param {(key: string, vars?: Record<string, string|number>) => string} bind 翻译函数。
     * @returns {any} 包装后的组件。
     */
    function withT(Component, bind) {
      return function Bound(props) {
        return h(Component, { ...props, t: bind })
      }
    }

    /**
     * 客户端入口。
     * @param {any} ctx 客户端上下文。
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyles()
      ctx.inject(['slots', 'locale'], (scope) => {
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'dsh-go-quota: dictionaries')
        }
        const bind = locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : makeT(ZH)
        scope.slots.inject('conversation.composer.dock', () =>
          scope.slots.register(
            { name: 'conversation.composer.dock', id: 'go-quota', order: 60, inject: () => ({}), locale: NS },
            withT(GoQuotaPill, bind),
          ),
        )
      })
    }

    exports.name = 'dsh-go-quota'
    exports.apply = apply
    module.exports = exports
    return module.exports
  },
})
