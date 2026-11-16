/** Sunx 专属图标(2026-11-15 用户裁定「即表示调度者身份又标识 bot/agent 身份」;同日二轮:
 *  「要和其他对齐,不然 14px 的图标太小了」——满栅格构图;2026-11-16 三轮:「图标没有完全
 *  占用整个图的面积,上面太挤了,看不清」——三版定稿:头框再下压满栅格(y8→21.5,rx4),冠部
 *  减素(hub+双辐条圆帽收尾,独立叶圈删除——14px 下 r1.1 双圈亚像素糊团=「上面太挤」根源),
 *  垂直跨 3.1→21.5 与 lucide 满栅格标准(~2→22)对齐,余量均匀不再上挤下空)。bot 身份由
 *  头/眼承载,调度者身份由顶冠扇出承载。lucide 视觉语言(24 栅格/圆帽描边/currentColor)。 */
export function SunxIcon({ size = 16, strokeWidth = 1.75, className }: { size?: number; strokeWidth?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* bot 头(圆角矩形撑满栅格+双眼点)+侧耳 */}
      <rect x="3" y="8" width="18" height="13.5" rx="4" />
      <path d="M2.5 14.5h1.5" />
      <path d="M21.5 14.5H20" />
      <path d="M9.25 15h.01" />
      <path d="M14.75 15h.01" />
      {/* 颈杆+派发冠:hub 节点→双辐条(圆帽收尾即叶,三版减素——14px 不再挤成一团) */}
      <path d="M12 8V6.7" />
      <circle cx="12" cy="4.9" r="1.8" />
      <path d="M10.8 3.9 8.2 2.4" />
      <path d="m13.2 3.9 2.6-1.5" />
    </svg>
  );
}
