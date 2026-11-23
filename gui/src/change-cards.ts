/**
 * 改动卡显隐开关(2026-11-17 用户裁定「产物卡下面显示一个改动卡,普通模式下不显示,开发者模式默认是打开的,
 * 显示 diff 卡条」):关=正文轮末改动卡条(RunChangesBar)整块不渲染——改动仍登记在 runmeta,
 * 审查页/回放/端点面不受影响(只收渲染层)。纯 store 形(不落根属性)。
 * 状态机制在 ui-pref-boolean 工厂单点(D84 收敛:原手写克隆退役;普通态恒关语义见该处 spec)。
 */
import { booleanPref } from './ui-pref-boolean';

const pref = booleanPref('changeCards');

export const readChangeCards = pref.readEffective;
export const applyChangeCards = pref.apply;
export const useChangeCards = pref.usePref;
