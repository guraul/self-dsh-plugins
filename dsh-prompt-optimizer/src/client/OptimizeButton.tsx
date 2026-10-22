import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 类型级引入,激活 'conversation.input.right' 的 SlotMap 合并声明。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DiagnosisCard } from './DiagnosisCard.js'
import { LoadingIcon } from './LoadingIcon.js'
import { SparkleIcon } from './SparkleIcon.js'
import { UndoIcon } from './UndoIcon.js'
import { useT } from './i18n.js'
import { resolveButtonState, type OptimizerController } from './controller.js'

export type OptimizeButtonProps = PropsRuntime<'conversation.input.right'>

// 发送栏工具行按钮:纯图标、正方形内边距、全圆角,宽度贴住图标(14px + 4px×2)。
// 图标与文字不再共处一行,所以没有 gap;底色与 hover 走注入样式表的 .dsh-po-opt
// 规则(inline background 会盖过 :hover)。官方那个浅底(#f5f6f7)不是 dsw 令牌,
// 用 label-primary 做 color-mix 近似,不支持时自然回落透明底。
const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 4,
  fontSize: 12,
  lineHeight: 0,
  borderRadius: 999,
  border: 'none',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
  // loading / applied 两态都必须可点(取消 / 还原),所以这里不设 pointer-events:none;
  // 真正需要免疫点击的是里面的图标(三个图标组件各自 pointerEvents:none)。
  whiteSpace: 'nowrap',
} as const

/**
 * 发送栏工具行右区的触发按钮。**同一个位置、四种视觉态,不弹任何面板**:
 *
 * | 态 | 图标 | 点击 |
 * |---|---|---|
 * | idle(有草稿) | 线性四芒星 | 发起优化 |
 * | idle(空草稿) | 四芒星 + 0.45 透明度、not-allowed | 无操作(disabled) |
 * | loading | 转圈图标(每秒刷新的「已用 12s」) | 取消优化 |
 * | applied | 撤回箭头 | 还原替换前的草稿 |
 * | error | 四芒星 + 红色 | 重新发起优化 |
 */
export function createOptimizeButton(controller: OptimizerController) {
  return function OptimizeButton(props: OptimizeButtonProps) {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const t = useT()
    // 输入状态的两种宿主形态:0.1.2 起渲染器提供 useInput standard hook;
    // 旧版(0.1.0-rc.x/0.1.1-rc.x)渲染器直传 input 快照对象。
    // inputActions 由 session 作用域槽位宿主下发(hooks:["conversation","input"])。
    const p = props as OptimizeButtonProps & {
      useInput?: (selector: (s: unknown) => unknown) => unknown
      input?: { draft?: string }
      sessionId?: string
      inputActions?: { setDraft(text: string): void }
    }
    const input = p.useInput ? (p.useInput((s: unknown) => s) as { draft?: string }) : p.input
    const draft = input?.draft ?? ''
    const sessionId = p.sessionId
    const inputActions = p.inputActions
    // 状态机唯一入口(纯函数,见 controller.resolveButtonState):
    // loading > applied > error > idle(空) > idle(有草稿)
    const view = resolveButtonState({ status: state.status, applied: state.applied, sessionId, draft })

    // ---- loading 计时(局部 state,不进 controller:每秒变不该惊动所有订阅者) ----
    const [elapsed, setElapsed] = useState(0)
    // 点击那一刻的时间戳;loading 的秒数从它算起(而不是从 effect 挂载算起)。
    const startedAtRef = useRef(0)
    useEffect(() => {
      if (state.status !== 'loading') return
      const started = startedAtRef.current || Date.now()
      setElapsed(Math.floor((Date.now() - started) / 1000))
      const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
      // 离开 loading / 会话切换卸载组件时必须清掉,避免定时器泄漏。
      return () => clearInterval(timer)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.status])

    // ---- done → 直接把结果写回草稿,并留下「可还原」的依据 ----
    // 依赖只取 state.status:settle() 把状态打回 idle,effect 自然不再重跑。
    useEffect(() => {
      if (state.status !== 'done') return
      const { result, last } = state
      // 会话隔离:controller 是会话间共享的单例,只允许「发起优化的那个会话」写回;
      // 切会话后迟到的结果直接丢弃,绝不写进另一个会话的输入框。
      // 非发起方只丢弃、**不复位**:复位权归写回者,免得抢在对方写回前把 result 清掉。
      if (!result || !last || last.sessionId !== sessionId) return
      // 斜杠命令前缀必须拼回(优化只针对正文)。
      const next = last.prefix ? `${last.prefix} ${result.optimized}` : result.optimized
      if (inputActions) {
        inputActions.setDraft(next)
        // 宿主 setDraft 走 history-merge(合并进上一条历史记录),Cmd+Z 不可靠,
        // 所以替换这个动作必须自带撤回依据:backup = **写回前**的草稿全文。
        controller.markApplied({ backup: draft, text: next, sessionId })
      }
      controller.settle()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.status])

    // ---- applied 失效条件 ----
    // 1) 换会话 → 立刻清掉(不能拿旧会话的备份去覆盖别的会话);
    // 2) 用户自己编辑过草稿(draft 已不等于替换文本)→ 旧备份失效,不许再覆盖新输入。
    // confirmedRef 是「写回已落到 draft」的确认:markApplied 与 setDraft 不是同一次
    // 渲染里落地的,draft 追上 text 之前不做失效判定,否则会把自己刚建立的依据撤掉。
    const confirmedRef = useRef<string | null>(null)
    useEffect(() => {
      const applied = state.applied
      if (!applied) {
        confirmedRef.current = null
        return
      }
      if (applied.sessionId !== sessionId) {
        controller.clearApplied()
        confirmedRef.current = null
        return
      }
      if (draft === applied.text) {
        confirmedRef.current = applied.text
        return
      }
      if (confirmedRef.current !== applied.text) return
      controller.clearApplied()
      confirmedRef.current = null
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft, state.applied, sessionId])

    // ---- error 态:title 承载完整错误文本(颜色只是次要提示),3 秒后自动复位 ----
    // 绝不清空用户原草稿——失败时输入框必须原样保留。
    useEffect(() => {
      if (state.status !== 'error') return
      const timer = setTimeout(() => controller.settle(), 3000)
      return () => clearTimeout(timer)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.status])

    // 取消后复位:面板已移除,cancelled 态没有承载者,按钮直接回到空闲外观。
    useEffect(() => {
      if (state.status === 'cancelled') controller.settle()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.status])

    const title =
      view === 'loading'
        ? t('button.titleLoading', { seconds: elapsed })
        : view === 'applied'
          ? t('button.titleApplied')
          : view === 'error'
            ? (state.error ?? t('panel.error'))
            : view === 'empty'
              ? t('button.titleEmpty')
              : t('button.title')

    // ---- 诊断浮卡:悬停 / Tab 聚焦时展开最近一次诊断(只在发起它的会话里显示) ----
    // `state.last` 是这个 controller 最近一次请求的归属会话;诊断来自那次请求的 done,
    // 所以两者天然同源。不匹配说明用户切到了别的会话 → 卡片不显示。
    const diagnosis = state.last?.sessionId === sessionId ? state.lastAnalysis : null
    // loading 期间不显示(hover 会让正在转圈的按钮分心,也避免与 title 计时抢注意力)。
    const canHover = state.status !== 'loading' && !!diagnosis
    const [hovered, setHovered] = useState(false)
    const showDiagnosis = canHover && hovered

    const onClick = () => {
      // loading 中点击 = 取消(模型卡住时的逃生口;不依赖 Esc,面板已移除)。
      if (view === 'loading') {
        controller.cancel()
        return
      }
      // applied 中点击 = 还原替换前的草稿(唯一能救回原稿的入口)。
      if (view === 'applied' && state.applied) {
        inputActions?.setDraft(state.applied.backup)
        controller.clearApplied()
        return
      }
      // error 态点击 = 重新发起优化;先记时,标题的「已用 Ns」从这次点击算起。
      startedAtRef.current = Date.now()
      setElapsed(0)
      void controller.optimize(draft, sessionId)
    }

    return (
      // position:relative 是浮卡的定位锚点(卡片 absolute 相对它摆放)。
      // 鼠标事件必须挂在 span 而不是 button 上:empty 态 button 带 `disabled`,
      // 而 Chrome/Safari 对 disabled 元素**不派发鼠标事件**(React 合成事件同样收不到),
      // 挂 button 上会导致「输入框清空后诊断浮卡永远弹不出来」。span 不是 disabled,始终派发。
      <span
        style={{ display: 'inline-flex', position: 'relative' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <button
          className="dsh-po-btn dsh-po-opt"
          type="button"
          data-po-state={view}
          style={{
            ...buttonStyle,
            ...(view === 'error' ? { color: 'var(--dsw-alias-state-error, #d64545)' } : {}),
            ...(view === 'empty' ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
          }}
          disabled={view === 'empty'}
          aria-busy={view === 'loading'}
          // 浮卡会出现时清空原生 title:否则浏览器 tooltip 与自绘卡片会同时冒出来打架。
          // 可访问性改由 aria-label 承载同一句文案(屏幕阅读器照常朗读)。
          title={canHover ? '' : title}
          aria-label={title}
          // focus 不冒泡,且焦点只会落在 button 上(span 不可聚焦),所以这两个留在这里;
          // 鼠标事件已移到外层 span(见上,绕开 disabled 不派发事件的问题)。
          onFocus={() => setHovered(true)}
          onBlur={() => setHovered(false)}
          onClick={onClick}
        >
          {view === 'loading' ? <LoadingIcon /> : view === 'applied' ? <UndoIcon /> : <SparkleIcon />}
        </button>
        {showDiagnosis && diagnosis ? <DiagnosisCard text={diagnosis} title={t('button.diagnosisTitle')} /> : null}
      </span>
    )
  }
}
