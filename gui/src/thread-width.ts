/**
 * 主对话区限宽阶梯（D42 自 App.tsx 外提，单一实现）：分级的是最大宽度档位，不是最小宽度
 * ——880 是常态平台档，窄端只由主区自身最小宽托底，不参与分级。区宽 ≤912 满宽（两侧 18px
 * 等宽）；至 1120 平台 880；1120→1200 坡到 960；至 1360 平台 960；1360→1520 坡到 1120 封顶。
 * 段间线性坡道，两坡斜率同为 1，全程连续无跳变。
 */

const THREAD_FILL_MAX = 912; // 满宽上界:区宽到此处列宽恰为 880,与第一档平台接续
const THREAD_COL_BASE = 880; // 第一档最大宽度(常态档,旧定版值)
const THREAD_STEP_1 = 960; // 第二档最大宽度
const THREAD_COL_MAX = 1120; // 封顶档最大宽度
const THREAD_RAMP_1_AT = 1120; // 第一坡道起点(区宽)
const THREAD_RAMP_2_AT = 1360; // 第二坡道起点(区宽)
const THREAD_RAMP_1 = 80; // 第一坡道区宽跨度(880→960,斜率 1)
const THREAD_RAMP_2 = 160; // 第二坡道区宽跨度(960→1120 档距大,坡道等比拉宽保斜率 1)

/** 区宽 → 流列最大宽度(--chat-max 落值;档位/坡道见上文件头注释) */
export function chatMaxFor(w: number): number {
  if (w <= THREAD_FILL_MAX) return Math.max(0, w - 32);
  if (w <= THREAD_RAMP_1_AT) return THREAD_COL_BASE;
  if (w <= THREAD_RAMP_1_AT + THREAD_RAMP_1) {
    return THREAD_COL_BASE + ((w - THREAD_RAMP_1_AT) / THREAD_RAMP_1) * (THREAD_STEP_1 - THREAD_COL_BASE);
  }
  if (w <= THREAD_RAMP_2_AT) return THREAD_STEP_1;
  if (w <= THREAD_RAMP_2_AT + THREAD_RAMP_2) {
    return THREAD_STEP_1 + ((w - THREAD_RAMP_2_AT) / THREAD_RAMP_2) * (THREAD_COL_MAX - THREAD_STEP_1);
  }
  return THREAD_COL_MAX;
}

/** 主对话区最小宽(.sx-main min-width 同值)——三栏拖拽的公共约束:被拖栏可加宽的上界=
 *  视口−另两栏−此值(中栏触底即停,任何栏不越视口;无固定最大宽,用户裁定)。
 *  2026-10-24 用户裁定 440→320:模式 pill 窄端塌缩为纯图标后 composer 窄端可用,取 320;
 *  CSS 侧 .sx-main min-width 与两处 max-width calc 的减数同值联动改 */
export const MAIN_MIN_WIDTH = 320;
