/**
 * 产物卡显隐开关(2026-11-16 用户裁定「设置页可以控制产物显隐开关」):关=正文轮末产物卡区
 * 整块不渲染(产物仍登记在 runmeta,产物库页签/回放/端点面不受影响——只收渲染层)。
 * 落根 html[data-artifact-cards],持久与其余外观偏好同通路(ui-pref-sync 双写);缺省「开」。
 * 状态机制在 ui-pref-boolean 工厂单点(D84 收敛:原手写克隆退役;反极性语义见该处 spec)。
 */
import { booleanPref } from './ui-pref-boolean';

const pref = booleanPref('artifactCards');

export const readArtifactCards = pref.readEffective;
export const applyArtifactCards = pref.apply;
export const useArtifactCards = pref.usePref;
