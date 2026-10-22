/**
 * 撤回图标:逆时针回环箭头(⤺ 语义),同一套线性风格
 * (`viewBox=24` / `fill=none` / `stroke=currentColor` / `strokeWidth=1.5` / 圆角端点)。
 *
 * 语义:替换已完成、点一下还原原草稿。宽度与四芒星、转圈图标一致(同为 14px),
 * 三种状态切换时按钮宽度不抖动。
 */
export function UndoIcon(props: { size?: number }) {
  const size = props.size ?? 14
  return (
    <svg
      className="dsh-po-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0, pointerEvents: 'none' }}
    >
      {/* 回环:从左侧开口处逆时针绕一圈。 */}
      <path d="M3 12 a9 9 0 1 0 3-6.7" />
      {/* 箭头头部:指向左上,呼应「回退」。 */}
      <path d="M3 4 v5 h5" />
    </svg>
  )
}
