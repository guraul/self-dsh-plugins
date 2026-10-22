/**
 * 线性描边四芒星(AI / 魔法语义)。对齐 DSH 官方图标的视觉语言:
 * `viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、细描边 + 圆角连接,
 * 因此放在官方工具行里与相邻图标同一笔画粗细,不像实心色块那样抢眼。
 *
 * strokeWidth 取 1.5:官方是 1px @24,而这里固定 14px 显示;按 24/14 折算
 * 1.5 在视觉上最接近官方 1px 的观感。
 *
 * 只负责 idle / error 两态(loading 用 LoadingIcon、applied 用 UndoIcon);
 * 旋转动画在注入样式表的 `.dsh-po-spin` 里,不用 SVG `<animate>`。
 */
export function SparkleIcon(props: { size?: number }) {
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
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      // pointer-events:none 让点击始终落在按钮本身(loading 中点击 = 取消、
      // applied 中点击 = 还原,不能被子元素吞掉)。
      style={{ display: 'block', flexShrink: 0, pointerEvents: 'none' }}
    >
      {/* 单颗四芒星:四个尖角 + 内凹的四条边(贝塞尔控制点向中心收)。 */}
      <path d="M12 2.75 C12.55 7.6 16.4 11.45 21.25 12 C16.4 12.55 12.55 16.4 12 21.25 C11.45 16.4 7.6 12.55 2.75 12 C7.6 11.45 11.45 7.6 12 2.75 Z" />
    </svg>
  )
}
