import { memo, Suspense } from 'react';
import type { CSSProperties, Dispatch, MutableRefObject, SetStateAction } from 'react';
import { GitCompare, Globe, MessageCircle, PanelLeft, SquareTerminal, type LucideIcon } from 'lucide-react';
import { t, t as tLabel } from './i18n';
import type { Connection, ConnectionState, SnapshotResponse } from './connection';
import type { TodoItem } from '../../src/types';
import type { SessionProjection } from './projection';
import type { PinEntry } from './sidebar/pin-store';
import { Chat } from './pages/Chat';
import type { ChatSink } from './pages/Chat';
import { DirOpenerContext } from './pages/chat/md-render';
import { ChatScrollbar } from './pages/chat/ChatScrollbar';
import type { RewindRequest } from './pages/chat/chat-types';
import { ProjectMenu } from './sidebar/ProjectMenu';
import { SettingsShell } from './settings/SettingsShell';
import { SchedulePage } from './schedules/SchedulePage';
import { TabStrip } from './tabs/TabStrip';
import { WebTabPool, poolKey, type WebPoolItem } from './tabs/WebTabPool';
import { IS_SHELL, WindowControls } from './window-shell';
import { tabEntry } from './tabs/registry';
import { TabSkeleton } from './tabs/TabSkeleton';
import { closeTab, patchTabMeta, WELCOME_TAB_SEAT, emptyTabSession } from './tabs/tab-state';
import type { TabStates, TabTypeId, TabParams } from './tabs/tab-state';
import { WelcomeComposer } from './welcome/WelcomeComposer';
import type { WelcomeGoal } from './welcome/WelcomeComposer';
import { NavButtons } from './NavButtons';
import { useNavHistory } from './use-nav-history';
import { useShellLayout } from './use-shell-layout';
import { useSideChats } from './use-side-chats';
import { useAppLinks } from './use-app-links';
import { useAppServices } from './use-app-services';
import { usePtyRegistry } from './use-pty-registry';
import { useCollapseTransition } from './use-collapse-transition';
import { useChatMemory } from './use-agent-projections';
import { EMPTY_PROJECTION } from './use-connection-wiring';
import type { SearchAction } from './search-actions';

/** memo 包装(模块级——组件类型身份恒定,宿主每渲染不换型):三大子树对宿主高频态
 *  (tabStates 草稿直写/projection 板帧/runningIds/bgTasks/recentVersion…)blast radius 收口 */
const ProjectMenuMemo = memo(ProjectMenu);
const TabStripMemo = memo(TabStrip);
const ChatMemo = memo(Chat);
/** 驻留座最小道具(2026-11-18 热切换 keep-alive):隐藏实例只保 DOM/滚动位——回调全缺省(不注册
 *  sink/不播种),board/teams 用模块级空常量(每次新建对象会击穿 ChatMemo 比较=隐藏树白渲) */
const EMPTY_SEAT_BOARD = EMPTY_PROJECTION().board;
const EMPTY_SEAT_TEAMS = EMPTY_PROJECTION().teams;
const noopSeat = (): void => undefined;

type LayoutReturn = ReturnType<typeof useShellLayout>;
type AppLinksReturn = ReturnType<typeof useAppLinks>;
type AppServicesReturn = ReturnType<typeof useAppServices>;
type SideChatsReturn = ReturnType<typeof useSideChats>;
type PtyRegistryReturn = ReturnType<typeof usePtyRegistry>;
type NavReturn = ReturnType<typeof useNavHistory>;
type CollapseReturn = ReturnType<typeof useCollapseTransition>;
type ChatMemT = ReturnType<typeof useChatMemory>;

/** 空态快捷入口 id 序列(2026-11-17 用户裁定,按模式定死;终端/审查普通态不上快捷入口) */
export function emptyTabCardIds(welcome: boolean, dev: boolean): readonly string[] {
  if (welcome) return dev ? ['terminal', 'web'] : ['web'];
  return dev ? ['diff', 'web', 'terminal', 'side'] : ['web', 'side'];
}

export interface AppShellPanesProps {
  openDirectoryPath: AppLinksReturn['openDirectoryPath'];
  sidebarFloating: LayoutReturn['sidebarFloating'];
  tabState: ReturnType<typeof emptyTabSession>;
  menuFloating: LayoutReturn['menuFloating'];
  menuClosed: boolean;
  shellRef: MutableRefObject<HTMLDivElement | null>;
  menuRenderW: LayoutReturn['menuRenderW'];
  sidebarOccupied: LayoutReturn['sidebarOccupied'];
  settingsOpen: boolean;
  page: 'welcome' | 'chat';
  connInstance: Connection | null;
  settingsRoot: string;
  closeSettings: () => void;
  settingsPane: { readonly id: string; readonly row?: string } | undefined;
  menuAnim: CollapseReturn;
  connState: ConnectionState;
  openSessionId: string;
  openRoot: string;
  recentVersion: number;
  pins: PinEntry[];
  persistPins: (next: PinEntry[]) => void;
  runningIds: ReadonlySet<string>;
  menuNav: { canBack: boolean; canForward: boolean; back: () => void; forward: () => void };
  openSessionFromMenu: (sessionId: string, root: string, journalId?: string, kind?: string) => void;
  openLiveSeatStable: (journalId: string) => boolean;
  openProjectDirectoryStable: (root: string) => void;
  openSunxBoardFromMenu: () => void;
  menuDir: AppLinksReturn['menuDir'];
  closeDirViewStable: () => void;
  openFileFromTreeStable: (filePath: string, root: string) => void;
  openSettingsFromMenu: () => void;
  openSettingsPaneStable: (pane: string, row?: string) => void;
  searchActions: readonly SearchAction[];
  openSchedulesFromMenu: () => void;
  openScheduleFromSearchStable: (id: string) => void;
  newChatFromMenu: () => void;
  composeInFromMenu: (root: string) => void;
  collapseMenuStable: () => void;
  startMenuResize: LayoutReturn['startMenuResize'];
  mainRef: MutableRefObject<HTMLElement | null>;
  schedulesMain: boolean;
  cachedSeats: Array<{ id: string; journalId: string; root: string; kind: string | undefined }>;
  navControls: NavReturn['navControls'];
  toggleMenuStable: () => void;
  openKind: string | undefined;
  openJournalId: string;
  ptyIdFor: PtyRegistryReturn['ptyIdFor'];
  handlePtyAllocated: PtyRegistryReturn['handlePtyAllocated'];
  closeDockTab: (uid: string) => void;
  chatMem: { get: ChatMemT['chatMemGet']; put: ChatMemT['chatMemPut'] };
  backHome: () => void;
  chatSinkRef: MutableRefObject<ChatSink | null>;
  chatSeededStable: (snap: SnapshotResponse) => void;
  openFileTab: AppLinksReturn['openFileTab'];
  openDiffTab: (callId: string, path: string) => void;
  openTurndiffTab: (run: number, path: string) => void;
  openAgentTab: (label: string, agentTitle?: string, task?: string, focusTaskId?: string) => void;
  openWebTab: (url: string) => void;
  runInTerminalStable: (command: string) => void;
  openTaskFocus: AppLinksReturn['openTaskFocus'];
  openTabType: (type: TabTypeId) => void;
  /** 顶栏计数钮开签+面板首行点亮(2026-11-24 用户裁定「顶栏触发点也要高亮」) */
  openTabLit: (type: TabTypeId) => void;
  openArtifactsTab: () => void;
  agentTeamsOn: boolean;
  bgRunningCount: number;
  projection: SessionProjection;
  setTodoBatches: Dispatch<SetStateAction<import('./pages/Chat').TodoBatch[]>>;
  todoFocus: { key: string; nonce: number } | null;
  leaderFocus: { member: string; text: string; dir: 'toLeader' | 'fromLeader'; nonce: number } | null;
  startSideChat: (insert?: string, insertContent?: string) => void;
  todoLocateStable: (todos: Array<{ text: string; status: string }>) => void;
  welcomeGoal: WelcomeGoal | null;
  setWelcomeGoal: Dispatch<SetStateAction<WelcomeGoal | null>>;
  setSessionTodos: (todos: TodoItem[]) => void;
  bumpRecent: () => void;
  onForkStable: (turn: number) => void;
  openParentSessionStable: (sid: string) => void;
  showOpError: (err: unknown) => void;
  onRewindStable: (req: RewindRequest) => Promise<void>;
  setMenuClosed: LayoutReturn['setMenuClosed'];
  composePreset: { root: string | null; seq: number; goal?: string };
  setWelcomePicked: Dispatch<SetStateAction<string>>;
  openSession: (sessionId: string, root: string, journalId?: string, inheritWelcomeDraft?: boolean, kindHint?: string) => void;
  scheduleFocus: string | null;
  createScheduleInChatStable: () => void;
  openJournalSessionStable: (journalId: string, root: string) => void;
  closeSchedulesStable: () => void;
  sidebarAnim: CollapseReturn;
  sidebarRef: MutableRefObject<HTMLElement | null>;
  sidebarRenderW: LayoutReturn['sidebarRenderW'];
  projectNameOfOpenRoot: AppServicesReturn['projectNameOfOpenRoot'];
  tabSelectStable: (uid: string) => void;
  tabReorderStable: (fromUid: string, toUid: string) => void;
  tabCloseStable: (uid: string) => void;
  tabOpenTypeStable: (t: TabTypeId) => void;
  tabCycleStable: (d: 1 | -1) => void;
  tabReopenClosedStable: (i: number) => void;
  hiddenMenuIds: ReadonlySet<string> | undefined;
  tabCloseActiveStable: () => void;
  tabBodyRef: MutableRefObject<HTMLDivElement | null>;
  welcomePicked: string;
  startResize: LayoutReturn['startResize'];
  isWelcome: boolean;
  services: AppServicesReturn['services'];
  openTabInSession: (type: TabTypeId, params?: TabParams) => void;
  closeTabInSession: (uid: string) => void;
  openMemoryTab: AppLinksReturn['openMemoryTab'];
  openLearnedTab: AppLinksReturn['openLearnedTab'];
  upgradeSideChat: SideChatsReturn['upgradeSideChat'];
  sideGoals: SideChatsReturn['sideGoals'];
  setSideGoals: SideChatsReturn['setSideGoals'];
  sideSinkFor: (sideId: string, parent?: string) => MutableRefObject<ChatSink | null>;
  sideReleased: SideChatsReturn['sideReleased'];
  openSunxInstance: AppLinksReturn['openSunxInstance'];
  memoryFocus: AppLinksReturn['memoryFocus'];
  learnedFocus: AppLinksReturn['learnedFocus'];
  bgFocus: AppLinksReturn['bgFocus'];
  panelRefreshNonce: number | undefined;
  catalogTick: { memory: number; learned: number };
  dev: boolean;
  opError: string;
  webPoolItems: WebPoolItem[];
  curSeatRef: MutableRefObject<string>;
  onTabMeta: AppServicesReturn['onTabMeta'];
  onActivateTab: AppServicesReturn['onActivateTab'];
  setTabStates: Dispatch<SetStateAction<TabStates>>;
  toggleRightSidebarStable: () => void;
}

/** 三栏壳渲染面(D62 专项 自 App.tsx 脚本切割,JSX 体逐字节零改写):消费值全部经 props 解构同名
 *  承接,回调身份由宿主原样透传(memo 边界不变);activeTab 由 tabState 现算(原推导同式)。
 *  宿主保留:全部状态/回调装配与非 JSX effects。 */
export function AppShellPanes(props: AppShellPanesProps): JSX.Element {
  const {
    openDirectoryPath, sidebarFloating, tabState, menuFloating, menuClosed, shellRef, menuRenderW, sidebarOccupied, settingsOpen, page, connInstance, settingsRoot, closeSettings, settingsPane, menuAnim, connState, openSessionId, openRoot, recentVersion, pins, persistPins, runningIds, menuNav, openSessionFromMenu, openLiveSeatStable, openProjectDirectoryStable, openSunxBoardFromMenu, menuDir, closeDirViewStable, openFileFromTreeStable, openSettingsFromMenu, openSettingsPaneStable, searchActions, openSchedulesFromMenu, openScheduleFromSearchStable, newChatFromMenu, composeInFromMenu, collapseMenuStable, startMenuResize, mainRef, schedulesMain, cachedSeats, navControls, toggleMenuStable, openKind, openJournalId, ptyIdFor, handlePtyAllocated, closeDockTab, chatMem, backHome, chatSinkRef, chatSeededStable, openFileTab, openDiffTab, openTurndiffTab, openAgentTab, openWebTab, runInTerminalStable, openTaskFocus, openTabLit, openArtifactsTab, agentTeamsOn, bgRunningCount, projection, setTodoBatches, todoFocus, leaderFocus, startSideChat, todoLocateStable, welcomeGoal, setWelcomeGoal, setSessionTodos, bumpRecent, onForkStable, openParentSessionStable, showOpError, onRewindStable, setMenuClosed, composePreset, setWelcomePicked, openSession, scheduleFocus, createScheduleInChatStable, openJournalSessionStable, closeSchedulesStable, sidebarAnim, sidebarRef, sidebarRenderW, projectNameOfOpenRoot, tabSelectStable, tabReorderStable, tabCloseStable, tabOpenTypeStable, tabCycleStable, tabReopenClosedStable, hiddenMenuIds, tabCloseActiveStable, tabBodyRef, welcomePicked, startResize, isWelcome, services, openTabInSession, closeTabInSession, openMemoryTab, openLearnedTab, upgradeSideChat, sideGoals, setSideGoals, sideSinkFor, sideReleased, openSunxInstance, memoryFocus, learnedFocus, bgFocus, panelRefreshNonce, catalogTick, dev, opError, webPoolItems, curSeatRef, onTabMeta, onActivateTab, setTabStates, toggleRightSidebarStable,
  } = props;
  const activeTab = tabState.tabs.find((t2) => t2.uid === tabState.activeUid) ?? null;
  return (
    <DirOpenerContext.Provider value={openDirectoryPath}>
    <div
      className={[
        IS_SHELL ? 'sx-shell sx-desktop' : 'sx-shell',
        // 浮窗抽屉面(2026-10-24 用户裁定):窄视口右栏悬浮不占布局宽,主栏吃满
        // (模式 pill 塌缩已改底栏实测溢出驱动 pills-tight,壳级不再派生 sx-main-narrow)
        sidebarFloating ? 'sx-sidebar-float' : '',
        // 侧栏停靠折叠态(2026-10-29 标题让位根修配套):32px 骨架兜不住窗控簇(~150px),主列顶栏照旧预留
        !sidebarFloating && tabState.collapsed ? 'sx-sidebar-collapsed' : '',
        // 左菜单抽屉面(2026-10-24 三轮裁定):<856 菜单自动关闭;手动重开=悬浮抽屉(fixed 左满高)
        menuFloating && !menuClosed ? 'sx-menu-float' : '',
      ].filter(Boolean).join(' ')}
      ref={shellRef}
      style={{
        '--menu-w': `${menuRenderW}px`,
        // 占位宽:抽屉(<856 浮窗)与关闭态=0——抽屉不入流,消费方(侧栏 max-width/tabsearch
        // 视口钳)不得再被菜单宽挤压(2026-10-24 用户实测「菜单抽屉开着,右侧侧栏窄于最小宽」)
        '--menu-occ': `${menuClosed || menuFloating ? 0 : menuRenderW}px`,
        '--sidebar-w': `${sidebarOccupied}px`,
      } as CSSProperties}
    >
      {IS_SHELL && !settingsOpen && page !== 'chat' && (
        /* 2026-10-24 拖拽重构:欢迎/连接页顶部拖窗把手。几何隔离 drag 轨:left+104 避让菜单
           关闭态呼出钮簇、right=148+侧栏实占宽(--sidebar-w)避让窗控簇与草稿座页签条(2026-10-28
           用户实测「开侧栏后上侧无法拖窗」:曾按页签条在场整条撤 rail 致欢迎页零拖拽面——老 bug
           复现;改动态让位后 rail 常开仍与一切按钮几何互斥,zoom 错位平移咬不到钮;抽屉态左缘
           移至抽屉浮层右缘之外见 CSS sx-menu-float 分支;侧栏抽屉浮层 z80 盖 rail z1,其条上
           空白不可拖为窄视口可接受) */
        <div className="sx-dragrail" data-drag-band aria-hidden="true" />
      )}
      {settingsOpen && connInstance !== null && (
        /* G8c-T8 设置态改覆盖层(2026-11-16 流畅轮,2026-11-15 用户报障「改个主题也要重新懒加载
           渲染」根修):设置壳整幅覆盖(fixed z85,抽屉/弹层 z80 之下、窗控簇 z90 之上),三栏
           保挂不卸——主题/外观即改即见(CSS data-theme 切换面+Mermaid 配色缓存重渲),Chat 不再
           卸载=返回零重播种零重渲染(旧 ternary 整替语义退役:Chat 卸载重挂=reseed 白屏+全量
           重解析)。覆盖层吞指针事件,底层不可交互;Esc/返回钮同路径关层 */
        <div className="sx-settings-overlay">
          <SettingsShell conn={connInstance} root={settingsRoot} onBack={closeSettings} requestedPane={settingsPane} />
        </div>
      )}
      {/* 三栏恒挂(2026-11-16 流畅轮):设置覆盖层仅浮于其上——Chat/侧栏不卸载,主题改动
          即改即见,关设置零重播种(原「设置态整替三栏」语义退役,见覆盖层块注) */}
      <>
          {/* 左栏:项目分组(Home 职能内化;装配中占位)。关闭态不渲染(顶栏 logo 呼出);
              浮窗抽屉态选中会话/设置/新会话/目录即自动收(各回调前挂 closeMenuDrawer) */
          }
          {menuAnim.mounted && (connInstance !== null ? (
            <ProjectMenuMemo
              closing={menuAnim.closing}
              conn={connInstance}
              connState={connState}
              activeSessionId={openSessionId}
              activeRoot={openRoot}
              recentVersion={recentVersion}
              pins={pins}
              persistPins={persistPins}
              runningIds={runningIds}
              nav={menuNav}
              onOpenSession={openSessionFromMenu}
              onOpenLiveSeat={openLiveSeatStable}
              onOpenDirectory={openProjectDirectoryStable}
              onOpenSunxBoard={openSunxBoardFromMenu}
              dirView={menuDir}
              onCloseDirView={closeDirViewStable}
              onOpenFileFromTree={openFileFromTreeStable}
              onOpenSettings={openSettingsFromMenu}
              onOpenSettingsItem={openSettingsPaneStable}
              searchActions={searchActions}
              onOpenSchedules={openSchedulesFromMenu}
              onOpenSchedule={openScheduleFromSearchStable}
              onNewChat={newChatFromMenu}
              onComposeIn={composeInFromMenu}
              onCollapse={collapseMenuStable}
            />
          ) : (
            <nav className="sx-menu" aria-label="projects">
              <p className="home-loading">{t('Connecting…', '连接装配中…')}</p>
            </nav>
          ))}
          {/* G12 左栏拖宽手柄:overlay 在 nav 右缘(负 margin 零布局占位),拖动改 --menu-w */}
          <div
            className="sx-menu-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('Resize sidebar', '调整侧栏宽度')}
            data-tip={t('Drag to resize', '拖动调整宽度')}
            onMouseDown={startMenuResize}
          />
          {/* 中栏:Chat 恒挂(无会话=欢迎空态);归档视图已内驻左栏 ArchiveSection(2026-10-21 裁定)。
              定时任务层在场时整栏 inert+aria-hidden(终审 finding 8):Chat 保持挂载不重播种,
              但焦点/读屏不得逃进层后的隐藏会话面 */}
          <main className="sx-main" ref={mainRef} {...(schedulesMain ? { inert: '' as unknown as boolean, 'aria-hidden': 'true' } : {})}>
            {page === 'chat' && connInstance !== null ? (
              <>
              {/* 2026-11-18 热切换 keep-alive 座位(单数组渲染):前台座+驻留座必须在**同一个 keyed
                  数组**里——曾分「单元素 + map 数组」两处渲染,切走瞬间 key 跨集合移动不生效=React
                  卸载重挂(且重挂初始化先于旧实例 chatMem 写回=驻留座空树,隐藏态又不播种),
                  实测驻留座恒 0 条目。同数组渲染后按 key 复用实例:转录 DOM/滚动位/刻度条原样。
                  前台座 display:contents 保持 .sx-main 直子(flex)布局;驻留座 display:none 零布局 */}
              {[
                { key: `seat:${openSessionId}`, active: true, seat: null as null | { id: string; journalId: string; root: string; kind: string | undefined } },
                ...cachedSeats.filter((cs) => cs.id !== openSessionId).map((cs) => ({ key: `seat:${cs.id}`, active: false, seat: cs })),
              ].map((slot) => (
                <div className={slot.active ? 'sx-chat-seat' : 'sx-chat-seat sx-chat-cache'} key={slot.key} aria-hidden={slot.active ? undefined : 'true'}>
                  {slot.active ? (
                    <ChatMemo
                      key={openSessionId}
                      nav={navControls}
                      menuClosed={menuClosed}
                      onToggleMenu={toggleMenuStable}
                      conn={connInstance}
                      sessionId={openSessionId}
                      kindHint={openKind}
                      journalId={openJournalId}
                      ptyIdFor={ptyIdFor}
                      onPtyAllocated={handlePtyAllocated}
                      onCloseDockTab={closeDockTab}
                      chatMem={chatMem}
                      connState={connState}
                      onBack={backHome}
                      sinkRef={chatSinkRef}
                      onSeeded={chatSeededStable}
                      onOpenFile={openFileTab}
                      onOpenDiff={openDiffTab}
                      onOpenTurnDiff={openTurndiffTab}
                      onOpenAgent={openAgentTab}
                      onOpenWeb={openWebTab}
                      onRunInTerminal={runInTerminalStable}
                      onOpenTask={openTaskFocus}
                      onOpenTab={openTabLit}
                      onOpenArtifacts={openArtifactsTab}
                      agentTeamsOn={agentTeamsOn}
                      bgRunning={bgRunningCount}
                      board={projection.board}
                      teams={projection.teams}
                      members={projection.team}
                      onTodoBatches={setTodoBatches}
                      todoFocus={todoFocus}
                      leaderFocus={leaderFocus}
                      onSideAsk={startSideChat}
                      onTodoLocate={todoLocateStable}
                      pendingGoal={welcomeGoal ?? undefined}
                      onPendingGoalDone={() => setWelcomeGoal(null)}
                      root={openRoot}
                      onTodos={setSessionTodos}
                      onRenamed={bumpRecent}
                      onSessionsMutated={bumpRecent}
                      pins={pins}
                      persistPins={persistPins}
                      onSideChat={startSideChat}
                      onOpenMemory={openMemoryTab}
                      onOpenLearned={openLearnedTab}
                      onFork={onForkStable}
                      onOpenSession={openParentSessionStable}
                      onOpError={showOpError}
                      onRewind={onRewindStable}
                    />
                  ) : (
                    <ChatMemo
                      key={slot.seat!.id}
                      active={false}
                      conn={connInstance}
                      sessionId={slot.seat!.id}
                      connState={connState}
                      onBack={noopSeat}
                      sinkRef={chatSinkRef}
                      chatMem={chatMem}
                      journalId={slot.seat!.journalId}
                      root={slot.seat!.root}
                      kindHint={slot.seat!.kind}
                      board={EMPTY_SEAT_BOARD}
                      teams={EMPTY_SEAT_TEAMS}
                    />
                  )}
                </div>
              ))}
              </>
            ) : connInstance !== null ? (
              <>
              {page === 'welcome' && menuClosed && (
                /* 2026-10-24 用户裁定:欢迎页无顶栏,菜单关闭态左上角浮出呼出钮(否则无入口)。
                   2026-10-25 前进/后退:同簇左聚(导航史跨 welcome/会话可达——New chat 落此页
                   正是「后退回上一会话」的主场景);定位由簇容器承载(z50 盖 dragrail) */
                <div className="sx-welcome-nav">
                  <NavButtons nav={navControls} />
                  <button
                    type="button"
                    className="sx-winbtn sx-menu-reopen"
                    aria-label="toggle menu"
                    data-tip={t('Open menu', '打开菜单')}
                    onClick={() => setMenuClosed(false)}
                  >
                    <PanelLeft size={16} strokeWidth={1.75} />
                  </button>
                </div>
              )}
              <WelcomeComposer
                conn={connInstance}
                presetRoot={composePreset.root ?? undefined}
                presetSeq={composePreset.seq}
                presetGoal={composePreset.goal !== undefined ? { text: composePreset.goal, seq: composePreset.seq } : undefined}
                onPickedChange={setWelcomePicked}
                onOpened={(sessionId, root, goal, images) => {
                  setWelcomeGoal({ root, goal, ...(images !== undefined && images.length > 0 ? { images } : {}) });
                  // 发出去=临时会话转正:唯一放行草稿继承的入口(第 4 参,见 openSession 迁移门)
                  openSession(sessionId, root, undefined, true);
                }}
              />
              </>
            ) : (
              <div className="sx-welcome-brand">Sunshinex</div>
            )}
          </main>
          {/* 定时任务主区层(2026-11-20):固定层覆盖主区,left=菜单实占宽保持左侧菜单可见;
              右栏同时隐藏(下方 guard)。层内列表/配置/记录三态由 SchedulePage 自管 */}
          {schedulesMain && connInstance !== null && (
            <div className="sx-schedules-layer">
              <SchedulePage
                conn={connInstance}
                onOpenSession={openJournalSessionStable}
                onExit={closeSchedulesStable}
                focusJobId={scheduleFocus ?? undefined}
                /* 菜单开着时页内不再放菜单钮（设置页同构：标题行只有标题）；收进抽屉后留一个重开入口 */
                onToggleMenu={menuClosed ? toggleMenuStable : undefined}
                onCreateInChat={createScheduleInChatStable}
              />
            </div>
          )}
          {/* 右栏:会话标签页(G10:welcome 态整体不渲染;G14.28:折叠态也不渲染——展开钮入 Chat 顶栏) */}
          {!schedulesMain && sidebarAnim.mounted && (
          <aside className={`sx-sidebar${sidebarAnim.closing ? ' sx-closing' : ''}`} ref={sidebarRef} style={{ '--sb-w': `${tabState.width}px`, '--drawer-w': `${sidebarRenderW}px` } as CSSProperties}>
            <TabStripMemo
              tabs={tabState.tabs}
              activeUid={tabState.activeUid}
              disabled={page !== 'chat' && page !== 'welcome'}
              welcomeOnly={isWelcome}
              projectName={projectNameOfOpenRoot}
              onSelect={tabSelectStable}
              onReorder={tabReorderStable}
              onClose={tabCloseStable}
              onOpenType={tabOpenTypeStable}
              onCycle={tabCycleStable}
              recentClosed={tabState.recentClosed}
              onReopenClosed={tabReopenClosedStable}
              hiddenMenuIds={hiddenMenuIds}
              onCloseActive={tabCloseActiveStable}
            />
            {(page === 'chat' || page === 'welcome') && !tabState.collapsed && connInstance !== null && (
              // 2026-10-26 二期 keep-alive:全部 open 标签常挂,非活动 display:none+inert——
              // DOM/状态/滚动位/终端屏完整保留,互切零重建;重标签 LRU-4 超限自动关(下方 effect)
              tabState.tabs.map((t) => {
                const hidden = activeTab === null || t.uid !== activeTab.uid;
                return (
                  <div
                    key={t.uid}
                    className="sx-tabbody"
                    ref={hidden ? undefined : tabBodyRef}
                    style={hidden ? { display: 'none' } : undefined}
                    {...(hidden ? { inert: '' as unknown as boolean } : {})}
                  >
                    {/* 二期分包:标签体 lazy——Suspense 骨架承接首开 chunk 加载 */}
                    <Suspense fallback={<TabSkeleton />}>
                    {isWelcome && !['file', 'web', 'terminal', 'sunxboard'].includes(t.type) ? (
                      /* 2026-10-27 欢迎页全局草稿:会话绑定型页签(待办/审查/智能体/上下文等)在无会话
                          草稿座不渲染内容——首个输入建席迁移后自动可用。2026-10-29 用户实测修正:
                          判定按页面(isWelcome)不按 openSessionId 空——5232DCE 起进欢迎页不清
                          openSessionId,开过会话再回欢迎页此条件恒假,浏览器/终端卡与 + 菜单全灭。
                          2026-11-15 sunx P2 Task 8:'sunxboard' 应用级(数据自拉全量 sunx 实例)不绑会话,
                          欢迎页座同渲染(看板钮从侧栏/欢迎页都可进总览) */
                      <div className="sx-tab-empty">
                        <div className="sx-tab-empty-title">{tLabel('Available after a session starts', '会话开始后可用')}</div>
                        <div className="sx-tab-empty-sub">{tLabel('This panel is session-bound. Send a message to bind the draft sidebar to a session.', '此面板绑定会话。发送一条消息即可把当前草稿侧栏绑定到会话。')}</div>
                      </div>
                    ) : t.type === 'web' ? (
                      // 浏览器页签体=占位框:webview 常驻在应用根的页签池(WebTabPool),按此框对位显示
                      <div className="sx-webslot" style={{ height: '100%' }} />
                    ) : (
                    tabEntry(t.type).render({
                      conn: connInstance,
                      // 欢迎页终端(2026-11-14 用户裁定):draft 通道(sessionId 空=openPtyAt(root) 直供
                      // cwd=root=当前选工作区;app 域 pty 不绑会话,转移入会话凭盘档 ptyId 直连)
                      sessionId: isWelcome && t.type === 'terminal' ? '' : openSessionId,
                      root: isWelcome && t.type === 'terminal' ? (welcomePicked !== '' ? welcomePicked : openRoot) : openRoot,
                      params: t.params,
                      services,
                      uid: t.uid,
                      openTab: openTabInSession,
                      openFilePath: openFileTab, // 目录回抛走左树定位/配置打开方式外开(2026-10-30)
                      closeTab: closeTabInSession,
                      startSideChat,
                      openMemory: openMemoryTab,
                      openLearned: openLearnedTab,
                      upgradeSideChat,
                      sideGoal: sideGoals.get(t.uid),
                      onSideGoalDone: (uid2: string) => setSideGoals((m) => { const n = new Map(m); n.delete(uid2); return n; }),
                      onDraftText: (uid2: string, v: string) => setTabStates((s) => patchTabMeta(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, uid2, { draftText: v })),
                      onDraftRefContents: (uid2: string, json: string) => setTabStates((s) => patchTabMeta(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, uid2, { draftRefContents: json })),
                      ptyIdFor,
                      onPtyAllocated: handlePtyAllocated,
                      chatSinkRef: t.params.sideId !== undefined ? sideSinkFor(t.params.sideId, openSessionId) : undefined,
                      sideReady: (id: string) => sideReleased.has(id),
                      onOpenSunxInstance: openSunxInstance, // sunx P2 Task 8:SUNX 总览页点卡片进实例
                      memoryFocus,
                      learnedFocus,
                      bgFocus,
                      panelRefreshNonce,
                      catalogTick,
                    })
                    )}
                    </Suspense>
                  </div>
                );
              })
            )}
            {activeTab !== null && (
              // 侧栏自绘 vbar(2026-10-29 用户实测宽度变化果冻/多余条根修):tabbody 原生条 CSS 退役——
              // 经典条占布局宽,Monaco stale 溢出/内容增减时反复闪现横推内容(4840e9c 加 gutter↔
              // eaeb7c4 撤 gutter 两难连根消);滚轮/键盘原生滚动不变,thumb 拖拽走 ChatScrollbar
              // 同款直写 DOM。key=活动 uid:切签重挂即换数据源(ref 随 commit 先行落位,后到 effect
              // 读到新容器;非活动面 display:none 不产几何)
              <ChatScrollbar key={activeTab.uid} containerRef={tabBodyRef} />
            )}
            {(page === 'chat' || page === 'welcome') && !tabState.collapsed && activeTab === null && (
              // G14.27 零标签空态=Codex 推荐项:标题+副题+常用页卡(点击即开,不再默认开任务页);
              <div className="sx-tab-empty">
                <div className="sx-tab-empty-title">{t('Open tabs', '打开标签页')}</div>
                <div className="sx-tab-empty-sub">{t('Choose tabs to open in the side panel.', '选择要在侧边面板中打开的标签。')}</div>
                <div className="sx-tab-empty-cards">
                  {emptyTabCardIds(isWelcome, dev).map((key) => {
                    const cards: Record<string, [LucideIcon, string, () => void]> = {
                      web: [Globe, t('Browser', '浏览器'), (): void => openTabInSession('web')],
                      terminal: [SquareTerminal, t('Terminal', '终端'), (): void => openTabInSession('terminal')],
                      side: [MessageCircle, t('Side chat', '辅助对话'), (): void => startSideChat()],
                      diff: [GitCompare, t('Review', '审查'), (): void => openTabInSession('diff')],
                    };
                    const [Icon, label, onClick] = cards[key]!;
                    return (
                      <button key={key} type="button" className="sx-tab-empty-card" onClick={onClick}>
                        <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {(page === 'chat' || page === 'welcome') && !tabState.collapsed && <div className="sx-resizer" onMouseDown={startResize} />}
          </aside>
          )}
        </>
      {opError !== '' && (
        <div className="sx-toast" role="alert">
          {opError}
        </div>
      )}
      {connInstance !== null && (
        <WebTabPool
          conn={connInstance}
          items={webPoolItems}
          visibleKey={(page === 'chat' || page === 'welcome') && !settingsOpen && !schedulesMain && !tabState.collapsed && activeTab?.type === 'web' ? poolKey(curSeatRef.current, activeTab.uid) : null}
          anchorRef={tabBodyRef}
          root={openRoot}
          draftSeat={WELCOME_TAB_SEAT}
          onMeta={onTabMeta}
          onClose={(seat, uid) => setTabStates((s) => closeTab(s, seat, uid))}
          onActivate={onActivateTab}
        />
      )}
      {/* 2026-10-23 用户裁定:[|] 唯一渲染=本簇(web 贴窗口最右/桌面 −□× 左),对话页常驻
          不随收展换实现——页签条自有钮两套渲染致切换变尺寸,已退役 */}
      <WindowControls showSideToggle={(page === 'chat' || page === 'welcome') && !settingsOpen && !schedulesMain} onToggleRightSidebar={toggleRightSidebarStable} />
    </div>
    </DirOpenerContext.Provider>
  );
}
