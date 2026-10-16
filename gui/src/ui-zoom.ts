/**
 * 界面放缩(通用·界面与外观;本轮新增):根节点(html)zoom 全局等比缩放——字体/图标/布局/
 * 圆角/阴影同处一个缩放域,zoom 继承全域生效,无「放缩部分」不协调面。localStorage
 * ['sunshinex.ui-zoom'] 持久(与 theme.ts 同款 GUI 本地偏好;daemon/CLI 无放缩概念,不进
 * settings.json)。
 * 跨空间换算契约(zoom≠1 时的唯一坑,全局盘点结论):视口空间(gBCR/innerWidth/client 坐标,
 * 视觉 px)与元素本地空间(样式 px/scrollTop 等布局值 = 视觉/zoom)出现系数差——凡「视觉测量
 * 写入本地样式」处一律经 zoomScale() 归一(消费点:main.tsx 悬浮提示 tip 自身 zoom=1 不缩、
 * context-ring 弹层越界回推、Files 选区工具条定位、Chat dock 余垫/滚动校正/mermaid 盘点)。
 */
export type UiZoom = '0.9' | '1' | '1.1' | '1.25' | '1.5';

const KEY = 'sunshinex.ui-zoom';
const VALID: readonly string[] = ['0.9', '1', '1.1', '1.25', '1.5'];

export function readZoomPref(): UiZoom {
  try {
    const v = localStorage.getItem(KEY);
    return VALID.includes(v ?? '') ? (v as UiZoom) : '1';
  } catch {
    return '1';
  }
}

export function applyZoom(pref: UiZoom): void {
  document.documentElement.style.zoom = pref === '1' ? '' : pref;
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
  // 画布面(xterm/monaco)重排通知:zoom 变更改变布局尺寸,容器尺寸观测面即刻重算
  window.dispatchEvent(new Event('resize'));
}

/** 当前根放缩系数(视觉 px → 本地 px 换算除数;未开启=1) */
export function zoomScale(): number {
  return parseFloat(document.documentElement.style.zoom || '1') || 1;
}
