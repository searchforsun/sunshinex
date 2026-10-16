import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyZoom, readZoomPref } from './ui-zoom';
import './app.css';

/**
 * G3 挂载点：App 自装配（无 props）——token 门面（URL ?token= / localStorage 持久）与
 * 连接装配（VITE_SERVE_URL 缺省 location.origin）都在 App 内单点；此处只挂 root。
 */
// 界面放缩先于挂载落根节点(通用·界面与外观;根 zoom 全域等比,见 ui-zoom.ts)
applyZoom(readZoomPref());
const root = document.getElementById('root');
if (root === null) throw new Error('gui: #root not found');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// G14.74b 全局悬浮提示：单例 fixed 气泡（完全不参与布局——伪元素气泡在 hover 期参与布局，
// 会把滚动容器撑出假滚动条）。随锚点视口定位：上方优先、放不下翻下方、左右夹持不出窗；
// 滚动/改窗即隐；data-tip 变化（如复制→已复制）经 MutationObserver 实时跟字
(() => {
  let tip: HTMLDivElement | null = null;
  let anchor: Element | null = null;
  let obs: MutationObserver | null = null;
  const place = (): void => {
    if (tip === null || anchor === null) return;
    tip.textContent = anchor.getAttribute('data-tip') ?? '';
    tip.style.zoom = '1'; // 提示泡不随根放缩:自身视口空间,与 gBCR/innerWidth 同域——定位数学保持零换算
    tip.style.left = '0px';
    tip.style.top = '0px';
    const r = anchor.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    // G14.106/G14.188 data-tip-pos="right":贴侧栏右缘(主对话左缘)垂直居中——不盖会话行(用户裁定)
    if (anchor.getAttribute('data-tip-pos') === 'right') {
      const menu = anchor.closest('.sx-menu');
      const edge = menu !== null ? menu.getBoundingClientRect().right + 12 : r.right + 8;
      let left = edge;
      left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
      let top = r.top + r.height / 2 - tr.height / 2;
      top = Math.max(8, Math.min(top, window.innerHeight - tr.height - 8));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
      return;
    }
    const below = r.top < tr.height + 10;
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(Math.max(8, below ? r.bottom + 6 : r.top - tr.height - 6))}px`;
  };
  const hide = (): void => {
    if (tip !== null) tip.remove();
    tip = null;
    anchor = null;
    obs?.disconnect();
    obs = null;
  };
  document.addEventListener('mouseover', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (t === null || t.getAttribute('data-tip') === '' || t === anchor) return;
    hide();
    anchor = t;
    tip = document.createElement('div');
    tip.id = 'global-tip';
    document.body.appendChild(tip);
    place();
    obs = new MutationObserver(place);
    obs.observe(t, { attributes: true, attributeFilter: ['data-tip'] });
  });
  document.addEventListener('mouseout', (e) => {
    const from = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-tip]') : null;
    if (from !== null && from === anchor && to !== anchor) hide();
  });
  window.addEventListener('scroll', hide, { capture: true, passive: true });
  window.addEventListener('resize', hide);
  // G14.201 锚点卸载残留:悬停中锚点被 React 移除(展开侧边栏后按钮卸载)时 mouseout 不可靠——
  // DOM 一变即校验锚点是否仍在文档,不在即隐(否则 tooltip 残留盖内容)
  const domObs = new MutationObserver(() => {
    if (anchor !== null && !anchor.isConnected) hide();
  });
  domObs.observe(document.body, { childList: true, subtree: true });
})();
