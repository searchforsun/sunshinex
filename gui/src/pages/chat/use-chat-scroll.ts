import { useEffect, useRef } from 'react';
import { zoomScale } from '../../ui-zoom';
import type { MutableRefObject } from 'react';

/** 程序贴底写入登记(2026-10-31 跟随闩二修):跟随类写入(scrollTop=scrollHeight,被浏览器钳到
 *  当帧 max)落点登记于此,scroll 事件里 scrollTop 命中登记值=程序位移而非用户位移——跟随闩
 *  不得据此释放。为何不用「scrollTop 较上次事件位移」判用户:Chromium 把写入事件与同帧内容
 *  生长合并成一次派发,事件同时携带程序位移与 dist 虚增,位移门照样误释放(实机探针复现,
 *  正文流式必现)。ε=1.5:zoom 树下钳位亚像素残差不算用户位移 */
const progBottom = new WeakMap<HTMLElement, number>();
export function markProgBottom(el: HTMLElement): void {
  progBottom.set(el, Math.max(0, el.scrollHeight - el.clientHeight));
}
function isProgBottom(el: HTMLElement, top: number): boolean {
  const v = progBottom.get(el);
  return v !== undefined && Math.abs(top - v) <= 1.5;
}
export { isProgBottom };

/** 贴底跟随期的锚定模式(2026-10-31 跟随闩三修联动手):stick 期间关 .chat 的 scroll anchoring
 *  ——流式中估算高校正触发的锚定回拉(原生改 scrollTop,不经 setter=绕过一切写入日志)是跟随
 *  死亡头号杀手(实机探针:一轮内 -796px 回拉即脱闩,关 anchoring 后 322 次跟随写入零断);
 *  阅读期(stick=false)恢复 auto=G14.211 视口稳定契约不动。CSS 缺省 auto 即阅读态 */
export function syncOverflowAnchor(el: HTMLElement, stick: boolean): void {
  const want = stick ? 'none' : '';
  if (el.style.overflowAnchor !== want) el.style.overflowAnchor = want;
}

/** 滚动跟随/存档恢复/mermaid 补归底/dock 高度实测四 effects(D32 第六批批F-5 自 Chat.tsx 平移,
 *  行为零变化)。refs 留宿主声明(滚动 handler/存档键消费),dockRef 因 JSX 消费由本 hook 返还。 */
export function useChatScroll(deps: {
  readonly chatScrollRef: MutableRefObject<HTMLElement | null>;
  readonly chatStickRef: MutableRefObject<boolean>;
  readonly scrollRestoreRef: MutableRefObject<number | null>;
  readonly seeding: boolean;
  readonly entriesLen: number;
  /** 前台态(2026-11-18 keep-alive):隐藏期间 composer/顶栏不渲染、容器零尺寸——切回时须
   *  ①重测 dock 高写 padding-bottom(否则正文尾行/运行行被输入卡盖住,滚不到底)
   *  ②恢复隐藏前滚动位(display:none 期间 scrollTop 被浏览器钳位) */
  readonly active?: boolean;
  /** 虚拟窗口锚式恢复接管(2026-11-18):true=距底恢复不写 scrollTop(总高为估算值,反推不可靠;
   *  MessageList 按块坐标落点),只清存档位 */
  readonly skipRestore?: boolean;
  /** 贴底重贴静默窗(2026-11-18 落点固化):切回驻留座的锚式/距底恢复期间,高度瞬态塌陷会让
   *  dist<4 一次而把闩翻回 follow=贴底,恢复写完又被逐渲染贴底 effect 拽到底——读取位被吃掉
   *  (用户实测「每次回来都是底部」)。窗口期内 handleChatScroll/归底 effect 都不得重贴 */
  readonly stickSuppressRef?: MutableRefObject<boolean>;
  /** 最近一次滚动事件的距底值(2026-11-18 落点固化):display:none 后元素几何全零,切走当拍
   *  读不到真实位置——用滚动期持续更新的镜像代替隐藏态读取 */
  readonly lastDistRef?: MutableRefObject<number>;
}): { dockRef: MutableRefObject<HTMLDivElement | null> } {
  const { chatScrollRef, chatStickRef, scrollRestoreRef, seeding, entriesLen, active = true, skipRestore = false, stickSuppressRef, lastDistRef } = deps;
  /** 在途归底调度(P1 Task 4):非 null=本动画帧已有待执行回调——后续渲染的 effect 直接跳过,
   *  同帧 N 次渲染只调度一次;回调内先清槽再判态(stick/锚旗读 flush 时值,滚轮放手即时生效) */
  const bottomRafRef = useRef<number | null>(null);
/** 流区贴底跟随(G13 反馈轮):贴底态下每次渲染(流式/条目增删/run 行)归底;离开底缘即放手
 *  (Chat onScroll:仅距底 <4 重贴,避免旧 80px 磁区在上滑后被 scroll 抢回)。useEffect 无依赖面
 *  =每渲染后跑;wheel 上翻与 stick ref 互补。P1 Task 4 rAF 合并:scrollHeight 读取与 scrollTop
 *  赋值收进动画帧——同帧多渲染调度一次,回调内重核 stick,放手即弃 */
useEffect(() => {
  if (stickSuppressRef?.current === true) return; // 切回恢复静默窗:不得贴底(见 deps 注)
  if (bottomRafRef.current !== null) return;
  bottomRafRef.current = requestAnimationFrame(() => {
    bottomRafRef.current = null;
    const el = chatScrollRef.current;
    // 聚合头锚定窗口（ToolGroups dataset 旗）内挂起贴底回钉——折叠/展开期间头钮逐帧自钉视口位
    if (el !== null && chatStickRef.current && el.dataset.groupAnchor !== '1') {
      syncOverflowAnchor(el, true);
      el.scrollTop = el.scrollHeight;
      markProgBottom(el);
    }
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
  if (skipRestore) return; // 锚式恢复(块坐标)接管
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
}, [seeding, entriesLen, skipRestore]);

/** 2026-10-26 用户报障「贴地时打开思考/工具行,内容向下长看不见」:行展开是行组件本地 state
 *  不触发本组件渲染,逐渲染归底收不到信号——行组件切换时派 sx-row-toggle,贴地态在此逐帧
 *  钉底 450ms(覆盖 grid 0fr→1fr 过渡全程):展开内容即整体向上生长入视口(=内容上移);
 *  非贴底(用户已上翻)不接管,展开向下生长不动视口 */
useEffect(() => {
  let raf = 0;
  const onToggle = (): void => {
    if (!chatStickRef.current) return;
    cancelAnimationFrame(raf);
    const t0 = Date.now();
    const step = (): void => {
      const el = chatScrollRef.current;
      if (el !== null) {
        syncOverflowAnchor(el, true);
        el.scrollTop = el.scrollHeight;
        markProgBottom(el);
      }
      if (Date.now() - t0 < 450) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  window.addEventListener('sx-row-toggle', onToggle);
  return () => {
    window.removeEventListener('sx-row-toggle', onToggle);
    cancelAnimationFrame(raf);
  };
}, []);

/** G14.2xx mermaid 异步撑高补归底:图渲染落定是 Mermaid 组件内 state,不触发本组件重渲染,
 *  上方逐渲染归底收不到信号——监听落定广播,贴底态 rAF 合并补归底(进场多图连发只归一次) */
useEffect(() => {
  let raf = 0;
  const onSettled = (): void => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const el = chatScrollRef.current;
      if (el !== null && chatStickRef.current) {
        syncOverflowAnchor(el, true);
        el.scrollTop = el.scrollHeight;
        markProgBottom(el);
      }
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
  // active 入依赖(2026-11-18):隐藏座 composer 不渲染→切回重挂时本 effect 不重跑=padding 停旧值,
  // 正文尾部/运行中行被输入卡盖住且滚不到底(用户实测截图);切回重测一次即复位
}, [active]);
  /** 隐藏前滚动位快照(2026-11-18 keep-alive):display:none 期间浏览器会把 scrollTop 钳为 0,
   *  切回原样恢复——贴底态照旧贴底(运行行/尾部可见),阅读态按距底位回位 */
  const hiddenScrollRef = useRef<{ dist: number } | null>(null);
  useEffect(() => {
    if (active) return;
    const el = chatScrollRef.current;
    if (el === null) return;
    // display:none 已生效(几何全零)时用滚动期镜像;未隐藏(极少数提交序)直接实测
    const dist = el.clientHeight === 0
      ? (lastDistRef?.current ?? 0)
      : Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    hiddenScrollRef.current = { dist: Math.max(0, dist) };
  }, [active, chatScrollRef, lastDistRef]);
  useEffect(() => {
    if (!active) return;
    const saved = hiddenScrollRef.current;
    hiddenScrollRef.current = null;
    const reading = saved !== null && saved.dist > 80;
    // 阅读位:先同步脱闩,再开静默窗——恢复落点前的 reseed 重渲/高度实测瞬态不得把闩翻回贴底
    if (reading) {
      chatStickRef.current = false;
      if (stickSuppressRef !== undefined) stickSuppressRef.current = true;
    }
    const guard = reading && stickSuppressRef !== undefined
      ? window.setTimeout(() => { stickSuppressRef.current = false; }, 350)
      : 0;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = chatScrollRef.current;
        if (el === null) return;
        if (chatStickRef.current) {
          el.scrollTop = el.scrollHeight;
          markProgBottom(el);
        } else if (saved !== null) {
          el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - saved.dist);
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (guard !== 0) window.clearTimeout(guard);
    };
  }, [active, chatScrollRef, chatStickRef, stickSuppressRef]);
  return { dockRef };
}
