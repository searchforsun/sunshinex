import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Connection, ConnectionState, SnapshotResponse } from './connection';
import type { TodoItem } from '../../src/types';
import type { SessionProjection } from './projection';
import { EMPTY_PROJECTION, useConnectionWiring } from './use-connection-wiring';
import type { ChatSink } from './pages/Chat';
import { registryProbe } from './tabs/registry';
import { SESSION_DELETED_EVENT } from './session-events';
import { ensureSession, setCollapsed, emptyTabSession, adoptStaleSeats, WELCOME_TAB_SEAT } from './tabs/tab-state';
import type { TabStates } from './tabs/tab-state';
import { useBoardSeed } from './use-board-seed';
import { readPersistedProject } from './welcome/use-welcome-persisted';
import type { WelcomeGoal } from './welcome/WelcomeComposer';
import { CHAT_MAX_EVENT, chatMaxFor } from './thread-width';
import { useDeveloperMode } from './developer-mode';
import { applyTheme, currentTheme } from './theme';
import type { SearchAction } from './search-actions';
import { useAppearanceSync } from './use-appearance-sync';
import { useOpError } from './use-op-error';
import { useShellLayout } from './use-shell-layout';
import { useTabPersistence } from './use-tab-persistence';
import { useAgentBuckets, useChatMemory, useShadowHydrationRefs, bindShadowHydration } from './use-agent-projections';
import { useNavHistory } from './use-nav-history';
import { installShortcutDispatcher, setShortcutsSuspended } from './shortcuts/dispatch';
import { useRestoreLast } from './use-restore-last';
import { useWindowDrag } from './window-shell';
import { useAppLinks } from './use-app-links';
import { useAppServices } from './use-app-services';
import { useAppOverlays } from './use-app-overlays';
import { useAppTabs } from './use-app-tabs';
import { useAppMenu } from './use-app-menu';
import { useStableCallback } from './use-stable-callback';
import { useAppPins } from './use-app-pins';
import { AppShellPanes, type AppShellPanesProps } from './app-shell-panes';
export { emptyTabCardIds } from './app-shell-panes';
import { useAppRewind } from './use-app-rewind';
import { useHeavyTabLru } from './use-heavy-tab-lru';
import { prefetchEditorIcons } from './ui-util';
import { cacheClearResultText, clearCacheAll } from './cache-clear';
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

/** 2026-10-27 欢迎页全局草稿座:无会话(欢迎页)时侧栏标签落此键——临时会话思想(2026-10-29 定版):发出去(欢迎页建席)整座继承到新会话并重获空座;开既有会话零交集 */



export function App(): JSX.Element {
  // G10:token 填写逻辑退役——本地 serve 免鉴权档(恒绑回环),连接不再携带凭证
  return <AppShell />;
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
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [projection, setProjection] = useState<SessionProjection>(EMPTY_PROJECTION);
  /** Chat onTodos 适配(todo_write 批整替进投影;useCallback 恒稳,消费面 JSX 不变) */
  const setSessionTodos = useCallback((todos: TodoItem[]): void => {
    setProjection((p) => ({ ...p, sessionTodos: todos }));
  }, []);
  /** 会话级操作失败提示(use-op-error 单点,2026-10-27 技术债轮 D53 批E 外提):sx-toast 3s 自隐;
   *  showOpMessage=同槽正向提示(缓存清理释放量等,2026-11-21) */
  const { opError, showOpError, showOpMessage } = useOpError();
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
  /** 2026-11-04 待办行点击定位信号(Chat 待办字样→开待办页签+定位对应卡) */
  const [todoLocateSig, setTodoLocateSig] = useState<{ sig: string; nonce: number; title?: string } | null>(null);
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
  /** 设置/定时任务覆盖层状态簇收口 use-app-overlays(D62 专项 环解第一刀)——钩子调用点见 openSession 之后 */
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
  /** 置顶档单源(pins/persistPins/服务端读档)收口 use-app-pins(D62 批H 二段一段);连接就位读档 effect 在钩子内 */
  const { pins, persistPins } = useAppPins(connRef, connInstance);
  // 编辑器图标启动预取(2026-11-07 用户裁定「应用启动时就加载」):模块级缓存暖上,
  // 会话首帧顶栏主钮直显真图标,不再 1/4 字形→真图标跳变
  useEffect(() => {
    if (connInstance !== null) prefetchEditorIcons(connInstance);
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

  /** 设置/定时任务覆盖层状态簇收口 use-app-overlays(D62 专项 环解第一刀):早位于
   *  useShellLayout/useNavHistory 之前供其消费 settingsOpen/schedulesMain——三角环(settings↔layout↔nav)
   *  自此解;菜单包装回调(openSettingsFromMenu 等)留宿主,closeMenuDrawer/recordNav 延迟闭包判例同形 */
  const { settingsOpen, settingsRoot, settingsPane, setSettingsPane, schedulesMain, setSchedulesMain, scheduleFocus, setScheduleFocus, agentTeamsOn, openSettings, closeSettings, openJournalSessionStable } = useAppOverlays({ connInstance, connRef, openRoot, openSession, showOpError, setTabStates });

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
   *  单次闸防 StrictMode 双跑(与既有 effect 序一致——原位即在此回调域)。
   *  onSettled(2026-11-25 开机就绪轮):恢复落空(无指针/链失败)=欢迎页即终态,放行开机画面;
   *  恢复成功不在此放行——等恢复会话首个快照播种落地(chatSeededStable)才交接 */
  useRestoreLast({
    connInstance,
    connState,
    openSession,
    onSettled: (restored) => {
      if (!restored) setBootReady(true);
    },
  });

  /** 开机画面收尾闸(2026-11-25 用户裁定「全部加载到位才显内容,否则显示 loading」):boot-ready
   *  三路放行——①恢复链落定且无会话可恢复(欢迎页终态,useRestoreLast onSettled);②恢复会话首个
   *  快照播种落地(chatSeededStable,转录/页签/投影一次就位);③连接失败面(reconnecting/closed,
   *  放行既有错误面)。就绪前 index.html #boot splash 恒盖(应用壳在下层照常装配拉数据,揭幕
   *  即整装);index.html 内置 8s 兜底,应用卡死不留死屏 */
  const [bootReady, setBootReady] = useState(false);
  useEffect(() => {
    if (!bootReady) return;
    window.__sxBootDone?.(); // 幂等(index.html done 闸);boot 已被兜底移除时静默无副作用
  }, [bootReady]);
  useEffect(() => {
    if (connState === 'reconnecting' || connState === 'closed') setBootReady(true); // 连接失败:放行错误面
  }, [connState]);

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

  /** 通道删除会话清场（2026-11-25 用户报障「删除通道后停在死对话回不到欢迎页」收口）:被 purge 的
   *  会话若正开着,deliberate 回欢迎页(2026-11-04「删除当前会话回欢迎页」裁定同款;页签池卸载
   *  由 use-app-tabs 的 SESSION_DELETED_EVENT 监听承担)。**双寻址**（2026-11-25 复报根修）:
   *  daemon sun-id 每次打开新铸,GUI 正开着的运行时 id 可能≠绑定座 id(或事件只列了 journalId)
   *  ——运行 id 与 journalId 任一命中即回欢迎页 */
  useEffect(() => {
    const onDeleted = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      if (id === undefined) return;
      if (id === sessionRef.current || (openJournalIdRef.current !== '' && id === openJournalIdRef.current)) {
        backHomeRef.current();
      }
    };
    window.addEventListener(SESSION_DELETED_EVENT, onDeleted);
    return () => window.removeEventListener(SESSION_DELETED_EVENT, onDeleted);
  }, []);

  /** 当前会话标签席(welcome 期空席占位——TabStrip 灰条;宽 32) */
  const tabState = tabStates[isWelcome ? WELCOME_TAB_SEAT : openSessionId] ?? emptyTabSession();
  /** tabs 大钩收口 use-app-tabs(D62 专项 二段四段 自 App.tsx 逐字平迁,行为零变化):右栏页签条回调簇/
   *  openTab*族/closeTab 关闭链/sidechat 簇/pty 记账/web 池派生一条域一个文件 */
  const {
    startSideChat, sideGoals, setSideGoals, upgradeSideChat, sideListing, sideReleased,
    tabSelectStable, tabReorderStable, tabCloseStable, tabOpenTypeStable, tabCycleStable, tabReopenClosedStable, tabCloseActiveStable,
    panelRefreshNonce, openTabInSession, openDiffTab, openTurndiffTab, openAgentTab, leaderFocus, openLeaderBubble, openWebTab,
    openBoardTab, openTabType, openTabLit, openArtifactsTab, hiddenMenuIds, closeTabInSession, closeDockTab,
    handlePtyAllocated, ptyIdFor, webPoolItems, curSeatRef,
  } = useAppTabs({ connInstance, connRef, sessionRef, openJournalIdRef, backHomeRef, page, isWelcome, openSessionId, openRoot, tabStates, tabState, setTabStates, agentTeamsOn, sideSinksRef, sideParentRef, probe: PROBE });

  /** 应用级导航历史(use-nav-history 单点,2026-10-27 技术债轮 D53 批D 外提):记录/回放/控制面/
   *  Alt+←/→ 键面一条链一个文件(navLock 回放抑制/零过期闭包语义随码);落点动词注入
   *  (welcome=壳层清场,chat=openSession 直达——会话常驻 daemon 零重播链) */
  const { navControls, recordNav } = useNavHistory({ goWelcome: leaveToWelcome, openSession, settingsOpen: settingsOpen || schedulesMain });

  /** 快捷键集中分发器(2026-11-25 注册表轮):window keydown 捕获态按 shortcuts 注册表匹配 →
   *  动作 bus(use-nav-history/TabStrip/ProjectMenu 各自订阅;键位用户改键即时生效)。
   *  设置/定时任务覆盖层全屏期间键面整体挂起(与旧 nav 键同口径),仅「快捷键帮助」白名单豁免——
   *  设置页内 Ctrl+/ 仍可唤起本页 */
  useEffect(() => installShortcutDispatcher(), []);
  const overlaysSuspended = settingsOpen || schedulesMain;
  useEffect(() => {
    setShortcutsSuspended(overlaysSuspended);
  }, [overlaysSuspended]);

  /** 2026-11-16 流畅轮恒稳回调簇(全部 useStableCallback——读面经当帧闭包,身份恒定):
   *  memo 化三子树的下发面。原内联箭头逐渲染换新,击穿 memo=App 壳任一 setState 全树重渲 */
  const chatSeededStable = useStableCallback((snap: SnapshotResponse): void => {
    seedFromSnapshot(snap);
    // todo 批次权威投影播种(daemon journal 全量派生;快照未带=旧 daemon,清空走纯派生面)
    setSeededTodoBatches(snap.todoBatches ?? []);
    setBootReady(true); // 开机就绪轮:恢复会话首个快照播种落地=内容整装,放行开机画面(幂等)
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

  /** 缓存清理(2026-11-21):daemon safe 档+壳浏览器 HTTP 缓存并行(cache-clear 共享单点,
   *  StoragePane 存储页同源);toast 回显释放量——搜索框 Actions 与托盘 clear-cache 同走此稳定
   *  回调,不另造旁路语义 */
  const clearCacheNow = useStableCallback((): void => {
    const conn = connRef.current;
    if (conn === null) return;
    clearCacheAll(conn)
      .then((r) => showOpMessage(cacheClearResultText(r)))
      .catch(showOpError);
  });

  /** 托盘菜单动作(壳 tray:action,2026-11-07 用户裁定三组菜单):主进程已唤窗,此处只导航——
   *  最近会话走 attach 两步(同侧栏:newSession 装壳 → attach 播种 → openSession)/新对话/设置/
   *  设置·快捷键面/清理缓存(2026-11-21)。监听挂一次,经 ref 取最新闭包 */
  const trayActionRef = useRef<(a: SxTrayAction) => void>(() => undefined);
  trayActionRef.current = (a) => {
    closeMenuDrawer();
    if (a.kind === 'clear-cache') {
      clearCacheNow();
      return;
    }
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

  /** fork/回退换座簇(forkLatestRef/rewindLatestRef 跳板+零依赖恒稳回调)收口 use-app-rewind(D62 批H 二段一段) */
  const { onForkStable, onRewindStable } = useAppRewind({ connInstance, openSessionId, openRoot, setTabStates, openSession, showOpError, setWelcomeGoal, setRecentVersion });

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

  /** G14.2xx 限宽动态化容器 ref(--chat-max RO 双盯;sidebarRef 另供拖宽直写——声明须先于
   *  useShellLayout,后者拖拽回调闭包引用) */
  const mainRef = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  /** 活动标签滚动容器(自绘 vbar 数据源):仅活动 tabbody 绑定——keep-alive 隐藏面零监听零几何 */
  const tabBodyRef = useRef<HTMLDivElement | null>(null);

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
  /** 菜单包装回调簇收口 use-app-menu(D62 专项 二段五段 自 App.tsx 逐字平迁,行为零变化):菜单头导航/
   *  侧栏入口包装/定时任务层开合/在座直达/新建与合成入口/文件树点开。原「延迟闭包判例」留宿主;
   *  环解(use-app-overlays 早位)后诸输入全数就位,收口成钩——调用置于 useAppLinks 之后
   *  (openProjectDirectory/openFileFromTree/setMenuDir 供参),消费面(searchActions/panes)全在其后 */
  const {
    toggleMenuStable, menuNav, openSessionFromMenu, openSunxBoardFromMenu, closeDirViewStable,
    openSettingsFromMenu, openSettingsPaneStable, openSchedulesFromMenu, openScheduleFromSearchStable,
    closeSchedulesStable, createScheduleInChatStable, openLiveSeatStable, newChatFromMenu,
    composeInFromMenu, collapseMenuStable, openProjectDirectoryStable, openFileFromTreeStable,
  } = useAppMenu({ page, isWelcome, openSessionId, tabState, sidebarFloating, menuClosed, setMenuClosed, closeMenuDrawer, navControls, recordNav, openSession, openTabInSession, presetCompose, setSchedulesMain, setScheduleFocus, settingsOpen, openSettings, setSettingsPane, setTabStates, liveSeatRef, setMenuDir, openProjectDirectory, openFileFromTree, setPage });
  /** 标签体服务面+页签元数据回写+板刷新+side 快照并入+派生值面收口 use-app-services(D62 批H) */
  const { onActivateTab, onTabMeta, services, bgRunningCount, projectNameOfOpenRoot } = useAppServices({ connRef, sessionRef, chatSinkRef, sideParentRef, sideListing, projection, setProjection, setTabStates, agentActivitiesBySession, openSessionId, openRoot, setBgTasks, bgTasks, todoBatches, seededTodoBatches, setTodoBatches, taskFocus, openTaskFocus, todoLocateSig, openLeaderBubble, refreshFromSnapshot });
  const activeTab = tabState.tabs.find((t) => t.uid === tabState.activeUid) ?? null;

  /** 右栏开合(从 WindowControls 内联抽单点):搜索「操作」分类与窗控钮共用同一语义 */
  const toggleRightSidebarStable = useStableCallback((): void => {
    const opening = tabState.collapsed;
    setTabStates((s) => setCollapsed(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, !opening));
    // 两侧抽屉互斥(2026-10-24 用户裁定):浮窗态开右抽屉即收菜单抽屉
    if (opening && sidebarFloating) setMenuClosed(true);
  });

  /** 全局搜索「操作」分类(2026-11-21):菜单/页面动作从搜索框直达——全部走既有回调,
   *  不另造旁路;键位提示只登记界面真实存在的键(无键位不显示) */
  const searchActions = useMemo<readonly SearchAction[]>(
    () => [
      { id: 'new-chat', en: 'New chat', zh: '新对话', run: newChatFromMenu },
      { id: 'schedules', en: 'Scheduled tasks', zh: '定时任务', run: openSchedulesFromMenu },
      { id: 'settings', en: 'Settings', zh: '设置', run: openSettingsFromMenu },
      { id: 'shortcuts', en: 'Keyboard shortcuts', zh: '快捷键说明', run: () => openSettingsPaneStable('shortcuts') },
      { id: 'settings-skills', en: 'Open skills settings', zh: '打开技能设置', run: () => openSettingsPaneStable('skills') },
      { id: 'settings-providers', en: 'Open models & providers', zh: '打开模型与提供方', run: () => openSettingsPaneStable('providers') },
      { id: 'toggle-sidebar', en: 'Toggle side panel', zh: '切换侧栏', run: toggleRightSidebarStable },
      { id: 'clear-cache', en: 'Clear cache', zh: '清理缓存', run: clearCacheNow },
      {
        id: 'toggle-theme',
        en: 'Toggle light / dark theme',
        zh: '切换亮色 / 暗色主题',
        run: () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light'),
      },
      { id: 'tab-terminal', en: 'Add terminal tab', zh: '添加终端标签', run: () => openTabType('terminal') },
      { id: 'tab-web', en: 'Add browser tab', zh: '添加浏览器标签', run: () => openTabType('web') },
      { id: 'tab-memory', en: 'Open memory', zh: '打开记忆', run: () => openMemoryTab() },
      { id: 'tab-learned', en: 'Open learned skills', zh: '打开学习技能', run: () => openLearnedTab() },
      { id: 'tab-artifacts', en: 'Open artifacts', zh: '打开产物', run: openArtifactsTab },
      { id: 'tab-board', en: 'Open task board', zh: '打开任务板', run: openBoardTab },
      { id: 'tab-sunxboard', en: 'Sunx board', zh: 'Sunx 看板', run: openSunxBoardFromMenu },
    ],
    [newChatFromMenu, openSchedulesFromMenu, openSettingsFromMenu, openSettingsPaneStable, toggleRightSidebarStable, clearCacheNow, openTabType, openMemoryTab, openLearnedTab, openArtifactsTab, openBoardTab, openSunxBoardFromMenu],
  );

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
  const shellPanes: AppShellPanesProps = {
    openDirectoryPath,
    sidebarFloating,
    tabState,
    menuFloating,
    menuClosed,
    shellRef,
    menuRenderW,
    sidebarOccupied,
    settingsOpen,
    page,
    connInstance,
    settingsRoot,
    closeSettings,
    settingsPane,
    menuAnim,
    connState,
    openSessionId,
    openRoot,
    recentVersion,
    pins,
    persistPins,
    runningIds,
    menuNav,
    openSessionFromMenu,
    openLiveSeatStable,
    openProjectDirectoryStable,
    openSunxBoardFromMenu,
    menuDir,
    closeDirViewStable,
    openFileFromTreeStable,
    openSettingsFromMenu,
    openSettingsPaneStable,
    searchActions,
    openSchedulesFromMenu,
    openScheduleFromSearchStable,
    newChatFromMenu,
    composeInFromMenu,
    collapseMenuStable,
    startMenuResize,
    mainRef,
    schedulesMain,
    cachedSeats,
    navControls,
    toggleMenuStable,
    openKind,
    openJournalId,
    ptyIdFor,
    handlePtyAllocated,
    closeDockTab,
    chatMem,
    backHome,
    chatSinkRef,
    chatSeededStable,
    openFileTab,
    openDiffTab,
    openTurndiffTab,
    openAgentTab,
    openWebTab,
    runInTerminalStable,
    openTaskFocus,
    openTabType,
    openTabLit,
    openArtifactsTab,
    agentTeamsOn,
    bgRunningCount,
    projection,
    setTodoBatches,
    leaderFocus,
    startSideChat,
    todoLocateStable,
    welcomeGoal,
    setWelcomeGoal,
    setSessionTodos,
    bumpRecent,
    onForkStable,
    openParentSessionStable,
    showOpError,
    onRewindStable,
    setMenuClosed,
    composePreset,
    setWelcomePicked,
    openSession,
    scheduleFocus,
    createScheduleInChatStable,
    openJournalSessionStable,
    closeSchedulesStable,
    sidebarAnim,
    sidebarRef,
    sidebarRenderW,
    projectNameOfOpenRoot,
    tabSelectStable,
    tabReorderStable,
    tabCloseStable,
    tabOpenTypeStable,
    tabCycleStable,
    tabReopenClosedStable,
    hiddenMenuIds,
    tabCloseActiveStable,
    tabBodyRef,
    welcomePicked,
    startResize,
    isWelcome,
    services,
    openTabInSession,
    closeTabInSession,
    openMemoryTab,
    openLearnedTab,
    upgradeSideChat,
    sideGoals,
    setSideGoals,
    sideSinkFor,
    sideReleased,
    openSunxInstance,
    memoryFocus,
    learnedFocus,
    bgFocus,
    panelRefreshNonce,
    catalogTick,
    dev,
    opError,
    webPoolItems,
    curSeatRef,
    onTabMeta,
    onActivateTab,
    setTabStates,
    toggleRightSidebarStable,
  };
  return <AppShellPanes {...shellPanes} />;
}