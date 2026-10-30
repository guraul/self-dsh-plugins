/**
 * 浏览器半边：发送栏的咖啡杯按钮 + 屏幕底部通栏状态条。
 *
 * 无构建步骤，手写并包在 `window.__ModuleLoader__.load({id, factory})` 里。
 * 与宿主共享的路由常量在本文件复制一份，由 `test/client-register.test.mjs`
 * 保证与 `lib/host/protocol.js` 一致（本仓各插件互不依赖，共享代码以复制 + 测试为主）。
 *
 * 状态的所有权在宿主：客户端**不持久化**开关，也不轮询、不订阅 SSE。
 * 每次挂载读一次 `GET /status`，之后只信 `POST /start` / `POST /stop` 的返回值。
 * 多标签页不同步（v1 明确接受）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-awake',
  factory: (require) => {
    // ModuleLoader 只给 `require`，导出的模块对象要自己造并 return。
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement
    const NS = 'dsh-awake'

    const API = {
      status: '/plugins/awake/status',
      start: '/plugins/awake/start',
      stop: '/plugins/awake/stop',
    }

    /** 变更类端点必须带的跨站防护头（与宿主 `protocol.js` 的 PLUGIN_HEADER 一致）。 */
    const PLUGIN_HEADER = { 'x-dsh-plugin': 'awake' }

    const ZH = {
      'button.off': '保持唤醒（点一下开启）',
      'button.on': '保持唤醒中（点一下关闭）',
      'bar.label': '保持唤醒中',
      'bar.stop': '关闭',
    }

    const EN = {
      'button.off': 'Keep awake (click to enable)',
      'button.on': 'Keeping awake (click to disable)',
      'bar.label': 'Keeping awake',
      'bar.stop': 'Stop',
    }

    /**
     * 无 locale 服务时的退化翻译。
     * @param {Record<string, string>} dict 字典。
     * @returns {(key: string) => string} 翻译函数。
     */
    function makeT(dict) {
      return (key) => dict[key] ?? key
    }

    /**
     * 注入一次插件样式（幂等）。
     * 全部走 dsh 自己的设计 token；每个 `var()` 都带兜底值，主题里改名也不会变成黑块。
     * @returns {void}
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-awake"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-awake'
      tag.textContent = [
        // 发送栏按钮：纯图标、正方形内边距、全圆角，与 dsh-prompt-optimizer 的可点击区域同规。
        '.dsh-awake-btn{display:inline-flex;align-items:center;justify-content:center;padding:4px;',
        'border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);',
        'line-height:0;cursor:pointer;}',
        '.dsh-awake-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));',
        'color:var(--dsw-alias-label-primary,inherit);}',
        '.dsh-awake-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f7cf7);outline-offset:2px;}',
        // 已开启：accent 色（图标本身在同一命中区里改实心，见图标组件）。
        '.dsh-awake-btn[aria-pressed="true"]{color:var(--dsw-alias-brand-primary,#4f7cf7);}',
        '.dsh-awake-btn:disabled{opacity:.45;cursor:default;}',
        // 底部通栏：横跨三列的一行，高度自持；inactive 时组件返回 null，布局不预留空间。
        '.dsh-awake-bar{display:flex;align-items:center;justify-content:center;gap:8px;height:28px;',
        'padding:0 12px;box-sizing:border-box;',
        'font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family,system-ui));',
        'color:var(--dsw-alias-label-secondary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);',
        'border-top:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.2));}',
        '.dsh-awake-bar-stop{height:20px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.2));',
        'border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer;}',
        '.dsh-awake-bar-stop:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));',
        'color:var(--dsw-alias-label-primary,inherit);}',
        '.dsh-awake-bar-stop:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f7cf7);outline-offset:2px;}',
        '.dsh-awake-bar-stop:disabled{opacity:.45;cursor:default;}',
      ].join('')
      document.head.appendChild(tag)
    }

    /**
     * 发一次请求并解出统一信封。
     * @param {string} url 端点。
     * @param {'GET'|'POST'} method 方法。
     * @returns {Promise<Record<string, any>>} 成功信封。
     * @throws {Error} 非 2xx 或 `ok:false`。
     */
    async function request(url, method) {
      const response = await fetch(url, {
        method,
        cache: 'no-store',
        // 同源请求带自定义头不会触发预检；跨站请求想带它必须先过预检，而本插件不答 CORS。
        headers: method === 'GET' ? undefined : PLUGIN_HEADER,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return payload
    }

    /**
     * 一个极小的外部 store：两个槽位（按钮、状态条）共享同一份状态，
     * 只保留宿主返回的字段，不做乐观更新。
     * @returns {object} store。
     */
    function createStore() {
      let state = { active: false, pid: null, startedAt: null, ready: false, busy: false, error: null }
      const listeners = new Set()
      /** @type {Promise<any>|null} 同一次挂载里的并发 GET 合并。 */
      let inflight = null

      const set = (patch) => {
        state = { ...state, ...patch }
        for (const listener of listeners) listener()
      }

      const subscribe = (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }

      const getSnapshot = () => state

      const adopt = (payload) => ({
        active: payload.active === true,
        pid: typeof payload.pid === 'number' ? payload.pid : null,
        startedAt: typeof payload.startedAt === 'number' ? payload.startedAt : null,
      })

      /** 读一次宿主状态。挂载时调用；并发挂载合并成一次请求。 */
      const refresh = () => {
        if (inflight !== null) return inflight
        if (state.busy) return Promise.resolve()
        inflight = request(API.status, 'GET')
          .then((payload) => set({ ...adopt(payload), ready: true, error: null }))
          .catch((error) => set({ ready: true, error: error instanceof Error ? error.message : String(error) }))
          .finally(() => { inflight = null })
        return inflight
      }

      /** 开关。已 active 就 stop，否则 start；busy 期间忽略重复点击。 */
      const toggle = async () => {
        if (state.busy) return
        set({ busy: true, error: null })
        try {
          const payload = await request(state.active ? API.stop : API.start, 'POST')
          set({ ...adopt(payload), ready: true, busy: false, error: null })
        } catch (error) {
          set({ busy: false, error: error instanceof Error ? error.message : String(error) })
        }
      }

      return { subscribe, getSnapshot, refresh, toggle }
    }

    const store = createStore()

    /**
     * 咖啡杯图标。inactive 是线性描边，active 是实心杯身 + 描边把手/热气。
     * @param {{active: boolean}} props 属性。
     * @returns {any} svg 元素。
     */
    function CoffeeIcon({ active }) {
      const stroke = {
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { pointerEvents: 'none' },
        },
        [
          // 杯身
          h('path', {
            key: 'cup',
            d: 'M3.4 6.4h7.2v3.3a3.6 3.6 0 0 1-3.6 3.6 3.6 3.6 0 0 1-3.6-3.6V6.4z',
            ...stroke,
            ...(active ? { fill: 'currentColor' } : {}),
          }),
          // 把手
          h('path', {
            key: 'handle',
            d: 'M10.6 7.2h.9a1.8 1.8 0 0 1 0 3.6h-.9',
            ...stroke,
          }),
          // 热气
          h('path', { key: 'steam1', d: 'M5.4 2.6c-.5.6.5 1.1 0 1.8', ...stroke }),
          h('path', { key: 'steam2', d: 'M8.0 2.6c-.5.6.5 1.1 0 1.8', ...stroke }),
        ],
      )
    }

    /**
     * 发送栏按钮（`conversation.input.right`，与 dsh-prompt-optimizer 同排）。
     * @param {{t: (key: string) => string}} props 翻译函数（由 `withT` 注入）。
     * @returns {any} 按钮元素。
     */
    function AwakeButton({ t }) {
      const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot)
      react.useEffect(() => { void store.refresh() }, [])
      const label = state.active ? t('button.on') : t('button.off')
      const title = state.error === null ? label : `${label} — ${state.error}`
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-awake-btn',
          title,
          'aria-label': label,
          'aria-pressed': state.active ? 'true' : 'false',
          disabled: state.busy,
          onClick: () => { void store.toggle() },
        },
        h(CoffeeIcon, { active: state.active }),
      )
    }

    /**
     * 底部通栏状态条（`shell.bottom`，root 作用域，横跨三列）。
     * 只在 active 时渲染 —— 空内容布局不预留空间，所以关闭时返回 null 就够。
     * @param {{t: (key: string) => string}} props 翻译函数（由 `withT` 注入）。
     * @returns {any} 状态条元素或 null。
     */
    function AwakeBar({ t }) {
      const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot)
      react.useEffect(() => { void store.refresh() }, [])
      if (!state.active) return null
      return h('div', { className: 'dsh-awake-bar', role: 'status' }, [
        h('span', { key: 'label' }, `☕ ${t('bar.label')}`),
        h(
          'button',
          {
            key: 'stop',
            type: 'button',
            className: 'dsh-awake-bar-stop',
            disabled: state.busy,
            onClick: () => { void store.toggle() },
          },
          t('bar.stop'),
        ),
      ])
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
          ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'dsh-awake: dictionaries')
        }
        const bind = locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : makeT(ZH)

        // 两个座位各自独立 inject：任一槽位在该宿主版本里没声明时，
        // 只跳过它，不会把另一次注册一起拖垮（SlotCore 对未声明槽位是同步抛错）。
        scope.slots.inject('conversation.input.right', () =>
          scope.slots.register(
            { name: 'conversation.input.right', id: 'dsh-awake', order: 40, inject: () => ({}), locale: NS },
            withT(AwakeButton, bind),
          ),
        )
        scope.slots.inject('shell.bottom', () =>
          scope.slots.register(
            { name: 'shell.bottom', id: 'dsh-awake', order: 40, locale: NS },
            withT(AwakeBar, bind),
          ),
        )
      })
    }

    /**
     * 把 `t` 绑进组件，避免每个组件都去碰全局 locale。
     * @param {any} Component 组件。
     * @param {(key: string) => string} bind 翻译函数。
     * @returns {any} 包了一层 `t` 的组件。
     */
    function withT(Component, bind) {
      return function Bound(props) {
        return h(Component, { ...props, t: bind })
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 导出给单测：纯函数与 store 工厂，不需要真浏览器。
    exports.makeT = makeT
    exports.ZH = ZH
    exports.EN = EN
    exports.API = API
    exports.createStore = createStore
    return module.exports
  },
})
