/**
 * 暗色气泡/暗色代码(2026-11-12 用户裁定,外观设置两项):亮色模式下两组面改用暗色主题色——
 * 暗色气泡=用户气泡;暗色代码=代码块/文件源码视图/工具行 diff 预览。
 * 落根 html[data-bubble-dark]/[data-code-dark](CSS 覆写块的切换面,只在 [data-theme='light']
 * 下生效=暗色主题下开关无感);持久与其余外观偏好同通路(ui-pref-sync 双写);缺省关。
 * 状态机制在 ui-pref-boolean 工厂单点(D84 收敛:原双键手写克隆退役为双实例)。
 */
import { booleanPref } from './ui-pref-boolean';

const bubbles = booleanPref('darkBubbles');
const code = booleanPref('darkCode');

export const readDarkBubbles = bubbles.readStored;
export const applyDarkBubbles = bubbles.apply;
export const readDarkCode = code.readStored;
export const applyDarkCode = code.apply;
