/**
 * 诊断卡:点击按钮右上角圆点后,把最近一次优化产出的「诊断分析」
 * 固定浮在按钮上方显示。结果面板移除后,full 模式的诊断靠它保留可读性,
 * 同时**绝不写进输入框**(发送内容永远只有优化稿)。
 *
 * 设计要点:
 * - `position:absolute` + `bottom:calc(100% + 8px)` + `right:0`:相对按钮定位,
 *   向右对齐 —— 按钮在工具行右端,向左展开会溢出视口右侧。
 * - `pointer-events:auto`:卡片是可交互的固定层。之前 hover 版必须 `none`(否则
 *   鼠标一进卡片就 mouseleave → 卡片消失 → 来回闪烁),代价是滚动条拖不动、
 *   文字选不中。改成点击展开后这个约束消失,滚动与复制都要能用。
 * - `maxHeight:400` + `overflowY:auto`:诊断是「维度 | 问题 | 建议」三列文本,
 *   360px 宽下每行会折成 3–4 行,5 个维度足以超出 320px;400px 起步,超出可滚。
 * - `whiteSpace:pre-wrap`:诊断是逐行文本,换行必须保留(不做三列 grid:
 *   逐格复制会把一行拆成多个片段,复制保真度优先于对齐)。
 * - `role="dialog"`:不再是只读 tooltip —— 它可以获得焦点、滚动、选中复制。
 * - 颜色一律走 DSW 令牌,并给非 web 环境/老宿主留回落值。
 *
 * 纯展示组件(不取 hooks):`title` 由调用方的 `useT()` 传入,便于用最小渲染器
 * 直接驱动它做行为探针。
 */
export function DiagnosisCard(props: { text: string; title: string }) {
  return (
    <div
      className="dsh-po-diagnosis"
      role="dialog"
      aria-label={props.title}
      // 可聚焦:键盘用户 Tab 进来后能用方向键 / PageDown 滚动卡片内容。
      tabIndex={0}
      style={{
        position: 'absolute',
        // 浮在按钮上方 8px;右对齐按钮(工具行在右侧,向左展开才不溢出)。
        bottom: 'calc(100% + 8px)',
        right: 0,
        zIndex: 2147483000,
        // 可交互层:能滚动、能选中复制(点击展开后不再有 hover 闪烁问题)。
        pointerEvents: 'auto',
        maxWidth: 360,
        maxHeight: 400,
        overflowY: 'auto',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.2))',
        background: 'var(--dsw-alias-bg-elevated, #fff)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        // 诊断是逐行文本(维度 | 问题 | 建议),必须保留换行。
        whiteSpace: 'pre-wrap',
        // 长英文/长 URL 不撑破 360px 宽度。
        wordBreak: 'break-word',
        textAlign: 'left',
        cursor: 'default',
        // 让卡片内的滚动不带动外层对话区。
        overscrollBehavior: 'contain',
      }}
    >
      <div
        style={{
          marginBottom: 4,
          fontWeight: 600,
          color: 'var(--dsw-alias-label-primary, inherit)',
        }}
      >
        {props.title}
      </div>
      {props.text}
    </div>
  )
}
