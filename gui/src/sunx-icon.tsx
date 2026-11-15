/** Sunx 专属图标(2026-11-15 用户裁定「即表示调度者身份又标识 bot/agent 身份」;同日二轮:
 *  「要和其他对齐,不然 14px 的图标太小了」——满栅格构图修正:头框/顶冠撑满 24 栅格,同尺寸
 *  渲染下与相邻图标等大)。机器人头(头框+双眼)+顶部三节点派发冠(hub+双辐条双叶)——bot 身份
 *  由头/眼承载,调度者身份由顶冠扇出承载。lucide 视觉语言(24 栅格/圆帽描边/currentColor)。 */
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
      <rect x="3" y="7.5" width="18" height="13" rx="3.5" />
      <path d="M2.5 13.5h1.5" />
      <path d="M21.5 13.5H20" />
      <path d="M9 14.5h.01" />
      <path d="M15 14.5h.01" />
      {/* 颈杆+派发冠:hub 节点→双辐条→双叶节点(调度扇出,叶点触栅格上缘) */}
      <path d="M12 7.5V6.4" />
      <circle cx="12" cy="4.5" r="1.9" />
      <path d="M10.7 3.4 7.6 2" />
      <path d="m13.3 3.4 3.1-1.4" />
      <circle cx="6.7" cy="1.7" r="1.1" />
      <circle cx="17.3" cy="1.7" r="1.1" />
    </svg>
  );
}
