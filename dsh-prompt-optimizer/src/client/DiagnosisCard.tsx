/**
 * 诊断浮卡:鼠标悬停(或键盘聚焦)按钮时,把最近一次优化产出的「诊断分析」
 * 浮在按钮上方显示。结果面板移除后,full 模式的诊断靠它保留可读性,
 * 同时**绝不写进输入框**(发送内容永远只有优化稿)。
 *
 * 设计要点:
 * - `position:absolute` + `bottom:calc(100% + 8px)` + `right:0`:相对按钮定位,
 *   向右对齐 —— 按钮在工具行右端,向左展开会溢出视口右侧。
 * - `pointer-events:none`:浮卡不吞鼠标事件,否则鼠标一进入卡片就触发
 *   `mouseleave` → 卡片消失 → 鼠标又回到按钮 → 卡片出现,来回闪烁。
 *   代价:`overflowY:auto` 的滚动条**永远拖不动**(没有事件),内容超过 `maxHeight`
 *   时会被静默裁掉。诊断格式是有界的「维度 | 问题 | 建议」逐条一行(≤5 条),
 *   320px 足够容纳;真出现超长文本,优先改 portal + 可滚动,而不是去掉 pointer-events。
 * - `whiteSpace:pre-wrap`:诊断是「维度 | 问题 | 建议」逐行文本,换行必须保留。
 * - 颜色一律走 DSW 令牌,并给非 web 环境/老宿主留回落值。
 *
 * 纯展示组件(不取 hooks):`title` 由调用方的 `useT()` 传入,便于用最小渲染器
 * 直接驱动它做行为探针。
 */
export function DiagnosisCard(props: { text: string; title: string }) {
  return (
    <div
      className="dsh-po-diagnosis"
      role="tooltip"
      style={{
        position: 'absolute',
        // 浮在按钮上方 8px;右对齐按钮(工具行在右侧,向左展开才不溢出)。
        bottom: 'calc(100% + 8px)',
        right: 0,
        zIndex: 2147483000,
        // 不挡点击:卡片自己吞事件会导致 hover 闪烁。
        pointerEvents: 'none',
        maxWidth: 360,
        maxHeight: 320,
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
