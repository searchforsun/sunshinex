import { useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import { useMenuResize } from './use-menu-resize';
import { MIN_TAB_WIDTH, setWidth, type TabStates } from './tabs/tab-state';
import { MAIN_MIN_WIDTH } from './thread-width';
import { zoomScale } from './ui-zoom';

/**
 * 三栏几何簇 hook(2026-10-27 技术债轮 D53 批C-1 自 App.tsx 外提,行为零变化):视口跟踪→
 * 浮窗阈值→抽屉态→菜单/右栏渲染期钳制→占宽→拖宽手柄,一条几何链一个文件。
 * 压缩顺序裁定(2026-10-24):右缘缩窗=侧栏→主栏→菜单→菜单关闭;左缘反向(先左菜单 <856
 * 后右栏 <616 相继转抽屉,后显者自动关先显者)。
 */

export interface ShellLayoutDeps {
  readonly shellRef: MutableRefObject<HTMLDivElement | null>;
  /** 右栏根元素(拖宽期直写 width——绕开 React 重渲果冻,见 startResize) */
  readonly sidebarRef: MutableRefObject<HTMLElement | null>;
  /** 拖宽在途的清理句柄(卸载兜底解绑由宿主持有——App 卸载 useEffect 消费) */
  readonly resizeCleanupRef: MutableRefObject<(() => void) | null>;
  readonly page: string;
  readonly settingsOpen: boolean;
  readonly openSessionId: string;
  /** 会话标签态的两项几何入参(width=持久宽,collapsed=折叠) */
  readonly tabCollapsed: boolean;
  readonly tabWidth: number;
  readonly setTabStates: Dispatch<SetStateAction<TabStates>>;
}

export interface ShellLayout {
  startMenuResize: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /** 右栏浮窗(视口 <616):覆盖层不占布局宽 */
  readonly sidebarFloating: boolean;
  /** 菜单浮窗(视口 <856 自动关,手动重开呈抽屉) */
  readonly menuFloating: boolean;
  readonly menuClosed: boolean;
  readonly setMenuClosed: Dispatch<SetStateAction<boolean>>;
  /** 抽屉选中即收(会话/设置/新会话/目录;仅浮窗沿有效) */
  readonly closeMenuDrawer: () => void;
  /** 菜单渲染期钳制宽(拖宽态 menuWidth 不丢,只钳渲染;CSS --menu-w 消费) */
  readonly menuRenderW: number;
  /** 右栏实际占宽(未渲染=0:欢迎页/折叠/settings/浮窗态——浮窗不挤占主栏/composer) */
  readonly sidebarOccupied: number;
  /** 右栏渲染期钳制宽(浮窗态=抽屉固定宽 drawerMin;CSS --drawer-w 消费) */
  readonly sidebarRenderW: number;
  /** 右栏拖宽边条 mousedown 手柄 */
  readonly startResize: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /** 右栏布局宽(折叠=32 骨架宽) */
  readonly sidebarWidth: number;
}

/** 抽屉固定宽(2026-10-29 用户裁定终版+补刀「不随放大倍数变」):**纯本地 px 常量** 476=
 *  应用最小宽 500(壳 main.ts PHYSICAL_MIN_W 手调单点)−24 浮窗边距。首版 500/devicePixelRatio−24
 *  随显示缩放漂移(100%→476/110%→429/125%→376),用户裁定废——本地常量一处手调与壳同联动。
 *  与 MIN_TAB_WIDTH 取大兜底;仅浮窗态生效,分栏压缩链 296 不动 */
function drawerMin(): number {
  return Math.max(MIN_TAB_WIDTH, 500 - 24);
}

export function useShellLayout(deps: ShellLayoutDeps): ShellLayout {
  const { shellRef, sidebarRef, resizeCleanupRef, page, settingsOpen, openSessionId, tabCollapsed, tabWidth, setTabStates } = deps;

  /** G12 左栏宽度可调(use-menu-resize 单点):菜单宽与拖宽手柄逻辑见钩子;占宽 thunk 延迟求值
   *  (sidebarOccupied 在本链后段才成值,箭头体消费时已定义) */
  const { menuWidth, startMenuResize } = useMenuResize(shellRef, () => sidebarOccupied);
  /** 视口宽跟踪(2026-10-23 越视口修复的数据源):持久宽只在拖拽中钳制,窗口缩窄/换页后
   *  渲染态从不重钳——残留宽令 .sx-menu 被 max-width 挤成缝隙、三栏行整体溢出视口。
   *  resize 即重渲,渲染期钳制以实时视口重算。 */
  const [viewportW, setViewportW] = useState(() => window.innerWidth);
  useEffect(() => {
    // resize 响应降频(2026-10-28 迟滞感续修):窗口拖大/缩小每事件一整树重渲,渲染+全窗 reflow
    // 叠加超帧预算=内容落后窗缘一两帧(双侧迟滞)。rAF 合并之上再加 100ms 时限——几何类右缘
    // 已纯 CSS 逐帧跟随不受影响;此处状态只喂阈值翻转(抽屉模式)与窄宽钳制,10Hz 足够。
    // 续帧等待必须是独立函数(2026-10-29 用户实测截图冻结根修):原实现重试调度 onResize 自身,
    // 重试帧触发时 raf 已是新 rAF id(非 0),进门被下方守卫静默吞掉且永不清零——首个 <100ms
    // 连续拖动后所有 resize 事件永久丢弃,viewportW 冻结=抽屉阈值/窄宽钳制全按旧宽计算
    // (实测:696 视口三栏按 856 溢出渲染,右栏被窗缘裁掉,抽屉模式再也不翻转)
    let raf = 0;
    let last = 0;
    const flush = (): void => {
      const now = performance.now();
      if (now - last < 100) {
        raf = requestAnimationFrame(flush); // 未到时限:续帧等待(flush 不走事件入口守卫)
        return;
      }
      raf = 0;
      last = now;
      setViewportW(window.innerWidth);
    };
    const onResize = (): void => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(flush);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, []);
  /** 右栏浮窗切换(2026-10-24 三轮裁定):右栏浮窗下移为「主栏+抽屉双触底」——视口(本地/zoom)
   *  <320+296=616 才浮;856~616 区间=菜单已自动关闭(见 menuFloating),主栏吃满,侧栏仍分栏 */
  const sidebarFloating = viewportW / zoomScale() < MAIN_MIN_WIDTH + MIN_TAB_WIDTH;
  /** 左菜单浮窗/自动关闭(2026-10-24 用户裁定):视口 <240+320+296=856 时菜单自动关闭;手动重开
   *  (顶栏 logo/搜索)后以悬浮抽屉呈现,选中会话/设置/新会话/搜索选会话即自动收——产品可缩到
   *  主栏+侧栏双触底 616。压缩顺序:右缘缩=侧栏→主栏→菜单→菜单关闭;左缘反向 */
  const menuFloating = viewportW / zoomScale() < 240 + MAIN_MIN_WIDTH + MIN_TAB_WIDTH;
  /** 菜单关闭态(手动点品牌收起/<856 自动关;顶栏 logo 重开) */
  const [menuClosed, setMenuClosed] = useState(false);
  const closeMenuDrawer = (): void => {
    if (menuFloating && !menuClosed) setMenuClosed(true);
  };
  /** 缩窗抽屉沿(2026-10-24 四轮裁定):先左菜单(<856)后右栏(<616)相继转抽屉,后显者自动关先显者——
   *  右抽屉出现沿=关菜单抽屉;加宽回分栏不自动恢复抽屉态(用户手动)。 */
  const prevSbFloating = useRef(false);
  useEffect(() => {
    if (sidebarFloating && !prevSbFloating.current) setMenuClosed(true);
    prevSbFloating.current = sidebarFloating;
  }, [sidebarFloating]);
  /** 菜单渲染期钳制(2026-10-24 用户裁定压缩顺序:右缘缩窗=侧栏→主栏→菜单→浮窗):视口装不下
   *  右栏最小 296+主栏最小 320 时,菜单先让出富余宽(拖宽态 menuWidth 不丢,只钳渲染),下限 240 */
  const menuRenderW = Math.min(menuWidth, Math.max(240, viewportW / zoomScale() - MAIN_MIN_WIDTH - MIN_TAB_WIDTH));
  /** 右栏渲染期钳制宽——浮窗态=**抽屉固定宽 drawerMin()=应用最小宽−24,不可调节**(2026-10-29
   *  用户裁定终版:最窄应用下变抽屉浮窗,宽度恒为此值;此前 min(持久宽, 视口−24) 会把持久宽
   *  带进抽屉,废)。分栏态=既有钳制:预留主栏最小宽(320),下限 296,菜单让宽口径
   *  (menuFloating?0:menuRenderW) 与 startResize cap() 一致(616~856 区间菜单已关占位 0,
   *  侧栏自 856 起随视口渐进压缩)。视觉/本地换算 /zoomScale() 契约同前 */
  const sidebarRenderW = sidebarFloating
    ? drawerMin() // 浮窗:固定宽,持久宽不带进抽屉
    : Math.min(tabWidth, Math.max(MIN_TAB_WIDTH, viewportW / zoomScale() - (menuFloating ? 0 : menuRenderW) - MAIN_MIN_WIDTH));
  /** 右栏实际占宽(未渲染=0:欢迎页/折叠/settings/浮窗态——浮窗不占布局宽,菜单/主栏不受钳) */
  const sidebarOccupied = !settingsOpen && (page === 'chat' || page === 'welcome') && !tabCollapsed && !sidebarFloating ? sidebarRenderW : 0;

  /** 拖宽边条 mousedown:window mousemove 计算宽(右栏在右侧,向左拖=变宽;min 296 在
   *  tab-state.setWidth 单点,拖拽上界=视口−菜单−主栏最小宽——无固定最大宽但不越视口,G14.2xx 用户
   *  裁定),mouseup 解绑 + 移 active 类;拖拽期 **直写 sidebarRef.style.width**(2026-10-26
   *  用户实测「拖右缘果冻左右晃动」根修:每帧 setTabStates 整树重渲滞后于光标呈橡皮筋;
   *  直写后一帧只走 layout+paint,与左栏观感对齐),终值只在 mouseup 一次性落 React 态
   *  (持久化/护栏/--sidebar-w 均随该次重渲收口);拖拽中无关重渲不动 width——React 对
   *  style 的 vdom diff 前后相等不回写,直写值得以存续。sessionId 起拖时定格(拖拽中会话
   *  切换属病态,不追)。G14.2xx 起拖基线取「当前渲染宽」:状态可能滞留护栏外(先拖宽菜单
   *  再拖本边条),不取渲染宽则向窄拖先空走死区 */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (tabCollapsed || (page !== 'chat' && page !== 'welcome')) return;
    if (sidebarFloating) return; // 浮窗抽屉不可调节(2026-10-29 用户裁定):宽度恒=drawerMin()
    e.preventDefault(); // 拖宽期间禁原生文本选择拖选(G8e 终审 B;.sx-resizer 另挂 user-select:none)
    const el = e.currentTarget;
    el.classList.add('active');
    const startX = e.clientX;
    // 拖拽上界:分栏预留主栏最小宽(菜单已关口径同 sidebarRenderW);下限 296 在 setWidth 单点
    // (起拖定格,拖拽中无 resize 事件模式不翻转)。视口项 /zoomScale 归一;菜单让宽/主栏最小宽
    // 为本地 px 常数不除 zoom——与渲染钳制同一口径(2026-10-27 技术债轮:常数误除 zoom 致非 100%
    // 缩放下拖宽上界松于渲染钳制,mouseup 落态>渲染宽=可见回跳+持久档失真)
    const cap = (): number => window.innerWidth / zoomScale() - (menuFloating ? 0 : menuRenderW) - MAIN_MIN_WIDTH;
    const startWidth = Math.min(tabWidth, cap());
    let next = startWidth;
    shellRef.current?.classList.add('sx-dragging'); // 拖拽期 iframe 指针事件让位(见 CSS .sx-dragging)
    const sessionId = page === 'welcome' ? '@welcome' : openSessionId; // 草稿座宽度档(按页面判定,与 App 座口径一致)
    const onMove = (ev: MouseEvent): void => {
      // G14.2xx 用户裁定:无固定最大宽,但受中栏最小宽约束——中栏触底即停,右栏不越视口。
      // zoom 契约:clientX/startX 与上界均为视觉 px,宽度状态是本地 px——delta 与上界同 /zoomScale()
      next = Math.max(MIN_TAB_WIDTH, Math.min(cap(), startWidth + (startX - ev.clientX) / zoomScale()));
      if (sidebarRef.current !== null) sidebarRef.current.style.width = `${next}px`;
    };
    const stop = (): void => {
      el.classList.remove('active');
      shellRef.current?.classList.remove('sx-dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      resizeCleanupRef.current = null;
      // 内联宽清场+终值落态同批提交(同一事件任务内,无中间绘制帧)——宽度自此归 CSS
      // var(--sb-w) 管(窗口缩放纯 CSS 逐帧钳,果冻根除),拖拽直写值不残留覆盖
      if (sidebarRef.current !== null) sidebarRef.current.style.width = '';
      setTabStates((s) => setWidth(s, sessionId, next));
    };
    resizeCleanupRef.current = stop;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  };

  const sidebarWidth = (page === 'chat' || page === 'welcome') && !(openSessionId === '' && tabCollapsed) ? (tabCollapsed ? 32 : sidebarRenderW) : 32;

  return {
    startMenuResize,
    sidebarFloating,
    menuFloating,
    menuClosed,
    setMenuClosed,
    closeMenuDrawer,
    menuRenderW,
    sidebarOccupied,
    sidebarRenderW,
    startResize,
    sidebarWidth,
  };
}
