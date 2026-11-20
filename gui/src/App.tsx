import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { t } from './i18n';
import { t as tLabel } from './i18n';
import { GitCompare, Globe, MessageCircle, SquareTerminal, type LucideIcon } from 'lucide-react';
import type { CSSProperties, MutableRefObject } from 'react';
import type { Connection, ConnectionState, RewindResult, SnapshotResponse } from './connection';
import type { TodoItem } from '../../src/types';
import type { SessionProjection } from './projection';
import { normalizePins, type PinEntry } from './sidebar/pin-store';
import { EMPTY_PROJECTION, useConnectionWiring } from './use-connection-wiring';
import { Chat } from './pages/Chat';
import { DirOpenerContext } from './pages/chat/md-render';
import { ChatScrollbar } from './pages/chat/ChatScrollbar';
import type { ChatSink } from './pages/Chat';
import type { RewindRequest } from './pages/chat/chat-types';
import { ProjectMenu } from './sidebar/ProjectMenu';
import { PanelLeft } from 'lucide-react';
import { SettingsShell } from './settings/SettingsShell';
import { SchedulePage } from './schedules/SchedulePage';
import { TabStrip } from './tabs/TabStrip';
import { Suspense } from 'react';
import { WebTabPool, poolKey, seatOfWebContents, seatsOfBrowserKey } from './tabs/WebTabPool';
import { SESSION_DELETED_EVENT, SESSION_ARCHIVED_EVENT } from './session-events';
import type { WebPoolItem } from './tabs/WebTabPool';
import { tabEntry, registryProbe } from './tabs/registry';
import { TabSkeleton } from './tabs/TabSkeleton';
import { REFRESHABLE_TAB_TYPES } from './tabs/sidebar-refresh';
import { ensureSession, openTab, closeTab, setActive, cycleTab, reorderTab, setCollapsed, patchTabMeta, patchTurndiffAddressing, emptyTabSession, reopenClosed, rewindSeat, adoptStaleSeats, stripTabType, addSideDismissed, WELCOME_TAB_SEAT } from './tabs/tab-state';
import type { TabStates, TabTypeId, TabParams } from './tabs/tab-state';
import { useBoardSeed } from './use-board-seed';
import { WelcomeComposer } from './welcome/WelcomeComposer';
import { readPersistedProject } from './welcome/use-welcome-persisted';
import type { WelcomeGoal } from './welcome/WelcomeComposer';
import { CHAT_MAX_EVENT, chatMaxFor } from './thread-width';
import { useDeveloperMode } from './developer-mode';
import { useAppearanceSync } from './use-appearance-sync';
import { useOpError } from './use-op-error';
import { useShellLayout } from './use-shell-layout';
import { useTabPersistence } from './use-tab-persistence';
import { useAgentBuckets, useChatMemory, useShadowHydrationRefs, bindShadowHydration } from './use-agent-projections';
import { NavButtons } from './NavButtons';
import { useNavHistory } from './use-nav-history';
import { useRestoreLast } from './use-restore-last';
import { useSideChats } from './use-side-chats';
import { IS_SHELL, WindowControls, useWindowDrag } from './window-shell';
import { usePtyRegistry } from './use-pty-registry';
import { useAppLinks } from './use-app-links';
import { useAppServices } from './use-app-services';
import { useHeavyTabLru } from './use-heavy-tab-lru';
import { prefetchEditorIcons } from './ui-util';
import { useCollapseTransition } from './use-collapse-transition';
import { clearAutoSeenSuppressed } from './sidebar/project-menu-util';

/**
 * G8a 三栏壳(G3.5 路由壳重组,spec §1):左栏 ProjectMenu(Home 全页退役,职能内化——工作区
 * 分组/attach/组内新建/添加工作区;连接态点随左栏底栏,brand/topbar 退役)+ 中栏 Chat 恒挂
 * (page 'welcome'|'chat',无会话=欢迎空态;仍 key={sessionId} 会话隔离)+ 右栏会话标签页
 * (TabStrip + tabEntry 渲染;tabStates 每会话独立,openSession 经 ensureSession 缺省开
 * 「任务」单例页)。token 门面(G3 平移)与连接装配(会话维)原样:token 在场才建连接(单连
 * 接生命周期,token 变更=重装配)。
 * 连接装配(会话维):onEvent(sessionId, e, seq) 单 WS 收全会话帧,sessionRef 判据过滤他会话
 * (本会话帧经 chatSinkRef 转投 Chat——连接回调闭包装配时固定,Chat 装配期注册 sink);板/委派
 * 投影随事件维稳(重连=onReset 清零+daemon 全量补发帧重建,任务标签消费)。
 * Chat(T4δ)以 key={sessionId} 挂载:对话面本地态(reducer 投影/输入/播种门/竞态缓冲)随组件
 * 销毁——两会话先后打开各自投影独立,无跨会话串扰,不断连重连。onReset(首连与重连同路径)
 * → Chat.reset 本会话重播种(重连=重置投影+全量重放裁定)。G4 挂起面:onApproval/onAsk/
 * onResetSession 三回调同 pattern——sessionRef 过滤本会话后经 chatSinkRef 转投 Chat 卡片区。
 * G5 板投影(App 态,任务标签经 services 消费):board/delegations + team(经 Chat onSeeded
 * 回调自快照回填——事件流无 teammate 面,reseed 即更新;快照本就携带 board/delegations,一并
 * 回填:开 s2 即见 s2 快照板而非 s1 残留——会话切换串态根除;openSession/backHome 亦清板投影
 * 双保险,重开经快照重建权威态)。G6 板投影 seq 门(G5 交接 b 根修):Chat 播种窗内到达的 board/delegation 帧若直
 * 投投影,会被 onSeeded 的快照整替清掉(丢一帧增量——快照在途与事件流的窄竞态)。与 Chat
 * pendingRef 同构:seeding 期帧入 boardPendingRef;onSeeded 落定后整替快照板再按 seq 过滤重放
 * (≤ snap.lastSeq 丢——快照已含,再投即双应用;> 逐帧 apply)。窗起讫:openSession/
 * onReset/onResetSession 起(均致 Chat reseed),onSeeded 止;种子失败窗悬挂至下次重置
 * (帧持续缓冲不投,与 Chat「无基线不乱投」语义对齐)。
 * onResetSession(G3.5 交接 d 收口):会话维 reset 除 Chat 重播种外,board/delegations 投影
 * 亦清(此前仅连接级 onReset 清——会话 reset 后板投影悬挂旧任务)。
 * G8a 标签态:tabStates 每会话独立留存(backHome 不清——重开同会话标签还原,spec §1「每会话
 * 独立」);G8d 起 Chat write 工具 path 钮主通道 onOpenDiff → openTabInSession('diff',
 * {callId,path})(by callId 判重多实例);onOpenFile 保留为无 callId 面(种子条)的回退(file
 * 标签仍可从目录/+菜单开);右栏 collapsed 只余折叠钮,拖宽边条只钳最小 440(G14.2xx 用户裁定:
 * 三栏均不设最大宽,右栏在右,向左拖=变宽)。
 * token 门面(G3 平移):URL ?token= 优先(回写 localStorage 持久)→ localStorage。
 */

interface ImportMetaEnv {
  readonly VITE_SERVE_URL?: string;
}
declare global {
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/** 判重/单例探针(tab-state 真实现,TAB_REGISTRY 装配;模块级单例——零态闭包可安全共享) */
const PROBE = registryProbe();

/** 2026-11-16 流畅轮:零依赖恒稳回调单点(最新闭包经 ref 直取——forkLatestRef/propsRef 既有
 *  手法收敛)。Chat/ProjectMenu/TabStrip memo 化的前提:JSX 内联箭头每渲染换身份=每帧击穿
 *  memo(全 App 重渲染即三子树全量重渲);包装恒稳,行为=每次调用取当帧闭包,无过期闭包面 */
function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []) as (...args: A) => R;
}
/** memo 包装(模块级——组件类型身份恒定,App 每渲染不换型):三大子树对 App 壳高频态
 *  (tabStates 草稿直写/projection 板帧/runningIds/bgTasks/recentVersion…)blast radius 收口 */
const ProjectMenuMemo = memo(ProjectMenu);
const TabStripMemo = memo(TabStrip);
const ChatMemo = memo(Chat);
/** 驻留座最小道具(2026-11-18 热切换 keep-alive):隐藏实例只保 DOM/滚动位——回调全缺省(不注册
 *  sink/不播种),board/teams 用模块级空常量(每次新建对象会击穿 ChatMemo 比较=隐藏树白渲) */
const EMPTY_SEAT_BOARD = EMPTY_PROJECTION().board;
const EMPTY_SEAT_TEAMS = EMPTY_PROJECTION().teams;
const noopSeat = (): void => undefined;

/** 2026-10-27 欢迎页全局草稿座:无会话(欢迎页)时侧栏标签落此键——临时会话思想(2026-10-29 定版):发出去(欢迎页建席)整座继承到新会话并重获空座;开既有会话零交集 */

/** 空态快捷入口 id 序列(2026-11-17 用户裁定,按模式定死;终端/审查普通态不上快捷入口) */
export function emptyTabCardIds(welcome: boolean, dev: boolean): readonly string[] {
  if (welcome) return dev ? ['terminal', 'web'] : ['web'];
  return dev ? ['diff', 'web', 'terminal', 'side'] : ['web', 'side'];
}

export function App(): JSX.Element {
  // G10:token 填写逻辑退役——本地 serve 免鉴权档(恒绑回环),连接不再携带凭证
  return <AppShell />;
}

/** 定时任务「在会话中创建」示例提示词（点击时按当前语言求值）：只说时间 + 要做什么，
 *  名称由 agent 自动起；工作区/权限/强度全部沿用当前输入框（工具缺省随会话活值）。 */
function scheduleCreateExample(): string {
  return t(
    'Create a daily 9:00 scheduled task: review project changes and flag risks.',
    '帮我创建一个每天 9:00 的定时任务：检查项目代码变更并给出风险提示。',
  );
}


/** 应用壳:单连接装配 + 三栏路由(左 ProjectMenu|中 Chat 恒挂|右标签栏);welcome = 无会话空态 */
function AppShell(): JSX.Element {
  /** 欢迎页 goal 接力(G10):welcome 提交建会话后,Chat 播种完成即提交该目标 */
  /** 欢迎页选中工作区(2026-11-14 用户裁定「欢迎页终端实时用当前选的工作区目录」):WelcomeComposer
   *  picked 上提镜像——右栏终端草稿页签 cwd 数据源;缺省回 openRoot(进会话页签语义不变) */
  const [welcomePicked, setWelcomePicked] = useState<string>(() => readPersistedProject());

  const [welcomeGoal, setWelcomeGoal] = useState<WelcomeGoal | null>(null);
  const [page, setPage] = useState<'welcome' | 'chat'>('welcome');
  /** 2026-10-27 欢迎页全局草稿:座判定按页面不按 openSessionId——进欢迎页(新对话)不清会话,残留侧栏即此根因 */
  const isWelcome = page === 'welcome';
  const dev = useDeveloperMode();
  /** 欢迎页预选工作区(G10-C16):New chat=空(自选);项目行「+」=该项目(快捷预选) */
  /** 欢迎页预选意图:root=项目行「+」带来的项目,null=新对话(回默认工作区);seq 每次入口递增——
   *  同值重复点击(欢迎页已挂载、用户在条上改选后再点新对话)也要重新生效 */
  const [composePreset, setComposePreset] = useState<{ root: string | null; seq: number; goal?: string }>({ root: null, seq: 0 });
  const presetCompose = useCallback((root: string | null, goal?: string): void => setComposePreset((p) => ({ root, seq: p.seq + 1, ...(goal !== undefined ? { goal } : {}) })), []);
  const [openSessionId, setOpenSessionId] = useState<string>('');
  /** 打开期会话形态 hint(2026-11-17):sunx 打开链同步下发,首屏即 Sunx 欢迎面 */
  const [openKind, setOpenKind] = useState<string | undefined>(undefined);
  /** G14.213 会话 journal 档案 id(滚动位存档等跨重挂持久面的稳定键):sessionId 是活动会话
   *  别名(每次重开 newSession+attach 重新发号),journal id 跨重挂/daemon 重启不变;缺省=sessionId */
  const [openJournalId, setOpenJournalId] = useState<string>('');
  /** 当前会话所属工作区 root(ProjectMenu activeRoot 组自动展开的判据;'' = 无) */
  const [openRoot, setOpenRoot] = useState<string>('');
  /** G14.16 标题统一流联动:rename 落盘后 bump → ProjectMenu 重拉 recentSessions(侧栏即时同名) */
  const [recentVersion, setRecentVersion] = useState(0);
  /** G14.52 活动会话运行态(GUI 本地权威):model-start 置位,done/error 复位——侧栏运行圆点消费 */
  /** G14.2xx 运行态按会话记(原全局布尔 cross 会话切换/刷新恢复即卡转圈——A 起跑点亮、
   *  切到 B 后 A 的 done 因会话不匹配被忽略,布尔永不熄)。
   *  G14.2xx b 集合化:多会话并行运行各自点亮(单值时 A 跑着切 B 再回,A 明明在跑却熄) */
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(() => new Set());
  /** G8a 标签态总表:每会话独立(backHome 保留——重开同会话标签还原,spec §1)。
   *  G14.2xx 持久化:盘为真相源(<slug>/gui/sessions/<会话id>.json)——附接即拉档回填,
   *  变更防抖写透;内存仅缓存/加速(CLAUDE.md §13 持久化分层) */
  const [tabStates, setTabStates] = useState<TabStates>({});
  /** tabStates 镜像(2026-11-16 流畅轮):openTurndiffTab 等读面走 ref 免依赖——草稿直写
   *  (patchTabMeta 每击键 setTabStates)换掉回调身份会击穿 ChatMemo/TabStripMemo */
  const tabStatesRef = useRef<TabStates>({});
  tabStatesRef.current = tabStates;
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [projection, setProjection] = useState<SessionProjection>(EMPTY_PROJECTION);
  /** Chat onTodos 适配(todo_write 批整替进投影;useCallback 恒稳,消费面 JSX 不变) */
  const setSessionTodos = useCallback((todos: TodoItem[]): void => {
    setProjection((p) => ({ ...p, sessionTodos: todos }));
  }, []);
  /** 会话级操作失败提示(use-op-error 单点,2026-10-27 技术债轮 D53 批E 外提):sx-toast 3s 自隐 */
  const { opError, showOpError } = useOpError();
  /** G8d/G14.2xx 子智能体活动聚合按会话分桶+LRU(use-agent-projections 单点;onEvent 归约与
   *  services.agentActivities 消费) */
  const { agentActivitiesBySession, bumpActs, dropPendingFolds, flushActsNow } = useAgentBuckets();
  /** G14.2xx b 转录内存缓存(use-agent-projections 单点):Chat 卸载写回/重挂缓存直渲 */
  const { chatMemGet, chatMemPut } = useChatMemory((key) => runningIds.has(key)); // TTL 豁免:运行中会话不剔(60min,2026-10-26)
  /** Chat 消费面身份恒定:Chat 卸载写回 effect 以它为依赖,每渲染新对象=每帧 cleanup 写回一次 */
  const chatMem = useMemo(() => ({ get: chatMemGet, put: chatMemPut }), [chatMemGet, chatMemPut]);
  /** 侧栏联动 bump(rename/归档/已读等落库后上抛):身份恒定——下游 effect 若以它为依赖,
   *  变身份即「bump→重渲染→再触发」自激循环 */
  const bumpRecent = useCallback((): void => setRecentVersion((v) => v + 1), []);
  /** G14.174 待办批次/关联轮次输入(Chat 从转录重建上抛)——待办/任务板页签数据面 */
  const [todoBatches, setTodoBatches] = useState<import('./pages/Chat').TodoBatch[]>([]);
  /** 快照权威投影(2026-10-31 用户裁定「任务历史持久化可见」):daemon journal 全量派生,经 onSeeded
   *  播种;与转录派生值合并(同签名派生优先——live 批次 ts 更新),环窗/尾窗外的老批次由此可见 */
  const [seededTodoBatches, setSeededTodoBatches] = useState<import('./pages/Chat').TodoBatch[]>([]);
  /** 后台任务账本(bg-task 直播 + 开会话/手动 GET 播种;顶栏计数与后台任务页签同源) */
  const [bgTasks, setBgTasks] = useState<import('./projection').BgTaskRow[]>([]);
  /** 记忆/学习技能清单变点(catalog-changed 递增 → 对应页签重拉) */
  const [catalogTick, setCatalogTick] = useState({ memory: 0, learned: 0 });
  /** G14.176 create_agent_team_task 行点开的定位信号(任务板滚动高亮对应卡) */
  const [taskFocus, setTaskFocus] = useState<{ ref: string; nonce: number; kind?: 'task' | 'team' } | null>(null);
  /** 待办卡主名字定位信号(2026-11-03):nonce 变更即滚到关联轮次正文气泡(Chat 消费) */
  const [todoFocus, setTodoFocus] = useState<{ key: string; nonce: number } | null>(null);
  /** 2026-11-04 待办行点击定位信号(Chat 待办字样→开待办页签+定位对应卡) */
  const [todoLocateSig, setTodoLocateSig] = useState<{ sig: string; nonce: number } | null>(null);
  const onLocateTodo = useCallback((batch: import('./pages/Chat').TodoBatch): void => {
    if (batch.userKey === undefined) return;
    setTodoFocus({ key: batch.userKey, nonce: Date.now() });
  }, []);
  const connRef = useRef<Connection | null>(null);
  /** 事件分发判据:连接回调闭包在装配时固定,会话切换经 ref 免闭包陈旧 */
  const sessionRef = useRef<string>('');
  sessionRef.current = openSessionId;
  /** journalId 镜像(删除/归档事件双寻址比对:事件 detail 可能是运行时 id 或 journalId) */
  const openJournalIdRef = useRef<string>('');
  openJournalIdRef.current = openJournalId;
  /** 座位(运行时 id)→ journal 账:同档换号时据此收口旧座位(adoptStaleSeats) */
  const seatJournalRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (openSessionId !== '' && openJournalId !== '' && openJournalId !== openSessionId) seatJournalRef.current.set(openSessionId, openJournalId);
  }, [openSessionId, openJournalId]);
  /** Chat 事件转投面:Chat 装配期注册(卸载注销)——onEvent/onReset 经此投递 */
  const chatSinkRef = useRef<ChatSink | null>(null);
  /** 热切换 keep-alive 驻留座(2026-11-18 用户裁定「热切换必须无感:内容与刻度条一次就位,都在
   *  内存里」):切走时把上一会话的 Chat 留在 DOM(display:none),切回=显示切换——转录 DOM/滚动位/
   *  刻度条原样,零重挂零分批。只驻留最近一个;再切走/回欢迎页即替换释放(内存有界)。
   *  行内语义=React 19.2 <Activity> 的 React 18 手写等价:隐藏实例不注册事件 sink、不播种
   *  (useSessionEvents active 门),切回时轻量重播种(seedSig 同判免整替=零重渲) */
  const [cachedSeats, setCachedSeats] = useState<Array<{ id: string; journalId: string; root: string; kind: string | undefined }>>([]);
  /** 在座座席表(journalId → 运行时座;2026-11-18):本运行打开过的会话在 daemon 恒在座(无回收,
   *  仅删除/归档拆座)——侧栏再点该会话可直接复用运行时 id 打开,免 newSession+attach 两次往返
   *  (实测 attach 198ms=冷进入主延迟)。journal 未铸前以运行时 id 双键登记 */
  const liveSeatRef = useRef(new Map<string, { sessionId: string; root: string; kind?: string }>());
  /** G14.29 辅助会话 sink 表(sideId → sink ref):连接帧按键路由到旁路 Chat(板/委派/子智能体不聚) */
  const sideSinksRef = useRef<Map<string, MutableRefObject<ChatSink | null>>>(new Map());
  /** side 父会话表(sideId → 主会话 id;2026-11-07 用户裁定「辅助投影挂到主对话下」):板/委派
   *  live 帧与子智能体桶按此并入主会话投影,待办批次同收 */
  const sideParentRef = useRef<Map<string, string>>(new Map());
  /** sink 取得/补注册(2026-11-04 用户实测:重启后恢复的辅助对话页签空壳——startSideChat 才注册
   *  sink,恢复路径缺表被 registry 判无 sink 落提示面;页签还原时惰性补位,帧路由即刻可用) */
  const sideSinkFor = (sideId: string, parent?: string): MutableRefObject<ChatSink | null> => {
    let sink = sideSinksRef.current.get(sideId);
    if (sink === undefined) {
      sink = { current: null };
      sideSinksRef.current.set(sideId, sink);
    }
    // 父会话登记(2026-11-07「辅助投影挂主对话下」):fork 与页签恢复两路都在此落表——
    // 板/委派 live 帧并入与 side 快照合并都按此表寻主
    if (parent !== undefined && parent !== '') sideParentRef.current.set(sideId, parent);
    return sink;
  };
  /** 板播种窗(use-board-seed 单点,2026-10-27 技术债轮 D53 批F 外提):G6 seq 门缓冲/重开/
   *  快照回填一条域一条文件;refs 穿透 use-connection-wiring 帧路由 */
  /** 快照 team.busy 权威(封悬空 agent run；与影子水合共用) */
  const busyTeamRef = useRef<ReadonlySet<string>>(new Set());
  const busyTeamReadyRef = useRef(false);
  const { boardPendingRef, boardSeedingRef, reopenBoardSeedWindow, seedFromSnapshot, boardRecentRef, refreshFromSnapshot } = useBoardSeed({
    sessionRef,
    setRunningIds,
    setProjection,
    bumpActs,
    busyTeamRef,
    busyTeamReadyRef,
  });
  /** 拖宽在途清理句柄:mouseup 解绑外,卸载兜底解绑(会话切走/组件卸毁不泄漏 window 监听) */
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  /** G8c-T8 设置态:settingsOpen=true 时三栏内容整体切换(SettingsShell 占左+主栏,右标签栏
   *  不渲染,Chat 卸载——返回重播种,与 backHome 同语义可接受);settingsRoot=设置面隐式项目
   *  上下文(开设置时快照 openRoot,无则 ''=仅全局;无顶部切换面——项目区分下沉到配置项徽标,
   *  项目级行以此为写回锚) */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 定时任务主区层(2026-11-20):固定层覆盖主区,左侧菜单保持;Chat 不卸载——点会话/新建/
   *  记录打开会话即关层,回到既有会话链 */
  const [schedulesMain, setSchedulesMain] = useState(false);
  /** 设置落点面板请求(托盘「快捷键」直达;关设置即清,侧栏再开仍落「通用」) */
  const [settingsPane, setSettingsPane] = useState<{ readonly id: string } | undefined>(undefined);
  const [settingsRoot, setSettingsRoot] = useState('');
  /** 三栏壳根(拖宽期挂 .sx-dragging:iframe 指针事件让位——web 标签内容会吞 window mousemove,
   *  光标进入 iframe 即拖拽冻结) */
  const shellRef = useRef<HTMLDivElement | null>(null);

  /** G14.2xx b 影子水合四 ref(use-agent-projections 工厂;refs 先声明解「水合需连接实例、
   *  装配需截流 refs」的环——onEvent 截流路由/onReset 重建/会话打开触发消费原样) */
  const { shadowHydrateRef, shadowHydratedRef, shadowHydratingRef, shadowBufRef, shadowCutRef } = useShadowHydrationRefs();
  /** 水合整替前 live folds 丢弃口(wiring 装配期赋值,水合绑定面消费——见 ConnectionWiringDeps 注) */
  const dropPendingActsRef = useRef<((sessionId: string) => void) | null>(null);

  /** 单连接装配(use-connection-wiring 单点):onEvent 路由/onReset 重建/挂起转投/生命周期迁
   *  钩子,依赖注入面见 ConnectionWiringDeps——装配一次([]),闭包取首渲染值,会话切换经
   *  sessionRef 与各 ref 免陈旧(原口径) */
  /** 置顶档单源(2026-11-07 用户实测「置顶卡一下」根修轮):乐观态直更零往返;持久化双写——
   *  本地镜像(瞬时)+gui/pins.json(服务端,重启不丢)。此前慢/Failed to fetch 真凶=daemon
   *  keepAliveTimeout 5s 关空闲连接,浏览器池中旧 socket 上 PUT 不重试直接炸(服务端已加长 65s);
   *  网络失败走本地镜像兜底,置顶标记永不因网络丢失 */
  const [pins, setPins] = useState<PinEntry[]>(() => normalizePins((() => {
    try {
      return JSON.parse(localStorage.getItem('sunshinex.pins') ?? '[]');
    } catch {
      return [];
    }
  })()));
  const pendingPinsRef = useRef<PinEntry[] | null>(null);
  const persistPins = useCallback((next: PinEntry[]): void => {
    setPins(next);
    try {
      localStorage.setItem('sunshinex.pins', JSON.stringify(next));
    } catch {
      /* 隐私模式静默 */
    }
    void connRef.current?.saveAppPins(next).then(
      () => {
        try {
          localStorage.removeItem('sunshinex.pins'); // 服务端落库成功:本地镜像使命完成
        } catch {
          /* 静默 */
        }
      },
      () => undefined, // 网络失败:本地镜像已在,重启读档兜底
    );
  }, []);
  // journal 铸造即回填(主动推送;recents 对账为断线兜底 belt):openJournalId 暂=sessionId(升级链
  // 临时身份)时,本会话铸造帧即刻换真身份——已读压读/草稿键零窗口
  const onJournalMinted = useCallback((sessionId: string, journalId: string): void => {
    if (sessionId === openSessionId && journalId !== '' && openJournalId === sessionId) setOpenJournalId(journalId);
  }, [openSessionId, openJournalId]);
  const connInstance = useConnectionWiring({
    sessionRef, chatSinkRef, sideSinksRef, sideParentRef, onJournalMinted, boardPendingRef, boardSeedingRef, boardRecentRef,
    shadowHydrateRef, shadowHydratedRef, shadowHydratingRef, shadowBufRef, shadowCutRef, dropPendingActsRef, connRef,
    reopenBoardSeedWindow, bumpActs, setRecentVersion, setRunningIds, setProjection,
    setTodoBatches, setConnState, setBgTasks, setCatalogTick,
  });
  // 编辑器图标启动预取(2026-11-07 用户裁定「应用启动时就加载」):模块级缓存暖上,
  // 会话首帧顶栏主钮直显真图标,不再 1/4 字形→真图标跳变
  useEffect(() => {
    if (connInstance !== null) prefetchEditorIcons(connInstance);
  }, [connInstance]);
  // 置顶读档:服务端 gui/pins.json 权威(重启不丢),失败/缺档回落本地镜像;PUT 在途跳过防闪屏。
  // 连接就位读一次——置顶态单源在 App,此后只经 persistPins 乐观直更,切会话不重拉
  useEffect(() => {
    if (connInstance === null || pendingPinsRef.current !== null || typeof connInstance.appPins !== 'function') return;
    void connInstance.appPins().then(
      (r) => {
        const serverPins = normalizePins(r.pins);
        if (serverPins.length > 0 || pendingPinsRef.current === null) setPins(serverPins);
      },
      () => undefined, // 网络失败:本地镜像已在初值
    );
  }, [connInstance]);
  // 开会话播种后台任务账本(GET 一次带 outputTail;之后靠 bg-task 直播,撤 5s 轮询)
  useEffect(() => {
    if (connInstance === null || openSessionId === '') {
      setBgTasks([]);
      return;
    }
    let alive = true;
    void connInstance.sessionTasks(openSessionId).then(
      (rows) => {
        if (alive) setBgTasks(rows);
      },
      () => {
        if (alive) setBgTasks([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [connInstance, openSessionId]);
  /** 影子水合单点绑定:每渲染重赋 hydrate ref(闭包恒取最新连接实例) */
  bindShadowHydration(
    { shadowHydrateRef, shadowHydratingRef, shadowBufRef, shadowHydratedRef, shadowCutRef },
    bumpActs,
    connInstance,
    (sid) => dropPendingActsRef.current?.(sid),
    { ready: busyTeamReadyRef, names: busyTeamRef },
    { dropPendingFolds, flushActsNow },
  );

  /** 外观偏好同步(use-appearance-sync 单点,2026-10-27 技术债轮 D53 批E 外提):语言源随 daemon
   *  settings + 公共持久化偏好上收(/app/gui-state 覆盖本地,zoom/theme/fontPreset)两件一次性同步 */
  useAppearanceSync(connInstance);

  /** agentTeams 开关(settings 语义键;缺省 true)——关则藏「智能体团队」页签菜单项并拒开签;
   *  settingsEpoch 在关设置壳时递增,保存后重读开关(autosave 已落盘) */
  const [agentTeamsOn, setAgentTeamsOn] = useState(true);
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  useEffect(() => {
    if (connInstance === null) return;
    let alive = true;
    void connInstance.settings(openRoot !== '' ? openRoot : undefined).then(
      (view) => {
        if (!alive) return;
        const row = view.keys.find((k) => k.key === 'agentTeams');
        const v = row?.value;
        if (v === null || v === undefined || v === '') {
          setAgentTeamsOn(true);
          return;
        }
        const n = v.trim().toLowerCase();
        setAgentTeamsOn(n === 'on' || n === 'true');
      },
      () => {
        if (alive) setAgentTeamsOn(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [connInstance, openRoot, settingsEpoch]);

  /** agentTeams 关闭:剔除已开/盘档残留的 agents 页签(含 recentClosed,防重开旁路) */
  useEffect(() => {
    if (agentTeamsOn) return;
    setTabStates((st) => stripTabType(st, 'agents'));
  }, [agentTeamsOn]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  /** 挂起确认解除刷侧栏(2026-10-31 主菜单「?」图标):Chat 移卡(settle)派 sx-pending-settled,
   *  此处 bump recentVersion 重拉会话行——awaiting 标注解除跟手(到达侧 bump 在 wiring 三回调) */
  useEffect(() => {
    const onPendingSettled = (): void => setRecentVersion((v) => v + 1);
    window.addEventListener('sx-pending-settled', onPendingSettled);
    return () => window.removeEventListener('sx-pending-settled', onPendingSettled);
  }, []);

  /** 左栏选中会话(attach/新建完成):切路由(Chat 装配期自播种基线)+ ensureSession 建席
   *  (缺省「任务」页)+ 板投影/team 清零(会话切换串态防线——快照落定后经 onSeeded 重建
   *  权威态)+ 播种窗重开;tabStates 已有该会话则原样(重开同会话标签还原) */
  /** G14.29 辅助对话:右栏 sidechat 标签绑定旁路会话。帧路由经 sideSinksRef(onEvent 同键转投);
   *  卡点与 /btw /side 输入拦截同汇本口。
   *  2026-11-04 用户裁定「发送第一条才 fork」:点开只开草稿页签(不 fork;sidechat 判重键
   *  sideId 缺='' 互判重聚焦既有——类似欢迎页临时会话,每次打开复用同一草稿页),首条发送时
   *  才 fork 主对话整档(见 upgradeSideChat) */
  const startSideChat = useStableCallback((insert?: string, insertContent?: string): void => {
    if (openSessionId === '') return;
    // 2026-11-07 串扰根修:token 内容随 insert 同路入参(辅助面私有账本收),全局注册表仅兜底
    openTabInSession('sidechat', insert !== undefined && insert !== '' ? { insert, insertContent } : {});
  });
  const { sideGoals, setSideGoals, upgradeSideChat, sideListing, sideReleased } = useSideChats({
    connInstance, connRef, page, openSessionId, openRoot, tabStates, setTabStates, sideSinksRef, sideParentRef, probe: PROBE,
  });

  /** kindHint(2026-11-17):打开链已知会话形态(sunx attach 应答/新建链)——首帧即定格欢迎面,免 title GET 竞态 */
  const openSession = (sessionId: string, root: string, journalId?: string, inheritWelcomeDraft = false, kindHint?: string): void => {
    setSchedulesMain(false); // 任何会话导航都关定时任务层(记录打开会话/侧栏点会话同路)
    // 临时会话思想(2026-10-29 用户设计定版):欢迎页=临时会话,发出去(欢迎页输入建席)时临时座
    // 变真座——草稿整座继承到新会话,欢迎页重获新空临时座;开既有会话不继承(全隔离——8d83fa5
    // 前的泄漏=迁移对开既有会话同样生效,本门即边界:仅 inheritWelcomeDraft 路径放行)
    if (inheritWelcomeDraft && isWelcome && sessionId !== '') {
      const draft = tabStates[WELCOME_TAB_SEAT];
      if (draft !== undefined && draft.tabs.length > 0) {
        const target = tabStates[sessionId];
        if (target === undefined || target.tabs.length === 0) {
          const { [WELCOME_TAB_SEAT]: _moved, ...rest } = tabStates;
          setTabStates({ ...rest, [sessionId]: { ...draft, collapsed: false } });
        }
      }
    }
    // 热切换 keep-alive:切走前把当前会话座登记为驻留座(状态即将被新会话覆写,须先取)。
    // page==='chat' 门:New chat 只切页不清会话态——从欢迎页开新会话时旧 Chat 已不在显示,
    // 不应凭空驻留(否则白建一棵隐藏树,且测试的「无 s1 条目串扰」契约被打破)。
    // 2026-11-18 二轮:驻留最近 2 个(LRU)——三个会话轮转皆无感,内存仍封顶;
    // 目标座若在驻留表中则移出(它回前台,不是驻留)
    {
      const prev = page === 'chat' && sessionId !== openSessionId && openSessionId !== ''
        ? { id: openSessionId, journalId: openJournalId, root: openRoot, kind: openKind }
        : null;
      setCachedSeats((list) => {
        const next = list.filter((s) => s.id !== sessionId);
        return prev !== null ? [prev, ...next.filter((s) => s.id !== prev.id)].slice(0, 2) : next;
      });
    }
    sessionRef.current = sessionId;
    const jid = journalId !== undefined && journalId !== '' ? journalId : sessionId;
    // 显式标记未读压制旗清理(2026-11-07):用户再次进入该会话=openSession,蓝点生命周期到此为止
    clearAutoSeenSuppressed(jid);
    setOpenSessionId(sessionId);
    setOpenJournalId(jid);
    setOpenRoot(root);
    setOpenKind(kindHint);
    // 同档旧座位并入当前座(运行时 id 换号后的孤儿座:页签/常驻 webview 不随重开累积)
    const staleSeats: string[] = [];
    if (jid !== sessionId) {
      for (const [seat, j] of seatJournalRef.current) if (j === jid && seat !== sessionId) staleSeats.push(seat);
      for (const seat of staleSeats) seatJournalRef.current.delete(seat);
      seatJournalRef.current.set(sessionId, jid);
    }
    setTabStates((s) => ensureSession(adoptStaleSeats(s, staleSeats, sessionId), sessionId, PROBE));
    reopenBoardSeedWindow();
    setProjection(EMPTY_PROJECTION()); // D34 串态收口:sessionTodos 漏清三处之二/三随收口补齐(纪律落实)
        setTodoBatches([]);
        setSeededTodoBatches([]);
    // G14.2xx b 子智能体聚合不清零(按会话分桶,切回直接内存命中——零拉取零重建;刷新/重连才走影子水合)
    // 影子水合前置触发:sessionRef 已同步更新、hydrating 标记在此即刻落位——effect 渲染周期前的
    // 实时帧也会被截流缓冲,水合落定按 seq>cut 合并零丢帧(del 标记=每次进入重水合取最新)
    shadowHydratedRef.current.delete(sessionId);
    shadowHydrateRef.current?.(sessionId);
    setPage('chat');
    recordNav({ k: 'chat', sessionId, root, journalId: jid }); // 导航史记录(navLock 回放期自抑制)
    // G14.2xx 恢复现场指针:打开即记应用级档(lastRoot+journal;新会话无 journal 记空——
    // 重启后只回落工作区,不凭空造会话);刷新/重开浏览器据此重放打开链
    // 在座登记(直达快路径数据源):journal 键 + 运行时键双登记(journal 未铸时侧栏按运行时 id 寻址)
    liveSeatRef.current.set(jid, { sessionId, root, ...(kindHint !== undefined ? { kind: kindHint } : {}) });
    if (sessionId !== jid) liveSeatRef.current.set(sessionId, { sessionId, root, ...(kindHint !== undefined ? { kind: kindHint } : {}) });
    void connRef.current
      ?.saveAppGuiState({ v: 1, lastRoot: root, ...(journalId !== undefined && journalId !== '' ? { lastJournalId: journalId } : {}) })
      .catch(() => undefined);
  };

  // 升级链 journalId 回填(2026-11-07 用户实测「欢迎页升级首条完成仍亮未读/点行清草稿」根修):
  // 欢迎发送=临时 id 开席(openJournalId 暂=sessionId),journal 首个事件才建档,id 此后才有。
  // recents 行带 liveSessionId(journal↔活跃会话反查)——本会话收束/侧栏 bump 后对账一回填
  // openJournalId,Chat 的已读压读与草稿键切换随之落到稳定 journal 键。openJournalId≠sessionId
  // (=已回填/正常打开链)即跳过
  useEffect(() => {
    const conn = connRef.current;
    if (conn === null || openSessionId === '' || page !== 'chat') return;
    if (openJournalId !== openSessionId) return;
    if (typeof conn.recentSessions !== 'function') return;
    let alive = true;
    void conn.recentSessions().then(
      (rows) => {
        if (!alive) return;
        const hit = rows.find((r) => r.liveSessionId === openSessionId);
        if (hit !== undefined) setOpenJournalId(hit.id);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [recentVersion, openSessionId, openJournalId, page, runningIds.size]);
  /** 恢复现场(use-restore-last 单点,2026-10-27 技术债轮 D53 批F 外提):指针档重放打开链,
   *  单次闸防 StrictMode 双跑(与既有 effect 序一致——原位即在此回调域) */
  useRestoreLast({ connInstance, connState, openSession });

  /** 返回欢迎态的壳层清场(记录面分离:backHome 记史,导航回放经 applyNav 复用本函数) */
  const leaveToWelcome = useStableCallback((): void => {
    setSchedulesMain(false);
    setCachedSeats([]); // 回欢迎页释放驻留 DOM(内存有界;再开走 chatMem 快路径)
    sessionRef.current = '';
    setOpenSessionId('');
    setOpenJournalId('');
    setOpenRoot('');
    reopenBoardSeedWindow();
    setProjection(EMPTY_PROJECTION()); // D34 串态收口:sessionTodos 漏清三处之二/三随收口补齐(纪律落实)
        setTodoBatches([]);
        setSeededTodoBatches([]);
    // G14.2xx b 子智能体聚合不清(按会话分桶=内存缓存,重开同会话直接命中)
    setPage('welcome');
  });

  /** 返回欢迎态:会话关窗(Chat 卸毁本地态;连接保持,再开经左栏重播种)+ 板投影/team 清零
   *  (无会话期无帧消费,残留即陈旧)+ 播种窗缓冲清(再开重开窗);tabStates 保留(每会话
   *  独立留存,spec §1——重开同会话标签还原) */
  const backHome = useStableCallback((): void => {
    leaveToWelcome();
    recordNav({ k: 'welcome' });
  });
  /** 归档/删除当前会话回欢迎页(2026-11-04 用户裁定):事件监听挂一次,经 ref 取最新 backHome */
  const backHomeRef = useRef(backHome);
  backHomeRef.current = backHome;

  /** 应用级导航历史(use-nav-history 单点,2026-10-27 技术债轮 D53 批D 外提):记录/回放/控制面/
   *  Alt+←/→ 键面一条链一个文件(navLock 回放抑制/零过期闭包语义随码);落点动词注入
   *  (welcome=壳层清场,chat=openSession 直达——会话常驻 daemon 零重播链) */
  const { navControls, recordNav } = useNavHistory({ goWelcome: leaveToWelcome, openSession, settingsOpen: settingsOpen || schedulesMain });

  /** G8c-T8 开设置态:settingsRoot 快照当前 openRoot(无会话=''=仅全局);connInstance 在场才
   *  可达(设置钮只在 ProjectMenu 底栏,其渲染前提即连接装配完成) */
  const openSettings = useCallback((): void => {
    setSchedulesMain(false); // 设置覆盖层与定时任务层互斥(设置壳整幅覆盖)
    setSettingsRoot(openRoot);
    setSettingsOpen(true);
  }, [openRoot]);

  /** G8c-T8 回会话态(返回钮/Esc 同路径):page 态未动——开设置前是 chat 则回 chat(Chat 重挂
   *  重播种),welcome 则回欢迎空态;关壳即 bump settingsEpoch 重读 agentTeams(表单 autosave 已落) */
  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    setSettingsPane(undefined);
    setSettingsEpoch((v) => v + 1);
  }, []);

  /** 2026-11-16 流畅轮恒稳回调簇(全部 useStableCallback——读面经当帧闭包,身份恒定):
   *  memo 化三子树的下发面。原内联箭头逐渲染换新,击穿 memo=App 壳任一 setState 全树重渲 */
  const toggleMenuStable = useStableCallback((): void => {
    const opening = menuClosed;
    setMenuClosed(!menuClosed);
    // 两侧抽屉互斥(2026-10-24 用户裁定):开菜单抽屉即收右抽屉
    if (opening && sidebarFloating && !tabState.collapsed) {
      setTabStates((s) => setCollapsed(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, true));
    }
  });
  const chatSeededStable = useStableCallback((snap: SnapshotResponse): void => {
    seedFromSnapshot(snap);
    // todo 批次权威投影播种(daemon journal 全量派生;快照未带=旧 daemon,清空走纯派生面)
    setSeededTodoBatches(snap.todoBatches ?? []);
  });
  const runInTerminalStable = useStableCallback((command: string): void => {
    openTabInSession('terminal', { nonce: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, seedCmd: command });
  });
  const todoLocateStable = useStableCallback((todos: Array<{ text: string; status: string }>): void => {
    openTabType('tasks');
    setTodoLocateSig({ sig: todos.map((t2) => t2.text).join('\n'), nonce: Date.now() });
  });
  const openParentSessionStable = useStableCallback((sid: string): void => {
    // fork 横幅回父会话(attach 两步同侧栏 attachJournal):sid=父 journal id——daemon
    // 重启后 runtime 表按新壳 id 重挂,裸 journal id snapshot 404(实测);newSession 壳+
    // attach 收养,返回 id 为准(在座运行中收编/换挂),journalId 随行保滚动位稳定键
    const conn = connRef.current;
    if (conn === null) return;
    void conn
      .newSession(openRoot)
      .then(({ sessionId }) => conn.attach(sessionId, sid).then((r) => ({ sid: r.sessionId, root: r.root || openRoot })))
      .then(({ sid: canonical, root }) => openSession(canonical, root, sid))
      .catch(showOpError);
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
  /** 定时任务层开合(2026-11-20):侧栏入口开(抽屉态自动收),页内返回/Esc 关 */
  const openSchedulesFromMenu = useStableCallback((): void => {
    closeMenuDrawer();
    setSchedulesMain(true);
  });
  const closeSchedulesStable = useStableCallback((): void => setSchedulesMain(false));
  /** 「在会话中创建」：退层 → 欢迎页 → 输入框预填示例提示词（用户可改后发送；agent 用
   *  create_scheduled_task 工具落档）——与 New chat 同路径，goal 走 preset 序号通道 */
  const createScheduleInChatStable = useStableCallback((): void => {
    setSchedulesMain(false);
    presetCompose(null, scheduleCreateExample());
    setPage('welcome');
    recordNav({ k: 'welcome' });
  });
  /** 记录 → 会话(定时任务 Task 11):关层 + 既有 newSession+attach 打开链(daemon 在座会收编/复用),
   *  root 取 attach 应答真根、缺省回退记录行根;失败经 showOpError 上屏 */
  const openJournalSessionStable = useStableCallback((journalId: string, root: string): void => {
    setSchedulesMain(false);
    const conn = connRef.current;
    if (conn === null) return;
    void conn
      .newSession(root)
      .then(({ sessionId }) => conn.attach(sessionId, journalId))
      .then((r) => openSession(r.sessionId, r.root || root, journalId))
      .catch(showOpError);
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
  /** 右栏页签条回调簇(TabStripMemo 下发面) */
  const tabSelectStable = useStableCallback((uid: string): void => setTabStates((s) => setActive(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, uid)));
  const tabReorderStable = useStableCallback((fromUid: string, toUid: string): void => setTabStates((s) => reorderTab(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, fromUid, toUid)));
  const tabCloseStable = useStableCallback((uid: string): void => closeTabInSession(uid));
  const tabOpenTypeStable = useStableCallback((t: TabTypeId): void => {
    // G14.2xx 辅助对话特判:sidechat 需先 fork 出 side 会话(拿 sideId)再开页——
    // 直接 openTab 只会落无 sideId 的空壳档;startSideChat 完成装配+开页一条龙
    if (t === 'sidechat') {
      startSideChat();
      return;
    }
    if (t === 'agents' && !agentTeamsOn) return;
    openTabInSession(t, tabEntry(t).mintParams?.());
  });
  const tabCycleStable = useStableCallback((d: 1 | -1): void => setTabStates((s) => cycleTab(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, d)));
  const tabReopenClosedStable = useStableCallback((i: number): void => {
    const seat = isWelcome ? WELCOME_TAB_SEAT : openSessionId;
    const entry = tabStatesRef.current[seat]?.recentClosed[i];
    if (entry?.type === 'agents' && !agentTeamsOn) return;
    setTabStates((s) => reopenClosed(s, seat, i, PROBE));
  });
  const tabCloseActiveStable = useStableCallback((): void => {
    const uid = tabStatesRef.current[isWelcome ? WELCOME_TAB_SEAT : openSessionId]?.activeUid;
    if (uid !== null && uid !== undefined) closeTabInSession(uid);
  });

  /** G8a 开标签(会话内):Chat write 工具 path 按钮 / 标签条「+」菜单共用——判重聚焦经
   *  tab-state(同目标重开=聚焦既有,单例类型单份)。G14.211 useCallback+sessionRef 零依赖
   *  稳定:内联闭包随 App 渲染换新,击穿 ChatEntryView memo——点一次文件=全列表重渲染闪帧
   *  (正文抖动源之一);sessionRef 恒同步 openSessionId,无过期闭包面 */
  /** 可刷新侧栏打开信号:正文/顶栏每次 open 递增,页签据此主动拉一次 */
  const [panelRefreshNonce, setPanelRefreshNonce] = useState<number | undefined>(undefined);
  const openTabInSession = useCallback((type: TabTypeId, params: TabParams = {}): void => {
    // 2026-10-27 欢迎页全局草稿:无会话(欢迎页)写 '@welcome' 草稿座——临时会话思想:发出去
    // (欢迎页建席,openSession 第 4 参)才整座继承到新会话;开既有会话零交集(继承门见 openSession)
    const seat = isWelcome ? WELCOME_TAB_SEAT : openSessionId;
    // G14.38:程序化开标签即展开右栏(默认折叠下 write/diff/目录跳转/卡片开面板均可见)
    setTabStates((st) => setCollapsed(st, seat, false));
    setTabStates((s) => openTab(s, seat, type, params, PROBE));
    // 带刷新钮的侧栏:打开即刷一次(keep-alive 常挂时仅切激活不会重挂载)
    if (REFRESHABLE_TAB_TYPES.has(type)) setPanelRefreshNonce(Date.now());
    // isWelcome 必入依赖(2026-10-29 用户实测「欢迎页点浏览器/终端不开,开会话才见=绑定错了」
    // 根修):5232DCE 起进欢迎页不清 openSessionId——chat→welcome 若 openSessionId 不变,本回调
    // 不重建,闭包滞留聊天页 isWelcome=false,落座写成会话座;渲染层读 '@welcome' 恒空,开会话
    // 才见标签(草稿座迁移链忠实搬运了写错座的档)。fe55c46 修同族三处判定时此处依赖遗漏
  }, [openSessionId, isWelcome]);
  // 2026-11-10 用户裁定「写入/编辑跳转复用本轮 diff 页签,不再跳审查页」:write/edit 工具行跳转
  // (callId 寻址)与轮尾改动条(run+path 寻址)统一开 turndiff 单文件页签;'diff' 型保留=审查页
  // 空入参守卫(2026-11-10 用户裁定「去掉本轮空页签入口」):无 callId 且无 path 的裸开=「没有可展示的内容」死页签,不开
  const openDiffTab = useCallback((callId: string, path: string): void => { if (callId === '' && path === '') return; openTabInSession('turndiff', { callId, path: path.replaceAll('\\', '/').replace(/^(\.\/)+/, '') }); }, [openTabInSession]);
  // 轮尾行点击(2026-11-11 用户裁定「当作一个区域处理」):同文件已有 turndiff 页签(刀级 callId
  // 寻址)就地处切 run+path 聚合寻址并激活——同文件恒一签,点轮尾=看聚合、点工具行=看那一刀
  const openTurndiffTab = useCallback((run: number, path: string): void => {
    if (path === '') return;
    // 路径归一(2026-11-12):反斜杠统一+剥 ./ 前缀——'./edit-test.md' 与 'edit-test.md' 是同一文件,
    // 不归一则复用匹配打穿(实测三页签并存)
    const norm = path.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
    const seat = tabStatesRef.current[openSessionId];
    const existing = seat?.tabs.find((tb) => tb.type === 'turndiff' && (tb.params.path ?? '').replaceAll('\\', '/').replace(/^(\.\/)+/, '') === norm);
    if (seat !== undefined && existing !== undefined) {
      setTabStates((s) => setActive(patchTurndiffAddressing(s, openSessionId, existing.uid, { run, path: norm }), openSessionId, existing.uid));
      return;
    }
    openTabInSession('turndiff', { run, path: norm });
  }, [openTabInSession, openSessionId]);
  const openAgentTab = useCallback((label: string, agentTitle?: string, task?: string, focusTaskId?: string): void => { openTabInSession('agent', { label, agentTitle, task, focusTaskId }); }, [openTabInSession]);
  /** 成员转录 leader 链接点击(2026-11-08 用户裁定「定位到主对话对应发送位置,不打开页签」):
   *  记 {member,text,dir,nonce} 下发 Chat——主对话滚到对应消息气泡/发送工具行并闪光 */
  const [leaderFocus, setLeaderFocus] = useState<{ member: string; text: string; dir: 'toLeader' | 'fromLeader'; nonce: number } | null>(null);
  const openLeaderBubble = useCallback((m: { member: string; text: string; dir: 'toLeader' | 'fromLeader' }): void => { setLeaderFocus({ ...m, nonce: Date.now() }); }, []);
  /** 浏览器工具联动(2026-10-31 用户裁定「浏览器默认直接打开侧栏的浏览器」):agent 走
   *  browser_navigate 时 Chat 上抛 url,此处开 web 页签跟随(判重由 openTabInSession 承担) */
  const openWebTab = useCallback((url: string): void => { openTabInSession('web', { url }); }, [openTabInSession]);
  /** M2 融合(2026-11-02 用户裁定「页内超链接开新页签,和浏览器一样」):guest 弹窗 URL 由壳转发
   *  (main setWindowOpenHandler → builtin:open-url),此处开新侧栏 web 页签;判重由 openTab 承担 */
  // 订阅只挂一次,回调经 ref 取最新 openWebTab(闭包滞留首帧会话座=开签落错座,页签不可见)
  const openWebTabRef = useRef(openWebTab);
  openWebTabRef.current = openWebTab;
  // 会话删除:卸载其座位的页签(常驻池里的 webview 随之销毁,不再占资源);删的是正开会话则
  // 主对话回欢迎页(2026-11-04 用户裁定,归档同裁定)
  useEffect(() => {
    const onDeleted = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      if (id === sessionRef.current || id === openJournalIdRef.current) backHomeRef.current();
      const seats = new Set([id, ...seatsOfBrowserKey(id)]);
      setTabStates((s) => {
        if (![...seats].some((seat) => s[seat] !== undefined)) return s;
        const next = { ...s };
        for (const seat of seats) delete next[seat];
        return next;
      });
    };
    const onArchived = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      if (id === sessionRef.current || id === openJournalIdRef.current) backHomeRef.current();
    };
    window.addEventListener(SESSION_DELETED_EVENT, onDeleted);
    window.addEventListener(SESSION_ARCHIVED_EVENT, onArchived);
    return () => {
      window.removeEventListener(SESSION_DELETED_EVENT, onDeleted);
      window.removeEventListener(SESSION_ARCHIVED_EVENT, onArchived);
    };
  }, []);
  const curSeatRef = useRef('');
  curSeatRef.current = isWelcome ? WELCOME_TAB_SEAT : openSessionId;
  useEffect(() => {
    const bridge = window.sunshinexWindow;
    if (bridge?.onOpenUrl === undefined) return;
    // 归座(浏览器状态按会话隔离):agent 开页带座位;页内弹窗按开启者 webview 所在座位;
    // 非当前座位只入该座位(后台会话的 agent 不打扰用户视图),当前座位走既有开签(展开侧栏)
    return bridge.onOpenUrl((url, target) => {
      const seat = target?.seat ?? (target?.openerWebContentsId !== undefined ? seatOfWebContents(target.openerWebContentsId) : undefined);
      if (seat === undefined || seat === '' || seat === curSeatRef.current) {
        openWebTabRef.current(url);
        return;
      }
      setTabStates((s) => openTab(ensureSession(s, seat, PROBE), seat, 'web', { url }, PROBE));
    });
  }, []);
  /** 托盘菜单动作(壳 tray:action,2026-11-07 用户裁定三组菜单):主进程已唤窗,此处只导航——
   *  最近会话走 attach 两步(同侧栏:newSession 装壳 → attach 播种 → openSession)/新对话/设置/
   *  设置·快捷键面。监听挂一次,经 ref 取最新闭包 */
  const trayActionRef = useRef<(a: SxTrayAction) => void>(() => undefined);
  trayActionRef.current = (a) => {
    closeMenuDrawer();
    if (a.kind === 'settings' || a.kind === 'shortcuts') {
      if (a.kind === 'shortcuts') setSettingsPane({ id: 'shortcuts' });
      if (!settingsOpen) openSettings();
      return;
    }
    if (settingsOpen) closeSettings();
    if (a.kind === 'new-chat') {
      presetCompose(null);
      setPage('welcome');
      recordNav({ k: 'welcome' });
      return;
    }
    if (connInstance === null) return;
    connInstance
      .newSession(a.root)
      .then(({ sessionId }) => connInstance.attach(sessionId, a.journalId))
      .then(
        (r) => openSession(r.sessionId, r.root || a.root, a.journalId, false, r.kind),
        (err: unknown) => console.error('[tray] open session failed:', err),
      );
  };
  useEffect(() => window.sunshinexWindow?.onTrayAction?.((a) => trayActionRef.current(a)), []);
  /** agents 页签 id=智能体团队页签(卡片流;tab 持久化档兼容保留旧 id);agentTeams 关闭时不挂载 */
  const openBoardTab = useCallback((): void => {
    if (!agentTeamsOn) return;
    openTabInSession('agents', {});
  }, [openTabInSession, agentTeamsOn]);
  const openTabType = useCallback((type: TabTypeId): void => {
    if (type === 'agents' && !agentTeamsOn) return;
    openTabInSession(type, {});
  }, [openTabInSession, agentTeamsOn]);
  const openArtifactsTab = useCallback((): void => {
    openTabInSession('artifacts', {});
  }, [openTabInSession]);
  const hiddenMenuIds = useMemo(
    () => (agentTeamsOn ? undefined : new Set<string>(['agents'])),
    [agentTeamsOn],
  );

  /** G14.211 onFork 跳板:实体逻辑挂 ref(每渲染刷新,无过期闭包),回调整体零依赖恒稳 */
  const forkLatestRef = useRef((_turn?: number) => {});
  forkLatestRef.current = (turn?: number): void => {
    if (connInstance === null) return;
    void connInstance
      .sessionAnchors(openSessionId)
      .then(async (a) => {
        // 逐轮 fork(2026-11-04 用户裁定「fork 显示点击点之上所有记录」):turn 在场=点击 run 的
        // 轮序位(点哪轮,分档切在该轮锚点前=新会话时间线即其上全部记录);缺省=最近轮(原行为)
        const last = turn ?? (a.length > 0 ? a[a.length - 1]!.turn : 1);
        const r = await connInstance.forkSession(openSessionId, last);
        // 侧栏内容随 fork 复制(2026-11-04 用户裁定):父座位页签克隆到子座位——旁路对话页签除外
        // (sidechat 语义绑定父档),终端剥 ptyId(pty 归父会话进程,子会话点开即新开);active 不
        // 还原(「侧栏不必还原成父会话的打开状态」)——子座位空 active,页签条全在
        setTabStates((s) => {
          const p = s[openSessionId];
          if (p === undefined || p.tabs.length === 0) return s;
          const tabs = p.tabs
            .filter((t) => t.type !== 'sidechat')
            .map((t) => (t.params.ptyId !== undefined ? { ...t, params: { ...t.params, ptyId: undefined } } : t));
          return { ...s, [r.sessionId]: { ...emptyTabSession(), tabs, activeUid: null } };
        });
        openSession(r.sessionId, openRoot);
      })
      .catch(showOpError);
  };
  const onForkStable = useCallback((turn: number): void => { forkLatestRef.current(turn); }, []);
  /** 回退(2026-11-05 编辑重发/回到此轮):daemon 挂新会话对象+截短档,此处换座——正文与动态侧栏
   *  (板/待办/子智能体/后台任务)由 openSession+快照播种按新档重建,静态页签按回退点迁座;
   *  编辑文本走 pendingGoal 接力(播种落定才提交,回显不被整替冲掉),纯回退则原文回填新座草稿 */
  const rewindLatestRef = useRef((_req: RewindRequest): Promise<void> => Promise.resolve());
  rewindLatestRef.current = async ({ target, restoreFiles, resend }): Promise<void> => {
    if (connInstance === null) return;
    const from = openSessionId;
    let r: RewindResult;
    try {
      r = await connInstance.rewindSession(from, target, restoreFiles);
    } catch (err) {
      showOpError(err);
      throw err;
    }
    setTabStates((s) => rewindSeat(s, from, r.sessionId, r.atTs)); // 座档随 spread 带走 sideDismissed(关闭记忆随座迁移)
    setWelcomeGoal({ root: openRoot, goal: resend.text, ...(resend.images !== undefined ? { images: resend.images } : {}) });
    setRecentVersion((v) => v + 1);
    openSession(r.sessionId, openRoot, r.journalId);
  };
  const onRewindStable = useCallback((req: RewindRequest): Promise<void> => rewindLatestRef.current(req), []);

  /** pty 记账(use-pty-registry 单点,2026-10-27 技术债轮 D53 批F 外提):terminal 标签 uid→ptyId */
  const { handlePtyAllocated, ptyIdFor, takePtyId } = usePtyRegistry(isWelcome ? WELCOME_TAB_SEAT : openSessionId, setTabStates);

  /** G8b 关标签链(TabStrip onClose/onCloseActive 共用):被关标签为 terminal 且 pty 已记账 →
   *  fire-and-forget killPty(拒约吞——关标签不等 HTTP;已关会话侧幂等)再关标签态 */
  const closeTabInSession = (uid: string): void => {
    // 辅助对话页签关闭即记忆(重进主会话不复活;切会话不误记——按当前席上该页签的 sideId 记)
    const seat = isWelcome ? WELCOME_TAB_SEAT : openSessionId;
    const tab = tabStates[seat]?.tabs.find((x) => x.uid === uid);
    if (tab !== undefined && tab.type === 'sidechat' && tab.params.sideId !== undefined) {
      // 关闭记忆入座档落盘(2026-11-06 移入 TabSessionState):sideId+sideJournal 双键——
      // daemon 重启后 live id 失效,恢复对账按 journal 判「关过不复活」
      const sj = tab.params.sideJournal;
      setTabStates((s) => addSideDismissed(s, seat, typeof sj === 'string' ? [tab.params.sideId!, sj] : [tab.params.sideId!]));
    }
    const t = tabState.tabs.find((x) => x.uid === uid);
    if (t?.type === 'terminal') {
      // 记账键=座位+uid:欢迎页转移入会话的终端账仍在 '@welcome' 座(注册表 curSeat 已切)——
      // 出账 miss 回落盘档 params.ptyId(转移链整座搬运,档必在);app 域 pty(draftPty 旗)走
      // killPtyAt 直杀(会话段 kill 归属校验不认 '@app')
      const ptyId = takePtyId(uid) ?? (typeof t.params.ptyId === 'string' ? t.params.ptyId : undefined);
      if (ptyId !== undefined) {
        const conn = connRef.current;
        // killPty 尽力而为:标签已关,失败=daemon 侧 pty 随会话 teardown 兜底回收,无用户可见后果
        if (conn !== null) {
          if (isWelcome || t.params.draftPty === true) void conn.killPtyAt(ptyId).catch(() => {});
          else void conn.killPty(openSessionId, ptyId).catch(() => {});
        }
      }
    }
    setTabStates((s) => closeTab(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, uid));
  };

  /** 2026-11-10 终端下栏标签关闭:同一 kill 链单点复用(takePtyId 出账→killPty 尽力而为)——
   *  dock 标签 uid(dock-term-<n>)与右栏页签 uid 在同一座位记账表内不相交 */
  const closeDockTab = useCallback(
    (uid: string): void => {
      const ptyId = takePtyId(uid);
      if (ptyId === undefined) return;
      const conn = connRef.current;
      if (conn !== null) void conn.killPty(openSessionId, ptyId).catch(() => {});
    },
    [takePtyId, openSessionId],
  );


  /** 当前会话标签席(welcome 期空席占位——TabStrip 灰条;宽 32) */
  // G14.2xx b 影子水合触发:会话打开即拉 journal subagent 行重建子智能体投影(每会话一次;
  // 重连场景由 onReset 清标记重触发)。activities 内存尚在(切走再回)即跳过——不重复水合
  useEffect(() => {
    if (connInstance === null || connState !== 'open' || openSessionId === '') return;
    if (shadowHydratedRef.current.has(openSessionId)) return;
    shadowHydratedRef.current.add(openSessionId);
    shadowHydrateRef.current?.(openSessionId);
  }, [connInstance, connState, openSessionId]);

  /** 标签态持久化(use-tab-persistence 单点,2026-10-27 技术债轮 D53 批C-3 外提):附接水合拉档
   *  + 变更写透防抖,盘↔内存同步效应在钩子内(水合闸/防抖句柄为钩子私域) */
  useTabPersistence({ connInstance, connState, openSessionId, tabStates, setTabStates });

  const tabState = tabStates[isWelcome ? WELCOME_TAB_SEAT : openSessionId] ?? emptyTabSession();
  /** G14.2xx 限宽动态化容器 ref(--chat-max RO 双盯;sidebarRef 另供拖宽直写——声明须先于
   *  useShellLayout,后者拖拽回调闭包引用) */
  const mainRef = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  /** 活动标签滚动容器(自绘 vbar 数据源):仅活动 tabbody 绑定——keep-alive 隐藏面零监听零几何 */
  const tabBodyRef = useRef<HTMLDivElement | null>(null);
  /** 浏览器页签池:全部座位的 web 页签(切会话/收侧栏/进设置不卸载,后台会话 agent 仍可驱动) */
  const webPoolItems = useMemo<WebPoolItem[]>(
    () => Object.entries(tabStates).flatMap(([seat, st]) => st.tabs.filter((t) => t.type === 'web').map((t) => ({ seat, uid: t.uid, params: t.params }))),
    [tabStates],
  );
  /** 三栏几何簇(use-shell-layout 单点,2026-10-27 技术债轮 D53 批C-1 外提):视口跟踪/浮窗阈值/
   *  抽屉态/菜单与右栏渲染期钳制/占宽/拖宽手柄,判定序与裁定注释随码在钩子内 */
  const {
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
  } = useShellLayout({
    shellRef,
    sidebarRef,
    resizeCleanupRef,
    page,
    settingsOpen,
    openSessionId,
    tabCollapsed: tabState.collapsed,
    tabWidth: tabState.width,
    setTabStates,
  });
  /** 记忆/技能/目录/文件/任务定位/SUNX 实例开签簇收口 use-app-links(D62 批H;setMenuClosed
   *  来自 useShellLayout——本调用置于其后,前向引用仅限延迟闭包判例同 534/566 形) */
  const {
    memoryFocus, openMemoryTab, learnedFocus, openLearnedTab, menuDir,
    openProjectDirectory, openDirectoryPath, openFileTab, openFileFromTree, openSunxInstance,
    bgFocus, openTaskFocus, setMenuDir,
  } = useAppLinks({ connInstance, connRef, openRoot, openSessionId, openSession, openTabInSession, openBoardTab, setTaskFocus, setMenuClosed, showOpError });
  /** 文件树点开(2026-11-20 终审 minor):关定时任务层——层内无文件树,但层在时点击不应在层后开页签 */
  const openFileFromTreeStable = useStableCallback((filePath: string, root: string): void => {
    setSchedulesMain(false);
    openFileFromTree(filePath, root);
  });
  /** 标签体服务面+页签元数据回写+板刷新+side 快照并入+派生值面收口 use-app-services(D62 批H) */
  const { onActivateTab, onTabMeta, services, bgRunningCount, projectNameOfOpenRoot } = useAppServices({ connRef, sessionRef, chatSinkRef, sideParentRef, sideListing, projection, setProjection, setTabStates, agentActivitiesBySession, openSessionId, openRoot, setBgTasks, bgTasks, todoBatches, seededTodoBatches, setTodoBatches, taskFocus, openTaskFocus, todoLocateSig, onLocateTodo, openLeaderBubble, refreshFromSnapshot });
  const activeTab = tabState.tabs.find((t) => t.uid === tabState.activeUid) ?? null;

  /** 面板开合平滑(2026-11-18 用户裁定「应用的侧栏、菜单栏,下栏,展开和关闭要平滑效果」):
   *  左菜单/右栏均条件渲染,收起时先保留挂载 200ms 让根节点关闭类跑完宽度过渡再卸载;
   *  打开立即挂载,根节点自带 sx-panel-in 入场 keyframe */
  const menuAnim = useCollapseTransition(!menuClosed);
  const sidebarAnim = useCollapseTransition((page === 'chat' || page === 'welcome') && !tabState.collapsed);

  useWindowDrag();

  /** keep-alive LRU(use-heavy-tab-lru 单点,2026-10-27 技术债轮 D53 批F 外提):重标签上限 4 */
  useHeavyTabLru({
    tabs: tabState.tabs,
    activeUid: activeTab?.uid ?? null,
    activeType: activeTab?.type,
    closeTabInSession,
  });



  /** G14.2xx 限宽动态化:--chat-max 不再钉 880px——ResizeObserver 分盯 .sx-main 与 .sx-sidebar,
   *  各按自身实时内容宽经 chatMaxFor 阶梯落内联值(同一策略覆盖主对话、欢迎页、辅助对话、
   *  子智能体转录页;流列/输入卡随三栏拖拽、右栏折叠、视口缩放即时跟宽)。首次 observe 即回调,
   *  首帧就位零闪;jsdom 桩回调宽 0,chatMaxFor 托底不落负。deps:两容器随设置态/页面/折叠/
   *  切会话换挂,重挂后需重挂观察器;定时任务层开合也令右栏卸载/重挂(2026-11-20 评审) */
  useEffect(() => {
    const els = [mainRef.current, sidebarRef.current].filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const t = entry.target as HTMLElement;
        t.style.setProperty('--chat-max', `${Math.round(chatMaxFor(entry.contentRect.width))}px`);
        // 写入方直发(I4 根修,2026-10-27):一手通知替代消费方全树 MutationObserver 观测写入后果
        t.dispatchEvent(new Event(CHAT_MAX_EVENT, { bubbles: true }));
      }
    });
    els.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [settingsOpen, page, tabState.collapsed, openSessionId, schedulesMain]);

  // 目录打开上下文(2026-10-30):正文目录芯片 → openDirectoryPath(在册项目左侧树定位展开;区外按
  //  左上角配置的打开方式外开)——Chat/tabs 全子树可达
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
              onOpenSchedules={openSchedulesFromMenu}
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
                      onOpenTab={openTabType}
                      onOpenArtifacts={openArtifactsTab}
                      agentTeamsOn={agentTeamsOn}
                      bgRunning={bgRunningCount}
                      board={projection.board}
                      teams={projection.teams}
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
      <WindowControls showSideToggle={(page === 'chat' || page === 'welcome') && !settingsOpen} onToggleRightSidebar={() => {
        const opening = tabState.collapsed;
        setTabStates((s) => setCollapsed(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, !opening));
        // 两侧抽屉互斥(2026-10-24 用户裁定):浮窗态开右抽屉即收菜单抽屉
        if (opening && sidebarFloating) setMenuClosed(true);
      }} />
    </div>
    </DirOpenerContext.Provider>
  );
}
