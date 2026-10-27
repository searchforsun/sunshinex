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
  /** 右栏拖宽边条 mousedown 手柄 */
  readonly startResize: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /** 右栏布局宽(折叠=32 骨架宽) */
  readonly sidebarWidth: number;
}

export function useShellLayout(deps: ShellLayoutDeps): ShellLayout {
  const { shellRef, resizeCleanupRef, page, settingsOpen, openSessionId, tabCollapsed, tabWidth, setTabStates } = deps;

  /** G12 左栏宽度可调(use-menu-resize 单点):菜单宽与拖宽手柄逻辑见钩子;占宽 thunk 延迟求值
   *  (sidebarOccupied 在本链后段才成值,箭头体消费时已定义) */
  const { menuWidth, startMenuResize } = useMenuResize(shellRef, () => sidebarOccupied);
  /** 视口宽跟踪(2026-10-23 越视口修复的数据源):持久宽只在拖拽中钳制,窗口缩窄/换页后
   *  渲染态从不重钳——残留宽令 .sx-menu 被 max-width 挤成缝隙、三栏行整体溢出视口。
   *  resize 即重渲,渲染期钳制以实时视口重算。 */
  const [viewportW, setViewportW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setViewportW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
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
  /** 右栏渲染期钳制宽——分栏态预留主栏最小宽(320),下限 296:菜单让宽后仍装不下则侧栏托底
   *  (vw≥856 时数学上恰≥296,见浮窗阈值);浮窗态=纯覆盖层,**不挤占主栏/composer**
   *  (2026-10-24 用户裁定「抽屉是上浮的,为什么占输入框宽度」——dock 不让位,抽屉盖在上面),
   *  上界只留 24px 边距,下限 MIN_TAB_WIDTH=296。视觉/本地换算 /zoomScale() 契约同前 */
  const sidebarRenderW = Math.min(
    tabWidth,
    sidebarFloating
      ? Math.max(MIN_TAB_WIDTH, viewportW / zoomScale() - menuRenderW - 24)
      : Math.max(MIN_TAB_WIDTH, viewportW / zoomScale() - menuRenderW - MAIN_MIN_WIDTH),
  );
  /** 右栏实际占宽(未渲染=0:欢迎页/折叠/settings/浮窗态——浮窗不占布局宽,菜单/主栏不受钳) */
  const sidebarOccupied = !settingsOpen && page === 'chat' && !tabCollapsed && !sidebarFloating ? sidebarRenderW : 0;

  /** 拖宽边条 mousedown:window mousemove 计算宽(右栏在右侧,向左拖=变宽;min 440 在
   *  tab-state.setWidth 单点,拖拽上界=视口−菜单−440——无固定最大宽但不越视口,G14.2xx 用户
   *  裁定),mouseup 解绑 + 移 active 类;每次 move 直接落态(React 批处理兜底);sessionId
   *  起拖时定格(拖拽中会话切换属病态,不追)。G14.2xx 起拖基线取「当前渲染宽」:状态可能
   *  滞留护栏外(先拖宽菜单再拖本边条),不取渲染宽则向窄拖先空走死区 */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (page !== 'chat' || openSessionId === '' || tabCollapsed) return;
    e.preventDefault(); // 拖宽期间禁原生文本选择拖选(G8e 终审 B;.sx-resizer 另挂 user-select:none)
    const el = e.currentTarget;
    el.classList.add('active');
    const startX = e.clientX;
    // 拖拽上界随态:分栏预留主栏最小宽;浮窗=覆盖层只留 24px 边距(不挤 composer,见 sidebarRenderW);
    // 下限 296 在 setWidth 单点(起拖定格,拖拽中无 resize 事件模式不翻转)
    const floating = sidebarFloating;
    const cap = (): number => window.innerWidth / zoomScale() - (menuFloating ? 0 : menuRenderW) - (floating ? 24 : MAIN_MIN_WIDTH) / zoomScale();
    const startWidth = Math.min(tabWidth, cap());
    shellRef.current?.classList.add('sx-dragging'); // 拖拽期 iframe 指针事件让位(见 CSS .sx-dragging)
    const sessionId = openSessionId;
    const onMove = (ev: MouseEvent): void => {
      // G14.2xx 用户裁定:无固定最大宽,但受中栏最小宽约束——中栏触底即停,右栏不越视口。
      // zoom 契约:clientX/startX 与上界均为视觉 px,宽度状态是本地 px——delta 与上界同 /zoomScale()
      setTabStates((s) => setWidth(s, sessionId, Math.min(cap(), startWidth + (startX - ev.clientX) / zoomScale())));
    };
    const stop = (): void => {
      el.classList.remove('active');
      shellRef.current?.classList.remove('sx-dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = stop;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  };

  const sidebarWidth = page === 'chat' && openSessionId !== '' ? (tabCollapsed ? 32 : sidebarRenderW) : 32;

  return {
    startMenuResize,
    sidebarFloating,
    menuFloating,
    menuClosed,
    setMenuClosed,
    closeMenuDrawer,
    menuRenderW,
    sidebarOccupied,
    startResize,
    sidebarWidth,
  };
}
