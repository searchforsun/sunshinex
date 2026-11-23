/**
 * 用量统计显隐开关(2026-11-14 用户裁定「设置页加开关,gui 控制显示步数轮次和 tokens」):
 * 控制面=①上下文圆环弹层具体数字(关=只留百分比,首行总量恒显;轮次/步数行关=整行隐)
 * ②轮尾操作条步数+tokens ③运行状态行(主对话/子智能体转录页同件)步数+tokens
 * ④会话悬停卡/行 tooltip 轮次步数段。落根 html[data-usage-stats],持久与其余外观偏好同通路
 * (ui-pref-sync 双写);2026-11-17 起缺省「关」——普通态恒关,开发者模式开=存储值。
 * 状态机制在 ui-pref-boolean 工厂单点(D84 收敛:原手写克隆退役;反极性/派生语义见该处 spec)。
 */
import { booleanPref } from './ui-pref-boolean';

const pref = booleanPref('usageStats');

export const readUsageStats = pref.readEffective;
export const applyUsageStats = pref.apply;
export const useUsageStats = pref.usePref;
