import { useMemo } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { t } from './i18n';
import { setCollapsed, WELCOME_TAB_SEAT } from './tabs/tab-state';
import type { TabStates, TabTypeId, TabParams } from './tabs/tab-state';
import { useAppLinks } from './use-app-links';
import { useNavHistory } from './use-nav-history';
import { useStableCallback } from './use-stable-callback';

/** 定时任务「在会话中创建」示例提示词（点击时按当前语言求值）：只说时间 + 要做什么，
 *  名称由 agent 自动起；工作区/权限/强度全部沿用当前输入框（工具缺省随会话活值）。 */
function scheduleCreateExample(): string {
  return t(
    'Create a daily 9:00 scheduled task: review project changes and flag risks.',
    '帮我创建一个每天 9:00 的定时任务：检查项目代码变更并给出风险提示。',
  );
}

/** 菜单包装回调簇(D62 专项 二段五段 自 App.tsx 逐字平迁,行为零变化):菜单头导航对/侧栏入口
 *  包装/定时任务层开合/在座直达/新建与合成入口/文件树点开。原「延迟闭包判例」留宿主;
 *  环解(use-app-overlays 早位)后诸输入全数就位,收口成钩——全部 useStableCallback 恒稳面。 */
export function useAppMenu(opts: {
  page: 'welcome' | 'chat';
  isWelcome: boolean;
  openSessionId: string;
  tabState: TabStates[string];
  sidebarFloating: boolean;
  menuClosed: boolean;
  setMenuClosed: Dispatch<SetStateAction<boolean>>;
  closeMenuDrawer: () => void;
  navControls: ReturnType<typeof useNavHistory>['navControls'];
  recordNav: ReturnType<typeof useNavHistory>['recordNav'];
  openSession: (sessionId: string, root: string, journalId?: string, inheritWelcomeDraft?: boolean, kindHint?: string) => void;
  openTabInSession: (type: TabTypeId, params?: TabParams) => void;
  presetCompose: (root: string | null, goal?: string) => void;
  setSchedulesMain: Dispatch<SetStateAction<boolean>>;
  setScheduleFocus: Dispatch<SetStateAction<string | null>>;
  settingsOpen: boolean;
  openSettings: () => void;
  setSettingsPane: Dispatch<SetStateAction<{ readonly id: string; readonly row?: string } | undefined>>;
  setTabStates: Dispatch<SetStateAction<TabStates>>;
  liveSeatRef: MutableRefObject<Map<string, { sessionId: string; root: string; kind?: string }>>;
  setMenuDir: ReturnType<typeof useAppLinks>['setMenuDir'];
  openProjectDirectory: ReturnType<typeof useAppLinks>['openProjectDirectory'];
  openFileFromTree: ReturnType<typeof useAppLinks>['openFileFromTree'];
  setPage: Dispatch<SetStateAction<'welcome' | 'chat'>>;
}): {
  toggleMenuStable: () => void;
  menuNav: { canBack: ReturnType<typeof useNavHistory>['navControls']['canBack']; canForward: ReturnType<typeof useNavHistory>['navControls']['canForward']; back: () => void; forward: () => void };
  openSessionFromMenu: (sessionId: string, root: string, journalId?: string, kind?: string) => void;
  openSunxBoardFromMenu: () => void;
  closeDirViewStable: () => void;
  openSettingsFromMenu: () => void;
  openSettingsPaneStable: (pane: string, row?: string) => void;
  openSchedulesFromMenu: () => void;
  openScheduleFromSearchStable: (id: string) => void;
  closeSchedulesStable: () => void;
  createScheduleInChatStable: () => void;
  openLiveSeatStable: (journalId: string) => boolean;
  newChatFromMenu: () => void;
  composeInFromMenu: (root: string) => void;
  collapseMenuStable: () => void;
  openProjectDirectoryStable: (root: string) => void;
  openFileFromTreeStable: (filePath: string, root: string) => void;
} {
  const { page, isWelcome, openSessionId, tabState, sidebarFloating, menuClosed, setMenuClosed, closeMenuDrawer, navControls, recordNav, openSession, openTabInSession, presetCompose, setSchedulesMain, setScheduleFocus, settingsOpen, openSettings, setSettingsPane, setTabStates, liveSeatRef, setMenuDir, openProjectDirectory, openFileFromTree, setPage } = opts;

  const toggleMenuStable = useStableCallback((): void => {
    const opening = menuClosed;
    setMenuClosed(!menuClosed);
    // 两侧抽屉互斥(2026-10-24 用户裁定):开菜单抽屉即收右抽屉
    if (opening && sidebarFloating && !tabState.collapsed) {
      setTabStates((s) => setCollapsed(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, true));
    }
  });

  /** 菜单头导航钮对(全局史):浮窗抽屉态导航即收抽屉(会话/设置同类「选中即收」口径) */
  const navBackStable = useStableCallback((): void => { closeMenuDrawer(); navControls.back(); });
  const navForwardStable = useStableCallback((): void => { closeMenuDrawer(); navControls.forward(); });
  const menuNav = useMemo(
    () => ({ canBack: navControls.canBack, canForward: navControls.canForward, back: navBackStable, forward: navForwardStable }),
    [navControls.canBack, navControls.canForward, navBackStable, navForwardStable],
  );
  /** kind 透传(2026-11-17 用户实测「加载会话时的占位是普通欢迎页」):侧栏 attach 链带回的会话形态
   *  在此曾丢失(只转 3 参)——Sunx 会话加载期落普通欢迎面;补齐第 5 参 */
  const openSessionFromMenu = useStableCallback((sessionId: string, root: string, journalId?: string, kind?: string): void => { closeMenuDrawer(); openSession(sessionId, root, journalId, false, kind); });
  const openSunxBoardFromMenu = useStableCallback((): void => { closeMenuDrawer(); setSchedulesMain(false); openTabInSession('sunxboard', {}); }); // sunx P2 Task 8:Task 7 留的 guard 缝,页签已注册即生效;终审:层在时点看板=退层开页签(不能在层后开)
  const closeDirViewStable = useStableCallback((): void => setMenuDir(null));
  const openSettingsFromMenu = useStableCallback((): void => { closeMenuDrawer(); openSettings(); });
  /** 设置面板/行直达(2026-11-21 全局搜索):开设置覆盖层并落指定面板;row=行锚(SettingsShell 滚动) */
  const openSettingsPaneStable = useStableCallback((pane: string, row?: string): void => {
    closeMenuDrawer();
    setSettingsPane({ id: pane, row });
    if (!settingsOpen) openSettings();
  });
  /** 定时任务层开合(2026-11-20):侧栏入口开(抽屉态自动收),页内返回/Esc 关 */
  const openSchedulesFromMenu = useStableCallback((): void => {
    closeMenuDrawer();
    setScheduleFocus(null); // 手动开页:不继承上次搜索落点
    setSchedulesMain(true);
  });
  /** 搜索「定时任务」条目跳转(2026-11-21):开任务页并把该卡滚入视野+短高亮 */
  const openScheduleFromSearchStable = useStableCallback((id: string): void => {
    closeMenuDrawer();
    setScheduleFocus(id);
    setSchedulesMain(true);
  });
  const closeSchedulesStable = useStableCallback((): void => {
    setScheduleFocus(null);
    setSchedulesMain(false);
  });
  /** 「在会话中创建」：退层 → 欢迎页 → 输入框预填示例提示词（用户可改后发送；agent 用
   *  create_scheduled_task 工具落档）——与 New chat 同路径，goal 走 preset 序号通道 */
  const createScheduleInChatStable = useStableCallback((): void => {
    setSchedulesMain(false);
    presetCompose(null, scheduleCreateExample());
    setPage('welcome');
    recordNav({ k: 'welcome' });
  });
  /** 侧栏点会话直达(2026-11-18):在座表命中=直接 openSession 复用运行时(零网络),未命中=false
   *  走既有 newSession+attach 两步链(首次冷开仍需日志装载,不可免) */
  const openLiveSeatStable = useStableCallback((journalId: string): boolean => {
    // 仅会话内切换走直达:从欢迎页点会话=一次「打开」(既有 newSession+attach 链语义/收编核对不变)
    if (journalId === '' || page !== 'chat') return false;
    const hit = liveSeatRef.current.get(journalId);
    if (hit === undefined) return false;
    openSession(hit.sessionId, hit.root, journalId, false, hit.kind);
    return true;
  });
  const newChatFromMenu = useStableCallback((): void => {
    closeMenuDrawer();
    setSchedulesMain(false);
    presetCompose(null);
    setPage('welcome');
    recordNav({ k: 'welcome' });
  });
  const composeInFromMenu = useStableCallback((root: string): void => {
    closeMenuDrawer();
    setSchedulesMain(false);
    presetCompose(root);
    setPage('welcome');
    recordNav({ k: 'welcome' });
  });
  const collapseMenuStable = useStableCallback((): void => setMenuClosed(true));
  const openProjectDirectoryStable = useStableCallback((root: string): void => { openProjectDirectory(root); });
  /** 文件树点开(2026-11-20 终审 minor):关定时任务层——层内无文件树,但层在时点击不应在层后开页签 */
  const openFileFromTreeStable = useStableCallback((filePath: string, root: string): void => {
    setSchedulesMain(false);
    openFileFromTree(filePath, root);
  });

  return {
    toggleMenuStable, menuNav, openSessionFromMenu, openSunxBoardFromMenu, closeDirViewStable,
    openSettingsFromMenu, openSettingsPaneStable, openSchedulesFromMenu, openScheduleFromSearchStable,
    closeSchedulesStable, createScheduleInChatStable, openLiveSeatStable, newChatFromMenu,
    composeInFromMenu, collapseMenuStable, openProjectDirectoryStable, openFileFromTreeStable,
  };
}
