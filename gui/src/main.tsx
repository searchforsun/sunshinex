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
    tip.style.zoom = '1'; // 提示泡不随根放缩:自身视口空间
    tip.style.left = '0px';
    tip.style.top = '0px';
    const r = anchor.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    // 意图视觉位(与 gBCR/innerWidth 同域)
    let iv: number;
    let it: number;
    // G14.106/G14.188 data-tip-pos="right":贴侧栏右缘(主对话左缘)垂直居中——不盖会话行(用户裁定);
    // 2026-10-24 用户裁定 12→4:紧贴边线,不探入正文
    if (anchor.getAttribute('data-tip-pos') === 'right') {
      const menu = anchor.closest('.sx-menu');
      const edge = menu !== null ? menu.getBoundingClientRect().right + 4 : r.right + 8;
      iv = Math.max(8, Math.min(edge, window.innerWidth - tr.width - 8));
      it = Math.max(8, Math.min(r.top + r.height / 2 - tr.height / 2, window.innerHeight - tr.height - 8));
    } else {
      // 2026-10-24 用户裁定:默认显示在锚点上方;顶层元素(顶部无空间,下方有)翻到下方;
      // 特殊侧面位走 data-tip-pos="right"(既有)。旧实现 below 算而未用恒取 max=恒下方,此为根因
      const below = r.top < tr.height + 10;
      iv = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 8));
      it = Math.max(8, below ? r.bottom + 6 : r.top - tr.height - 6);
    }
    it = Math.max(8, Math.min(it, window.innerHeight - tr.height - 8));
    // 先落意图位→回测实际视觉位→本地 px 一次性补差:根 zoom≠1 时 Chromium 对 fixed 偏移乘根
    // 缩放(2026-10-24 用户实测桌面 zoom1.1 下 tooltip 探入正文),此校正对任何缩放模型恒精确
    tip.style.left = `${Math.round(iv)}px`;
    tip.style.top = `${Math.round(it)}px`;
    const ar = tip.getBoundingClientRect();
    tip.style.left = `${Math.round(parseFloat(tip.style.left) + iv - ar.left)}px`;
    tip.style.top = `${Math.round(parseFloat(tip.style.top) + it - ar.top)}px`;
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

// 2026-10-24 用户裁定(实测驱动,无固定切割线):composer 底栏溢出管理器——三处 composer
// (主 dock/欢迎/辅助对话同走 ComposerCard 的 .sx-composer-foot)统一监听:溢出>1px 挂
// pills-tight(收「完全访问」标签/箭头与 effort 徽标,模型名转右缘渐隐省略);无溢出且距上次
// 切换>400ms 时试摘(摘后复溢会被下一帧 RO 再挂,400ms 最小保持防抖)。
(() => {
  const managed = new WeakSet<Element>();
  let lastToggle = 0;
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) judge(entry.target as HTMLElement);
  });
  const judge = (el: HTMLElement): void => {
    const over = el.scrollWidth - el.clientWidth;
    const tight = el.classList.contains('pills-tight');
    if (!tight && over > 1) {
      el.classList.add('pills-tight');
      lastToggle = Date.now();
    } else if (tight && over <= 1 && Date.now() - lastToggle > 400) {
      el.classList.remove('pills-tight'); // 试摘:摘后复溢由下一帧 RO 再挂(宽容差回收)
      lastToggle = Date.now();
    }
  };
  const scan = (): void => {
    for (const foot of document.querySelectorAll('.sx-composer-foot')) {
      if (managed.has(foot)) continue;
      managed.add(foot);
      ro.observe(foot);
      judge(foot);
    }
  };
  const mo = new MutationObserver(() => scan());
  mo.observe(document.body, { childList: true, subtree: true });
  scan();
})();
