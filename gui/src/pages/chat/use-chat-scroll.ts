import { useEffect, useRef } from 'react';
import { zoomScale } from '../../ui-zoom';
import type { MutableRefObject } from 'react';

/** 滚动跟随/存档恢复/mermaid 补归底/dock 高度实测四 effects(D32 第六批批F-5 自 Chat.tsx 平移,
 *  行为零变化)。refs 留宿主声明(滚动 handler/存档键消费),dockRef 因 JSX 消费由本 hook 返还。 */
export function useChatScroll(deps: {
  readonly chatScrollRef: MutableRefObject<HTMLElement | null>;
  readonly chatStickRef: MutableRefObject<boolean>;
  readonly scrollRestoreRef: MutableRefObject<number | null>;
  readonly seeding: boolean;
  readonly entriesLen: number;
}): { dockRef: MutableRefObject<HTMLDivElement | null> } {
  const { chatScrollRef, chatStickRef, scrollRestoreRef, seeding, entriesLen } = deps;
/** 流区贴底跟随(G13 反馈轮):贴底态下每次渲染(流式/条目增删/run 行)归底;上翻 >80px 放手,
 *  再触底恢复。useEffect 无依赖面=每渲染后跑,滚动判断在 onScroll 单点维护 */
useEffect(() => {
  const el = chatScrollRef.current;
  if (el !== null && chatStickRef.current) el.scrollTop = el.scrollHeight;
});

/** G14.212/G14.213 存档位恢复:种子落定(非 seeding 且条目非空)后 rAF 收敛滚动到存档距底位。
 *  内容尚不足高(mermaid/代码高亮等懒渲染还在撑)不硬落——clamp 会错落到顶;逐帧等到位再落,
 *  1.5s 超时按当时可达位兜底(贴底跟随已由 stick=false 挂起,等待期无人争滚动) */
useEffect(() => {
  const d = scrollRestoreRef.current;
  if (d === null || seeding || entriesLen === 0) return;
  scrollRestoreRef.current = null;
  let raf = 0;
  const t0 = Date.now();
  const step = (): void => {
    const el = chatScrollRef.current;
    if (el === null) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max < d && Date.now() - t0 < 1500) {
      raf = requestAnimationFrame(step);
      return;
    }
    el.scrollTop = Math.min(d, max);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}, [seeding, entriesLen]);

/** G14.2xx mermaid 异步撑高补归底:图渲染落定是 Mermaid 组件内 state,不触发本组件重渲染,
 *  上方逐渲染归底收不到信号——监听落定广播,贴底态 rAF 合并补归底(进场多图连发只归一次) */
useEffect(() => {
  let raf = 0;
  const onSettled = (): void => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const el = chatScrollRef.current;
      if (el !== null && chatStickRef.current) el.scrollTop = el.scrollHeight;
    });
  };
  window.addEventListener('sx-mermaid-settled', onSettled);
  return () => {
    window.removeEventListener('sx-mermaid-settled', onSettled);
    cancelAnimationFrame(raf);
  };
}, []);


/** G14.87 dock 高度实测驱动正文底部 padding:队列展开/textarea 增行使 dock 长高,
 *  固定 padding(132px)下 dock 会盖住正文尾行——ResizeObserver 把实测高度写进 .chat
 *  padding-bottom,正文整体上移不被遮;卸载复原 CSS 缺省 */
const dockRef = useRef<HTMLDivElement | null>(null);
useEffect(() => {
  const chat = chatScrollRef.current;
  const dock = dockRef.current;
  if (chat === null || dock === null || typeof ResizeObserver === 'undefined') return; // jsdom 无 RO:测试态跳过
  const sync = (): void => {
    // dock 高是视觉 px(gBCR),padding 写本地空间=视觉/根放缩(ui-zoom.ts 契约)
    chat.style.paddingBottom = `calc(var(--thread-gutter) + ${Math.ceil(dock.getBoundingClientRect().height / zoomScale()) + 18}px)`;
  };
  sync();
  const ro = new ResizeObserver(sync);
  ro.observe(dock);
  return () => {
    ro.disconnect();
    chat.style.paddingBottom = '';
  };
}, []);
  return { dockRef };
}
