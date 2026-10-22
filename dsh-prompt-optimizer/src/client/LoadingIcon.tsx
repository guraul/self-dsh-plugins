/**
 * loading 转圈图标:一个开口圆环,线描风格与 DSH 官方图标一致
 * (`viewBox=24` / `fill=none` / `stroke=currentColor` / `strokeWidth=1.5`)。
 *
 * 旋转由注入样式表里的 CSS 动画 `.dsh-po-spin` 负责(`0.9s linear infinite`),
 * 不用 SVG `<animate>`:后者无法响应 `prefers-reduced-motion`,也会与 CSS
 * transform 抢同一个属性。
 */
export function LoadingIcon(props: { size?: number }) {
  const size = props.size ?? 14
  return (
    <svg
      className="dsh-po-icon dsh-po-spin"
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
      <path d="M12 3 a9 9 0 1 1 -6.36 2.64" />
    </svg>
  )
}
