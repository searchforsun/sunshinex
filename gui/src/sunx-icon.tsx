/** Sunx 专属图标(2026-11-15 用户裁定「单独的图标,即表示调度者身份又标识 bot/agent 身份」):
 *  机器人头(头框+双眼)+顶部三节点派发冠(hub 节点+双叶节点与辐条)——bot 身份由头/眼承载,
 *  调度者身份由顶冠扇出承载。lucide 视觉语言(24 栅格/圆帽描边/currentColor),随手用处传尺寸。 */
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
      {/* bot 头(圆角矩形+双眼点) */}
      <rect x="4.5" y="9.5" width="15" height="10" rx="3" />
      <path d="M9 15h.01" />
      <path d="M15 15h.01" />
      {/* 颈杆+派发冠:hub 节点→双辐条→双叶节点(调度扇出) */}
      <path d="M12 9.5V7.2" />
      <circle cx="12" cy="5.5" r="1.5" />
      <path d="M10.9 4.6 8.5 3.3" />
      <path d="m13.1 4.6 2.4-1.3" />
      <circle cx="7.7" cy="2.8" r="1" />
      <circle cx="16.3" cy="2.8" r="1" />
    </svg>
  );
}
