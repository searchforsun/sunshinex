/**
 * computer-use 插件契约镜像单点(2026-10-27 技术债轮 G3/G4 收敛):顶栏「正在控制」徽标判定面
 * 与工具行专属图标前缀共用的 server 名/动作集常量。权威源 = plugins/computer-use/plugin.json 的
 * safety.act 声明(跨包字面量镜像,无构建期生成);computer-use-badge.test 读真 manifest 与本表
 * 对拍——插件侧 id/动作集变更不更新本件即测红,徽标/图标不再可能静默失明。
 * screenshot=confirm(观察)、uia_snapshot/window_list=observe(读)、wait/wait_for(被动等待)
 * 均非「控制」,不点亮。
 */
export const COMPUTER_USE_SERVER = 'computer-use';
export const COMPUTER_USE_ACT_TOOLS: ReadonlySet<string> = new Set(['click', 'type', 'key', 'scroll', 'drag', 'app']);
export const COMPUTER_USE_PREFIX = `mcp__${COMPUTER_USE_SERVER}__`;

/** 工具名 → 是否为电脑控制类动作(`mcp__computer-use__<act>`) */
export function isComputerUseControlTool(name: string | undefined): boolean {
  return name !== undefined && name.startsWith(COMPUTER_USE_PREFIX) && COMPUTER_USE_ACT_TOOLS.has(name.slice(COMPUTER_USE_PREFIX.length));
}
