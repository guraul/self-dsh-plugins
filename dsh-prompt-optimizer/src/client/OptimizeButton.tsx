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
 *
 * 优化产出诊断时,按钮右上角另起一个 6px 圆点:点它展开「诊断分析」卡(可滚可复制),
 * Esc / 点外部 / 再点圆点收起。hover 不再是任何交互的触发方式。
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

    // ---- 诊断卡:点击按钮右上角圆点展开(不再依赖 hover) ----
    // `state.last` 是这个 controller 最近一次请求的归属会话;诊断来自那次请求的 done,
    // 所以两者天然同源。不匹配说明用户切到了别的会话 → 圆点与卡片都不显示。
    const diagnosis = state.last?.sessionId === sessionId ? state.lastAnalysis : null
    // loading 期间不给第二个可点目标(正在转圈的按钮不该被圆点分心)。
    const showDot = state.status !== 'loading' && !!diagnosis
    const [diagnosisOpen, setDiagnosisOpen] = useState(false)
    // 圆点消失时必须一并收起卡片:切会话(诊断归属变了)与新一轮优化开始(loading)
    // 都会让圆点消失;不收起的话,下次 done 圆点回来时旧卡片会自己弹出来。
    useEffect(() => {
      setDiagnosisOpen(false)
    }, [sessionId, showDot])
    // 关闭触发:Esc / 点击按钮与卡片以外的区域。监听挂在 document 上,
    // 只在展开期间存在(收起即清理,不常驻)。
    useEffect(() => {
      if (!diagnosisOpen) return
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') setDiagnosisOpen(false)
      }
      const onClickOutside = (event: MouseEvent) => {
        const target = event.target as Element | null
        // 按钮、圆点、卡片自身(含卡片滚动条)不算「外部」,否则刚滚一下就关掉。
        if (target && typeof target.closest === 'function' && target.closest('.dsh-po-btn, .dsh-po-dot, .dsh-po-diagnosis')) return
        setDiagnosisOpen(false)
      }
      document.addEventListener('keydown', onKeyDown)
      document.addEventListener('click', onClickOutside)
      return () => {
        document.removeEventListener('keydown', onKeyDown)
        document.removeEventListener('click', onClickOutside)
      }
    }, [diagnosisOpen])

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
      // position:relative 是圆点与诊断卡的定位锚点(两者都 absolute 相对它摆放)。
      <span style={{ display: 'inline-flex', position: 'relative' }}>
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
          // 原生 title 始终保留:诊断不再由 hover 触发,不存在与自绘卡片打架的问题。
          title={title}
          aria-label={title}
          onClick={onClick}
        >
          {view === 'loading' ? <LoadingIcon /> : view === 'applied' ? <UndoIcon /> : <SparkleIcon />}
        </button>
        {showDot ? (
          // 独立 button(不是主按钮的子元素):6px 视觉圆点贴在按钮右上角外缘,
          // 点击只负责开关诊断卡,绝不冒泡到主按钮(否则会顺手发起一次优化)。
          <button
            className="dsh-po-dot"
            type="button"
            aria-label={diagnosisOpen ? t('button.closeDiagnosis') : t('button.dotLabel')}
            title={diagnosisOpen ? t('button.closeDiagnosis') : t('button.dotLabel')}
            aria-expanded={diagnosisOpen}
            onClick={(event) => {
              // 挡掉冒泡:既防止触发主按钮 onClick,也防止触达 document 的
              // 「点外部关闭」监听(否则同一次点击里先开后关)。
              event.stopPropagation()
              setDiagnosisOpen((open) => !open)
            }}
            style={{
              position: 'absolute',
              top: 1,
              right: 1,
              width: 6,
              height: 6,
              padding: 0,
              border: 'none',
              borderRadius: 999,
              background: 'var(--dsw-alias-state-business-primary, #4f7cf7)',
              cursor: 'pointer',
              // 盖在主按钮之上,保证 6px 圆点始终可点。
              zIndex: 1,
              lineHeight: 0,
            }}
          />
        ) : null}
        {diagnosisOpen && showDot && diagnosis ? <DiagnosisCard text={diagnosis} title={t('button.diagnosisTitle')} /> : null}
      </span>
    )
  }
}
