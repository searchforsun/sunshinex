/**
 * 会话信息卡显隐开关(2026-11-17 用户裁定「会话信息卡,也在普通模式下不显示,开发者默认开,同样放到 diff 下」):
 * 关=侧栏会话行悬浮信息卡(会话名/路径/分支/轮次步数/建档时刻)不渲染。纯 store 形(不落根属性)。
 * 状态机制在 ui-pref-boolean 工厂单点(D84 收敛:原手写克隆退役;普通态恒关语义见该处 spec)。
 */
import { booleanPref } from './ui-pref-boolean';

const pref = booleanPref('sessionInfoCards');

export const readSessionInfoCards = pref.readEffective;
export const applySessionInfoCards = pref.apply;
export const useSessionInfoCards = pref.usePref;
