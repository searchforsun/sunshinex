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
  /** 在途归底调度(P1 Task 4):非 null=本动画帧已有待执行回调——后续渲染的 effect 直接跳过,
   *  同帧 N 次渲染只调度一次;回调内先清槽再判态(stick/锚旗读 flush 时值,滚轮放手即时生效) */
  const bottomRafRef = useRef<number | null>(null);
/** 流区贴底跟随(G13 反馈轮):贴底态下每次渲染(流式/条目增删/run 行)归底;上翻 >80px 放手,
 *  再触底恢复。useEffect 无依赖面=每渲染后跑,滚动判断在 onScroll 单点维护;上翻 80px 窗口
 *  内的滚轮失效由 Chat 的 wheel 意图直判兜住(渲染期归底赋值与用户滚动的竞争单点在 stick ref)。
 *  P1 Task 4 rAF 合并:scrollHeight 读取与 scrollTop 赋值收进动画帧——同帧多渲染调度一次,
 *  消灭逐渲染强制 reflow(布局读取与写入各至多每帧一次);回调内重核 stick,放手即弃 */
useEffect(() => {
  if (bottomRafRef.current !== null) return;
  bottomRafRef.current = requestAnimationFrame(() => {
    bottomRafRef.current = null;
    const el = chatScrollRef.current;
    // 聚合头锚定窗口（ToolGroups dataset 旗）内挂起贴底回钉——折叠/展开期间头钮逐帧自钉视口位
    if (el !== null && chatStickRef.current && el.dataset.groupAnchor !== '1') el.scrollTop = el.scrollHeight;
  });
});
// 卸载收尾:取消在途回调(挂载期一次性 cleanup;每渲染 cleanup 会在渲染间隙取消在途调度,
// 使在途守卫失效退回逐渲染调度——与 Produces 目标相悖,故不随渲染 effect 返回)
useEffect(() => () => {
  if (bottomRafRef.current !== null) cancelAnimationFrame(bottomRafRef.current);
}, []);

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
