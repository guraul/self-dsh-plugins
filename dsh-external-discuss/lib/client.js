/**
 * dsh-plugin-external-discuss —— 浏览器半边（免构建）。
 *
 * 往助手消息操作栏（conversation.chat.assistant-actions）注册一个入口：
 *   [时间] [复制] [外部讨论 ← 本插件] [反馈] [新对话分支] [用量] [时间]
 *
 * 点开是一个参照「用量」小组件做的弹层，列出投递目标；当前只有清言可用，
 * 千问 / DeepSeek 先占位。投递链路：
 *
 *   按钮 → GET /api/dsh-external-discuss/payload（宿主取会话文本）
 *        → window.postMessage → Chrome 扩展 content script → 清言 tab
 *        → 扩展回 ack → 这里把结果显示出来
 *
 * 无构建步骤：手写并包在 window.__ModuleLoader__.load({id, factory}) 里，
 * 与 dsh-auto-upgrade 的浏览器半边同形。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-external-discuss',
  factory: (require) => {
    // ModuleLoader 只给 `require`，导出的模块对象要自己造并 return。
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement

    const SLOT = 'conversation.chat.assistant-actions'
    const ENTRY_ID = 'external-discuss'
    /** 反馈条目是 10；排在它后面，仍然落在「复制」与「新对话分支」之间。 */
    const ENTRY_ORDER = 20
    const API_PAYLOAD = '/api/dsh-external-discuss/payload'
    /** 与扩展约定的 postMessage 频道名。 */
    const MESSAGE_SOURCE = 'dsh-external-discuss'
    /** 等扩展回执的上限：超时即判定「没装扩展/没注入本页」。 */
    const ACK_TIMEOUT_MS = 2500

    /** 投递目标。enabled=false 的是占位，UI 上禁用并标注「即将支持」。 */
    const TARGETS = [
      { id: 'qingyan', label: '清言', hint: 'chatglm.cn · 新建对话并粘贴', enabled: true },
      { id: 'qwen', label: '千问', hint: '即将支持', enabled: false },
      { id: 'deepseek', label: 'DeepSeek', hint: '即将支持', enabled: false },
    ]

    const COLOR = {
      labelPrimary: 'var(--dsw-alias-label-primary, #1a1a1a)',
      labelSecondary: 'var(--dsw-alias-label-secondary, #616161)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      border: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
      surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05))',
      business: 'var(--dsw-alias-state-business-primary, #2b6cff)',
      error: 'var(--dsw-alias-state-error-primary, #d93f4c)',
    }

    const styles = {
      trigger: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        padding: '0 6px',
        border: 'none',
        background: 'transparent',
        color: COLOR.labelTertiary,
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1,
        borderRadius: 6,
        cursor: 'pointer',
      },
      panel: {
        position: 'fixed',
        zIndex: 9999,
        minWidth: 248,
        padding: 12,
        border: `1px solid ${COLOR.border}`,
        borderRadius: 12,
        background: COLOR.surface,
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
        color: COLOR.labelPrimary,
        font: 'inherit',
        fontSize: 13,
      },
      title: { fontSize: 12, fontWeight: 600, color: COLOR.labelSecondary, letterSpacing: 0.2 },
      subtitle: { marginTop: 2, fontSize: 11, color: COLOR.labelTertiary },
      rule: { height: 1, margin: '10px 0', background: COLOR.border },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        width: '100%',
        padding: '8px 10px',
        border: 'none',
        borderRadius: 8,
        background: 'transparent',
        color: COLOR.labelPrimary,
        font: 'inherit',
        fontSize: 13,
        textAlign: 'left',
        cursor: 'pointer',
      },
      rowDisabled: { color: COLOR.labelTertiary, cursor: 'not-allowed' },
      rowLabel: { fontWeight: 500 },
      rowHint: { fontSize: 11, color: COLOR.labelTertiary, whiteSpace: 'nowrap' },
      status: { marginTop: 10, fontSize: 11, lineHeight: 1.5, color: COLOR.labelSecondary, wordBreak: 'break-word' },
      statusError: { color: COLOR.error },
    }

    const icon = () =>
      h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M6.4 3.6H4.3A1.8 1.8 0 0 0 2.5 5.4v6.3a1.8 1.8 0 0 0 1.8 1.8h6.3a1.8 1.8 0 0 0 1.8-1.8V9.6',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M9.6 2.6h3.9v3.9',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M13.4 2.7 7.7 8.4',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      )

    /**
     * 操作栏入口：一个触发按钮 + 一个弹层小部件。
     * @param {{messageId?: string, sessionId?: string}} props 插槽属性。
     * @returns {import('react').ReactElement} 元素。
     */
    function ExternalDiscussAction(props) {
      // 注入面刻意不用 sessionId 这个名字：避免与插槽框架的标准属性重名。
      const sessionId = typeof props.discussSessionId === 'string' ? props.discussSessionId : ''
      const messageId = typeof props.messageId === 'string' ? props.messageId : ''

      const [open, setOpen] = react.useState(false)
      /** idle | sending | sent | error */
      const [status, setStatus] = react.useState('idle')
      const [detail, setDetail] = react.useState('')
      /** 弹层锚点：贴住触发按钮右上角向上展开。 */
      const [anchor, setAnchor] = react.useState(null)
      const rootRef = react.useRef(null)
      const ackTimer = react.useRef(null)

      react.useEffect(
        () => () => {
          if (ackTimer.current !== null) clearTimeout(ackTimer.current)
        },
        [],
      )

      // 扩展回执
      react.useEffect(() => {
        const onMessage = (event) => {
          if (event.source !== window) return
          const data = event.data
          if (data === null || typeof data !== 'object' || data.source !== MESSAGE_SOURCE) return
          if (data.type !== 'ack') return
          if (ackTimer.current !== null) {
            clearTimeout(ackTimer.current)
            ackTimer.current = null
          }
          const ok = data.ok === true
          setStatus(ok ? 'sent' : 'error')
          setDetail(typeof data.detail === 'string' ? data.detail : '')
          if (ok) setTimeout(() => setOpen(false), 1200)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      // 打开时定位 + 关掉外部点击 / Esc
      react.useEffect(() => {
        if (!open) return undefined
        const element = rootRef.current
        if (element !== null) {
          const rect = element.getBoundingClientRect()
          setAnchor({
            right: Math.max(8, window.innerWidth - rect.right),
            bottom: Math.max(8, window.innerHeight - rect.top + 8),
          })
        }
        const onPointerDown = (event) => {
          if (rootRef.current !== null && rootRef.current.contains(event.target)) return
          if (event.target instanceof Element && event.target.closest('[data-external-discuss-panel]') !== null) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      /**
       * 投递到某个目标：先从宿主取会话文本，再交给扩展。
       * @param {{id: string, label: string}} target 目标。
       * @returns {Promise<void>} 完成。
       */
      const send = async (target) => {
        if (status === 'sending') return
        if (sessionId === '') {
          setStatus('error')
          setDetail('拿不到会话 id，无法取会话内容')
          return
        }
        setStatus('sending')
        setDetail('正在从宿主取会话内容…')
        try {
          const query = new URLSearchParams({ sessionId })
          const response = await fetch(`${API_PAYLOAD}?${query.toString()}`, { headers: { accept: 'application/json' } })
          const body = await response.json().catch(() => null)
          if (!response.ok || body === null || body.ok !== true) {
            throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
          }
          setDetail(`已取到 ${body.stats?.messages ?? 0} 条消息 / ${body.stats?.chars ?? 0} 字，正在交给扩展…`)
          window.postMessage(
            {
              source: MESSAGE_SOURCE,
              type: 'send',
              target: target.id,
              title: typeof body.title === 'string' ? body.title : '',
              text: typeof body.text === 'string' ? body.text : '',
              sessionId,
              messageId,
            },
            '*',
          )
          if (ackTimer.current !== null) clearTimeout(ackTimer.current)
          ackTimer.current = setTimeout(() => {
            ackTimer.current = null
            setStatus('error')
            setDetail('没等到扩展回执：确认扩展已加载，并刷新过本页')
          }, ACK_TIMEOUT_MS)
        } catch (error) {
          setStatus('error')
          setDetail(error instanceof Error ? error.message : String(error))
        }
      }

      const statusText =
        status === 'sending'
          ? detail
          : status === 'sent'
            ? `已投递到${TARGETS.find((target) => target.enabled)?.label ?? '目标'}${detail === '' ? '' : `：${detail}`}`
            : status === 'error'
              ? detail
              : ''

      const panel =
        open && anchor !== null
          ? h(
              'div',
              {
                'data-external-discuss-panel': '',
                role: 'dialog',
                'aria-label': '外部讨论',
                style: { ...styles.panel, right: anchor.right, bottom: anchor.bottom },
              },
              h('div', { style: styles.title }, '外部讨论'),
              h('div', { style: styles.subtitle }, '把这次会话送到另一个模型继续聊'),
              h('div', { style: styles.rule }),
              ...TARGETS.map((target) =>
                h(
                  'button',
                  {
                    key: target.id,
                    type: 'button',
                    disabled: !target.enabled || status === 'sending',
                    style: target.enabled ? styles.row : { ...styles.row, ...styles.rowDisabled },
                    onClick: () => {
                      if (target.enabled) void send(target)
                    },
                    onMouseEnter: (event) => {
                      if (target.enabled) event.currentTarget.style.background = COLOR.hover
                    },
                    onMouseLeave: (event) => {
                      event.currentTarget.style.background = 'transparent'
                    },
                  },
                  h('span', { style: styles.rowLabel }, target.label),
                  h('span', { style: styles.rowHint }, target.hint),
                ),
              ),
              statusText !== ''
                ? h(
                    'div',
                    { style: status === 'error' ? { ...styles.status, ...styles.statusError } : styles.status },
                    statusText,
                  )
                : null,
            )
          : null

      return h(
        'span',
        { ref: rootRef, style: { display: 'inline-flex' } },
        h(
          'button',
          {
            type: 'button',
            title: '外部讨论',
            'aria-label': '外部讨论',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            style: styles.trigger,
            onClick: () => setOpen((current) => !current),
            onMouseEnter: (event) => {
              event.currentTarget.style.color = COLOR.labelSecondary
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.color = COLOR.labelTertiary
            },
          },
          icon(),
        ),
        panel,
      )
    }

    /**
     * 注册入口。
     * @param {import('@deepseek-ai/cordis').Context} ctx 客户端上下文。
     * @returns {void}
     */
    function apply(ctx) {
      ctx.inject(['slots'], (scope) => {
        scope.slots.inject(SLOT, () =>
          scope.slots.register(
            {
              name: SLOT,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              label: '外部讨论',
              // 会话作用域插槽的注入工厂拿到 sessionId；回传给组件供取会话内容用。
              inject: (sessionId) => ({ discussSessionId: sessionId }),
            },
            ExternalDiscussAction,
          ),
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
