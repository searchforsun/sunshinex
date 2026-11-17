/**
 * Sunx 产品标志族(2026-11-17 用户裁定「Sunx 的图标是产品名片,再优化一下;欢迎页要加上这个图标,
 * 和普通会话的产品图标分开」)。
 *
 * 语义沿 2026-11-15 裁定不变:bot/agent 身份由头框+双眼承载,调度者身份由顶冠扇出承载。
 * 四版形意修正(相对三版):
 *  - 实心承担视觉重量:双眼/hub/双叶点改**实心填充**(三版全描边圆在 14px 下线条叠线糊团,
 *    实心点在任何尺寸下都清晰)——小尺寸可辨性来自"点",描边只负责轮廓;
 *  - 侧耳退役:14px 下两条 1.5 单位短线纯噪声,去掉后头框呼吸更干净;
 *  - 头框改 squircle 比例(x3.5..20.5 / y8.5..21,rx4.5),垂直跨 2.9..21 占满栅格、四周余量
 *    均等(三版 y8..21.5 上缘仍偏空);
 *  - 冠部几何收正:hub 实心点居中,双辐条对称扇出、叶点收发于辐条端点,扇幅与头框等宽——
 *    一眼"一个调度者向下属节点分派",14px 下叶点不挤头肩。
 *
 * SunxMark = 同构形的 72 栅格名片版(欢迎页 hero / 创建弹窗头 / 空态卡),描边 2.75 与产品轨道标
 * WelcomeLogo 同语速;两版共用同一套几何语言,近看远看是同一个标志。
 */

/** 小尺寸字形(14/16px 侧栏、组头、入口卡、工具行同族):24 栅格 / lucide 语汇 */
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
      {/* bot 头(squircle 满栅格) */}
      <rect x="3.5" y="8.5" width="17" height="12.5" rx="4.5" />
      {/* 双眼(实心点,任意尺寸清晰) */}
      <circle cx="9.2" cy="14.8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="14.8" r="1.2" fill="currentColor" stroke="none" />
      {/* 颈杆+调度冠(宽扇定版):hub 实心 → 双辐条 → 双叶点实心;扇幅与头框等宽(叶点 cx 6.7/17.3
          对齐头框 x3.5..20.5 的内收线),14px 下叶点不被头肩挤成一团 */}
      <path d="M12 8.5V7.4" />
      <circle cx="12" cy="5.9" r="1.8" fill="currentColor" stroke="none" />
      <path d="M10.75 4.9 7.7 3.4" />
      <path d="m13.25 4.9 3.05-1.5" />
      <circle cx="6.7" cy="2.9" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="17.3" cy="2.9" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 名片版大标(72 栅格):欢迎页 hero / 新建弹窗头 / 空态卡——与 WelcomeLogo 同描边语速(2.75),
 *  尺寸随 size(CSS 控色 currentColor) */
export function SunxMark({ size = 100, strokeWidth = 2.75, className }: { size?: number; strokeWidth?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* bot 头(squircle,与字形同比例放大) */}
      <rect x="15" y="28" width="42" height="31" rx="10.5" />
      {/* 双眼(实心) */}
      <circle cx="29.5" cy="43.5" r="3.1" fill="currentColor" stroke="none" />
      <circle cx="42.5" cy="43.5" r="3.1" fill="currentColor" stroke="none" />
      {/* 颈杆+调度冠(与字形同构宽扇:实心 hub → 双辐条 → 实心叶点) */}
      <path d="M36 28v-4.9" />
      <circle cx="36" cy="17.7" r="5.2" fill="currentColor" stroke="none" />
      <path d="M31.5 15.1 23.1 10.4" />
      <path d="m40.5 15.1 8.4-4.7" />
      <circle cx="20" cy="8.6" r="3.6" fill="currentColor" stroke="none" />
      <circle cx="52" cy="8.6" r="3.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
