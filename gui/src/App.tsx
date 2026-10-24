import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseLanguage, setLanguage, t } from './i18n';
import { GitCompare, MessageCircle, ListTodo, FolderTree, Copy, Minus, PanelRight, Square, X } from 'lucide-react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, MutableRefObject } from 'react';
import type { Connection, ConnectionState, SnapshotResponse } from './connection';
import type { TodoItem } from '../../src/types';
import { applyBoardEvent, applyDelegation, boardEventFrom, type SessionProjection } from './projection';
import { EMPTY_PROJECTION, useConnectionWiring } from './use-connection-wiring';
import { Chat } from './pages/Chat';
import type { ChatSink } from './pages/Chat';
import { ProjectMenu } from './sidebar/ProjectMenu';
import { SettingsShell } from './settings/SettingsShell';
import { TabStrip } from './tabs/TabStrip';
import { tabEntry, registryProbe } from './tabs/registry';
import type { TabServices } from './tabs/registry';
import { ensureSession, openTab, closeTab, setActive, cycleTab, reorderTab, setCollapsed, setWidth, patchTabMeta, emptyTabSession, reopenClosed, parseTabSession, MIN_TAB_WIDTH } from './tabs/tab-state';
import type { TabStates, TabTypeId, TabParams } from './tabs/tab-state';
import { applyAgentEvent } from './tabs/agent-activity';
import type { SessionEvent } from '../../src/types';
import { WelcomeComposer } from './welcome/WelcomeComposer';
import type { WelcomeGoal } from './welcome/WelcomeComposer';
import { chatMaxFor, MAIN_MIN_WIDTH } from './thread-width';
import { zoomScale } from './ui-zoom';
import { useMenuResize } from './use-menu-resize';
import { useAgentBuckets, useChatMemory, useShadowHydrationRefs, bindShadowHydration } from './use-agent-projections';

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
 * 双保险,重开经快照重建权威态)。gate 审批 onReview → conn.boardReview(sessionId, taskId,
 * approved)。G6 板投影 seq 门(G5 交接 b 根修):Chat 播种窗内到达的 board/delegation 帧若直
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

export function App(): JSX.Element {
  // G10:token 填写逻辑退役——本地 serve 免鉴权档(恒绑回环),连接不再携带凭证
  return <AppShell />;
}


/** 应用壳:单连接装配 + 三栏路由(左 ProjectMenu|中 Chat 恒挂|右标签栏);welcome = 无会话空态 */
function AppShell(): JSX.Element {
  /** 欢迎页 goal 接力(G10):welcome 提交建会话后,Chat 播种完成即提交该目标 */
  const [welcomeGoal, setWelcomeGoal] = useState<WelcomeGoal | null>(null);
  const [page, setPage] = useState<'welcome' | 'chat'>('welcome');
  /** 欢迎页预选工作区(G10-C16):New chat=空(自选);项目行「+」=该项目(快捷预选) */
  const [composePresetRoot, setComposePresetRoot] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string>('');
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
  /** 已水合会话集:拉档完成前禁写透(空态初值不得抢在回档前覆盘);同时防重复拉档 */
  const hydratedRef = useRef<Set<string>>(new Set());
  /** 写透防抖句柄(每会话一把):变更串内只落最后一笔 */
  const saveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [projection, setProjection] = useState<SessionProjection>(EMPTY_PROJECTION);
  /** Chat onTodos 适配(todo_write 批整替进投影;useCallback 恒稳,消费面 JSX 不变) */
  const setSessionTodos = useCallback((todos: TodoItem[]): void => {
    setProjection((p) => ({ ...p, sessionTodos: todos }));
  }, []);
  /** 会话级操作(fork/rewind)失败提示:sx-toast 底部浮出 3s 自隐(设置页同形态)——旁路失败此前零反馈,
   *  用户点「分叉/回到此轮」无响应会误以为成功 */
  const [opError, setOpError] = useState('');
  const opErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showOpError = (err: unknown): void => {
    setOpError(err instanceof Error ? err.message : String(err));
    if (opErrorTimer.current !== null) clearTimeout(opErrorTimer.current);
    opErrorTimer.current = setTimeout(() => setOpError(''), 3_000);
  };
  /** G8d/G14.2xx 子智能体活动聚合按会话分桶+LRU(use-agent-projections 单点;onEvent 归约与
   *  services.agentActivities 消费) */
  const { agentActivitiesBySession, bumpActs } = useAgentBuckets();
  /** G14.2xx b 转录内存缓存(use-agent-projections 单点):Chat 卸载写回/重挂缓存直渲 */
  const { chatMemGet, chatMemPut } = useChatMemory();
  /** G14.174 待办批次/关联轮次输入(Chat 从转录重建上抛)——待办/任务板页签数据面 */
  const [todoBatches, setTodoBatches] = useState<import('./pages/Chat').TodoBatch[]>([]);
  const [turnGoal, setTurnGoal] = useState('');
  /** G14.176 create_task 行点开的定位信号(任务板滚动高亮对应卡) */
  const [taskFocus, setTaskFocus] = useState<{ ref: string; nonce: number } | null>(null);
  const connRef = useRef<Connection | null>(null);
  /** 事件分发判据:连接回调闭包在装配时固定,会话切换经 ref 免闭包陈旧 */
  const sessionRef = useRef<string>('');
  sessionRef.current = openSessionId;
  /** Chat 事件转投面:Chat 装配期注册(卸载注销)——onEvent/onReset 经此投递 */
  const chatSinkRef = useRef<ChatSink | null>(null);
  /** G14.29 辅助会话 sink 表(sideId → sink ref):连接帧按键路由到旁路 Chat(板/委派/子智能体不聚) */
  const sideSinksRef = useRef<Map<string, MutableRefObject<ChatSink | null>>>(new Map());
  /** G6 板投影 seq 门:播种窗(快照在途)内 board/delegation 帧缓冲(与 Chat pendingRef 同构
   *  {seq, e}[])——onSeeded 整替快照板后过滤重放;窗由 Chat reseed 生命周期驱动 */
  const boardPendingRef = useRef<Array<{ e: SessionEvent; seq: number }>>([]);
  /** 板播种窗开关:true = 快照在途(帧入缓冲不直投);onSeeded 落定置 false */
  const boardSeedingRef = useRef(true);
  /** 拖宽在途清理句柄:mouseup 解绑外,卸载兜底解绑(会话切走/组件卸毁不泄漏 window 监听) */
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  /** G8b pty 记账:terminal 标签 uid → ptyId(TerminalTab onPtyAllocated 落账;关标签 →
   *  killPty 寻址。切标签/会话不清——pty 生命周期属标签不属渲染,backHome 亦不 kill) */
  const ptyIdsRef = useRef(new Map<string, string>());
  /** G8c-T8 设置态:settingsOpen=true 时三栏内容整体切换(SettingsShell 占左+主栏,右标签栏
   *  不渲染,Chat 卸载——返回重播种,与 backHome 同语义可接受);settingsRoot=设置面隐式项目
   *  上下文(开设置时快照 openRoot,无则 ''=仅全局;无顶部切换面——项目区分下沉到配置项徽标,
   *  项目级行以此为写回锚) */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRoot, setSettingsRoot] = useState('');
  /** 三栏壳根(拖宽期挂 .sx-dragging:iframe 指针事件让位——web 标签内容会吞 window mousemove,
   *  光标进入 iframe 即拖拽冻结) */
  const shellRef = useRef<HTMLDivElement | null>(null);

  /** 播种窗重开(清缓冲):openSession/onReset/onResetSession 三处——均伴随 Chat reseed,
   *  窗内残留帧属旧基线/旧板,弃 */
  const reopenBoardSeedWindow = (): void => {
    boardPendingRef.current = [];
    boardSeedingRef.current = true;
  };
  /** G14.2xx b 影子水合四 ref(use-agent-projections 工厂;refs 先声明解「水合需连接实例、
   *  装配需截流 refs」的环——onEvent 截流路由/onReset 重建/会话打开触发消费原样) */
  const { shadowHydrateRef, shadowHydratedRef, shadowHydratingRef, shadowBufRef } = useShadowHydrationRefs();

  /** 单连接装配(use-connection-wiring 单点):onEvent 路由/onReset 重建/挂起转投/生命周期迁
   *  钩子,依赖注入面见 ConnectionWiringDeps——装配一次([]),闭包取首渲染值,会话切换经
   *  sessionRef 与各 ref 免陈旧(原口径) */
  const connInstance = useConnectionWiring({
    sessionRef, chatSinkRef, sideSinksRef, boardPendingRef, boardSeedingRef,
    shadowHydrateRef, shadowHydratedRef, shadowHydratingRef, shadowBufRef, connRef,
    reopenBoardSeedWindow, bumpActs, setRecentVersion, setRunningIds, setProjection,
    setTodoBatches, setTurnGoal, setConnState,
  });
  /** 影子水合单点绑定:每渲染重赋 hydrate ref(闭包恒取最新连接实例) */
  bindShadowHydration({ shadowHydrateRef, shadowHydratingRef, shadowBufRef, shadowHydratedRef }, bumpActs, connInstance);


  /** G14.104 语言切换重渲染触发(t 为模块级非响应式) */
  const [, setLangTick] = useState(0); // G14.104 语言切换重渲染(t 非响应式,tick 驱动)
  /** GUI chrome 双语(G10-C3c):语言源 = daemon settings language 键,连接装配即同步 */
  useEffect(() => {
    if (connInstance === null) return;
    connInstance.settings().then(
      (view) => {
        const raw = view.keys.find((k) => k.key === 'language')?.value ?? undefined;
        if (raw !== undefined) setLanguage(parseLanguage(raw)); // 未设置不覆盖(缺省 zh 由 i18n 模块承载;测试钉 en 由 setup 承载)
        setLangTick((v) => v + 1); // G14.104 语言是模块级非响应式——补一次重渲染,静止页面即时翻语言
      },
      () => {},
    );
  }, [connInstance]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  /** 左栏选中会话(attach/新建完成):切路由(Chat 装配期自播种基线)+ ensureSession 建席
   *  (缺省「任务」页)+ 板投影/team 清零(会话切换串态防线——快照落定后经 onSeeded 重建
   *  权威态)+ 播种窗重开;tabStates 已有该会话则原样(重开同会话标签还原) */
  /** G14.29 辅助对话:fork 主会话整档(side 标记,列表滤除)→ 右栏 sidechat 标签绑定旁路会话。
   *  帧路由经 sideSinksRef(onEvent 同键转投);卡点与 /btw /side 输入拦截同汇本口 */
  const startSideChat = (insert?: string): void => {
    const conn = connRef.current;
    if (conn === null || openSessionId === '') return;
    void (async () => {
      try {
        const anchors = await conn.sessionAnchors(openSessionId);
        const last = anchors.length > 0 ? anchors[anchors.length - 1]!.turn : 1;
        const r = await conn.forkSession(openSessionId, last, true);
        sideSinksRef.current.set(r.sessionId, { current: null });
        openTabInSession('sidechat', { sideId: r.sessionId, insert });
      } catch {
        /* fork 失败静默(旁路非关键路径) */
      }
    })();
  };

  const openSession = (sessionId: string, root: string, journalId?: string): void => {
    sessionRef.current = sessionId;
    setOpenSessionId(sessionId);
    setOpenJournalId(journalId !== undefined && journalId !== '' ? journalId : sessionId);
    setOpenRoot(root);
    setTabStates((s) => ensureSession(s, sessionId, PROBE));
    reopenBoardSeedWindow();
    setProjection(EMPTY_PROJECTION()); // D34 串态收口:sessionTodos 漏清三处之二/三随收口补齐(纪律落实)
        setTodoBatches([]);
        setTurnGoal('');
    // G14.2xx b 子智能体聚合不清零(按会话分桶,切回直接内存命中——零拉取零重建;刷新/重连才走影子水合)
    // 影子水合前置触发:sessionRef 已同步更新、hydrating 标记在此即刻落位——effect 渲染周期前的
    // 实时帧也会被截流缓冲,水合落定按 seq>cut 合并零丢帧(del 标记=每次进入重水合取最新)
    shadowHydratedRef.current.delete(sessionId);
    shadowHydrateRef.current?.(sessionId);
    setPage('chat');
    // G14.2xx 恢复现场指针:打开即记应用级档(lastRoot+journal;新会话无 journal 记空——
    // 重启后只回落工作区,不凭空造会话);刷新/重开浏览器据此重放打开链
    void connRef.current
      ?.saveAppGuiState({ v: 1, lastRoot: root, ...(journalId !== undefined && journalId !== '' ? { lastJournalId: journalId } : {}) })
      .catch(() => undefined);
  };

  /** G14.2xx 恢复现场(浏览器刷新后重放打开链):应用级指针档(lastRoot+lastJournalId)——
   *  启动一次 newSession(root) 装配壳 → attach(journal) 播种 → openSession 三连;指针不可用
   *  (档删/目录迁移/首启)静默落欢迎页。restoredRef 单次闸(StrictMode 双跑防重放) */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || connInstance === null || connState !== 'open') return;
    restoredRef.current = true;
    void Promise.resolve()
      .then(() => connInstance.appGuiState())
      .then(({ state }) => {
        const o = (state ?? {}) as { lastRoot?: unknown; lastJournalId?: unknown };
        if (typeof o.lastRoot !== 'string' || o.lastRoot === '' || typeof o.lastJournalId !== 'string' || o.lastJournalId === '') return;
        const lastRoot: string = o.lastRoot;
        const lastJournalId: string = o.lastJournalId;
        return connInstance
          .newSession(lastRoot)
          .then(({ sessionId }) => connInstance.attach(sessionId, lastJournalId).then((r) => ({ sessionId: r.sessionId, root: lastRoot, journalId: lastJournalId }))) // 收编以返回 id 为准
          .then(({ sessionId, root, journalId }) => openSession(sessionId, root, journalId));
      })
      .catch(() => undefined);
    // eslint 不入依赖(openSession/connRef 恒稳,恢复链仅启动一次)
  }, [connInstance, connState]);

  /** 返回欢迎态:会话关窗(Chat 卸毁本地态;连接保持,再开经左栏重播种)+ 板投影/team 清零
   *  (无会话期无帧消费,残留即陈旧)+ 播种窗缓冲清(再开重开窗);tabStates 保留(每会话
   *  独立留存,spec §1——重开同会话标签还原) */
  const backHome = (): void => {
    sessionRef.current = '';
    setOpenSessionId('');
    setOpenJournalId('');
    setOpenRoot('');
    reopenBoardSeedWindow();
    setProjection(EMPTY_PROJECTION()); // D34 串态收口:sessionTodos 漏清三处之二/三随收口补齐(纪律落实)
        setTodoBatches([]);
        setTurnGoal('');
    // G14.2xx b 子智能体聚合不清(按会话分桶=内存缓存,重开同会话直接命中)
    setPage('welcome');
  };

  /** G8c-T8 开设置态:settingsRoot 快照当前 openRoot(无会话=''=仅全局);connInstance 在场才
   *  可达(设置钮只在 ProjectMenu 底栏,其渲染前提即连接装配完成) */
  const openSettings = useCallback((): void => {
    setSettingsRoot(openRoot);
    setSettingsOpen(true);
  }, [openRoot]);

  /** G8c-T8 回会话态(返回钮/Esc 同路径):page 态未动——开设置前是 chat 则回 chat(Chat 重挂
   *  重播种),welcome 则回欢迎空态;useCallback 零依赖稳定(SettingsShell Esc effect 依赖面) */
  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
  }, []);

  /** G8a 开标签(会话内):Chat write 工具 path 按钮 / 标签条「+」菜单共用——判重聚焦经
   *  tab-state(同目标重开=聚焦既有,单例类型单份)。G14.211 useCallback+sessionRef 零依赖
   *  稳定:内联闭包随 App 渲染换新,击穿 ChatEntryView memo——点一次文件=全列表重渲染闪帧
   *  (正文抖动源之一);sessionRef 恒同步 openSessionId,无过期闭包面 */
  const openTabInSession = useCallback((type: TabTypeId, params: TabParams = {}): void => {
    // G14.38:程序化开标签即展开右栏(默认折叠下 write/diff/目录跳转/卡片开面板均可见)
    setTabStates((st) => setCollapsed(st, sessionRef.current, false));
    setTabStates((s) => openTab(s, sessionRef.current, type, params, PROBE));
  }, []);
  const openFileTab = useCallback((p: string): void => { openTabInSession('file', { path: p }); }, [openTabInSession]);
  const openDiffTab = useCallback((callId: string, path: string): void => { openTabInSession('diff', { callId, path }); }, [openTabInSession]);
  const openAgentTab = useCallback((label: string, agentTitle?: string, task?: string): void => { openTabInSession('agent', { label, agentTitle, task }); }, [openTabInSession]);
  /** G14.174 重定位:agents 页签 id=任务板页签(卡片流;tab 持久化档兼容保留旧 id) */
  const openBoardTab = useCallback((): void => { openTabInSession('agents', {}); }, [openTabInSession]);
  const openTabType = useCallback((type: TabTypeId): void => { openTabInSession(type, {}); }, [openTabInSession]);
  const openMemoryTab = useCallback((): void => { openTabInSession('memory'); }, [openTabInSession]);
  /** 组头目录钮排队旗(2026-10-23 用户裁定):跨会话打开链(newSession→attach→openSession)落位后
   *  补开目录页签——openTabInSession 走 sessionRef,须等目标会话成为打开会话再消费 */
  const pendingDirectoryTabRef = useRef(false);
  useEffect(() => {
    if (openSessionId === '' || !pendingDirectoryTabRef.current) return;
    pendingDirectoryTabRef.current = false;
    openTabInSession('directory', {});
  }, [openSessionId, openTabInSession]);
  /** 组头目录钮(2026-10-23 用户裁定):当前会话属该项目→直接开目录页签;否则打开项目第一个
   *  会话(恢复链同款 newSession→attach→openSession,收编以返回 id 为准)后补开目录页签。
   *  项目无会话钮不渲染(组头侧 sessionCount 门) */
  const openProjectDirectory = useCallback((root: string): void => {
    if (openRoot === root && openSessionId !== '') {
      openTabInSession('directory', {});
      return;
    }
    if (connInstance === null) return;
    void Promise.resolve()
      .then(() => connInstance.sessionsOf(root))
      .then((rows) => {
        const first = rows[0];
        if (first === undefined) return;
        pendingDirectoryTabRef.current = true;
        return connInstance
          .newSession(root)
          .then(({ sessionId }) => connInstance.attach(sessionId, first.id).then((r) => ({ sessionId: r.sessionId })))
          .then(({ sessionId }) => openSession(sessionId, root, first.id));
      })
      .catch(showOpError); // 目录钮开失败可见化（fork/rewind 同口径;无会话项目走上面 first 守卫静默返回）
    // eslint 不入依赖(openSession 恒稳:仅 setter/refs;connInstance 由连接生命周期持有)
  }, [openRoot, openSessionId, openTabInSession, connInstance]);
  /** G14.211 onFork 跳板:实体逻辑挂 ref(每渲染刷新,无过期闭包),回调整体零依赖恒稳 */
  const forkLatestRef = useRef(() => {});
  forkLatestRef.current = (): void => {
    if (connInstance === null) return;
    void connInstance
      .sessionAnchors(openSessionId)
      .then(async (a) => {
        const last = a.length > 0 ? a[a.length - 1]!.turn : 1;
        const r = await connInstance.forkSession(openSessionId, last);
        openSession(r.sessionId, openRoot);
      })
      .catch(showOpError);
  };
  const onForkStable = useCallback((): void => { forkLatestRef.current(); }, []);

  /** G8b pty 分配落定记账(TerminalTab 回传;registry render props 面)——useCallback 零依赖
   *  (仅 ref)保稳定:TerminalTab 装配 effect 以此为依赖,inline 箭头会令其随 App 重渲染重跑 */
  const handlePtyAllocated = useCallback((uid: string, ptyId: string): void => {
    ptyIdsRef.current.set(uid, ptyId);
    // G14.2xx ptyId 落标签参数(gui-state 落盘):刷新后凭档直连旧 pty(replay 重建屏幕),
    // 不再换新壳丢历史
    setTabStates((s) => patchTabMeta(s, openSessionId, uid, { ptyId }));
  }, [openSessionId]);

  /** G8b pty 记账读取面(TerminalTab 重挂重连判据):命中 = 该标签 pty 存活未 kill——重挂
   *  跳过 openPty 直连同 ptyId(replay 恢复屏幕);同上 useCallback 稳定注入 */
  const ptyIdFor = useCallback((uid: string): string | undefined => ptyIdsRef.current.get(uid), []);

  /** G8b 关标签链(TabStrip onClose/onCloseActive 共用):被关标签为 terminal 且 pty 已记账 →
   *  fire-and-forget killPty(拒约吞——关标签不等 HTTP;已关会话侧幂等)再关标签态 */
  const closeTabInSession = (uid: string): void => {
    const t = tabState.tabs.find((x) => x.uid === uid);
    if (t?.type === 'terminal') {
      const ptyId = ptyIdsRef.current.get(uid);
      if (ptyId !== undefined) {
        ptyIdsRef.current.delete(uid);
        const conn = connRef.current;
        // killPty 尽力而为:标签已关,失败=daemon 侧 pty 随会话 teardown 兜底回收,无用户可见后果
        if (conn !== null) void conn.killPty(openSessionId, ptyId).catch(() => {});
      }
    }
    setTabStates((s) => closeTab(s, openSessionId, uid));
  };

  /** G5 gate 审批装配:任务标签 onReview → boardReview(sessionId, taskId, approved)——失败倒
   *  Chat error 条不静默(经 sink 合成 error 帧,seq 取上界保证种子缓冲过滤恒放行;成功面无
   *  HTTP 回执帧,daemon 侧 review 触发的 gate-resolved/task-status 事件帧自然回投板投影)。
   *  useCallback 零依赖(仅 refs)——services useMemo 稳定 */
  const reviewTask = useCallback((taskId: string, approved: boolean): void => {
    const conn = connRef.current;
    if (conn === null) return;
    void conn.boardReview(sessionRef.current, taskId, approved).catch((err: unknown) => {
      chatSinkRef.current?.on(
        { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() },
        Number.MAX_SAFE_INTEGER,
      );
    });
  }, []);

  /** G5 Chat 播种回调:快照权威态回填 App 投影——team(事件流无此面)+board/delegations
   *  (快照本就携带:会话打开/reseed 即板随快照)。G6 seq 门(G5 交接 b 根修):整替前先关窗+
   *  过滤缓冲(≤ snap.lastSeq 丢——快照已含,再投即双应用;> 逐帧依序 apply 重放到快照板上)
   *  ——播种窗内到达的增量帧不再被整替吞掉(丢一帧增量竞态根除)。lastSeq 运行时必在
   *  (sessionSnapshot 应答字段;ChatSink 类型面未声明,收窄读取防 undefined 旧档) */
  const seedFromSnapshot = (snap: SnapshotResponse): void => {
    const lastSeq = (snap as SnapshotResponse & { lastSeq?: number }).lastSeq ?? 0;
    const replay = boardPendingRef.current.filter((f) => f.seq > lastSeq);
    boardPendingRef.current = [];
    boardSeedingRef.current = false;
    // G14.2xx 运行态对表(零额外请求,复用 reseed 快照的 status 权威):attach 收编运行中/
    // 重启重开均归位;非运行清同会话残留(修「已完成仍在转圈」的跨会话布尔卡滞)
    setRunningIds((s) => {
      const without = new Set([...s].filter((x) => x !== sessionRef.current));
      return snap.status === 'running' && sessionRef.current !== '' ? new Set([...without, sessionRef.current]) : without;
    });
    let nextBoard = snap.board;
    let nextDelegations = snap.delegations;
    for (const f of replay) {
      if (f.e.type.startsWith('task-') || f.e.type.startsWith('gate-')) {
        nextBoard = applyBoardEvent(nextBoard, boardEventFrom(f.e));
      } else if (f.e.type.startsWith('delegation-')) {
        nextDelegations = applyDelegation(nextDelegations, f.e);
        // G8e-T2:delegation 帧补投子智能体聚合(与 board/delegation 同窗)——窗外路径本就投
        // applyAgentEvent(权威终语:ended failed→error/done→done;label 命中既有卡才动),
        // 窗内缓冲帧此前只重放板/委派不投聚合,delegation 终语在播种窗内被吞(卡滞 running)
        if (sessionRef.current !== '') bumpActs(sessionRef.current, (a) => applyAgentEvent(a, f.e));
      }
    }
    setProjection((p) => ({ ...p, board: nextBoard, delegations: nextDelegations, team: snap.team ?? [] }));
  };

  /** 标签体服务面(任务板/agent 转录页签消费):板投影 + 浅拷贝数组(既有 Board 收可变数组,T3 桥接)+
   *  G8d 子智能体活动聚合(agent 只读转录页只读) */
  /** G14.2xx web 标签元数据回写:页内导航 url/页名 → patchTabMeta(标签条标题/判重键同源演进,
   *  浏览器原生标签形);useCallback 零依赖稳定——services useMemo 不因回写重建 */
  const onTabMeta = useCallback((sessionId: string, uid: string, patch: { url?: string; pageTitle?: string }): void => {
    setTabStates((s) => patchTabMeta(s, sessionId, uid, patch));
  }, []);
  /** G14.2xx b create_task 行任务名定位(子智能体转录页与 Chat onOpenTask 同一口径):开任务板页签
   *  +focus 信号(nonce 变更即滚动高亮);useCallback 零依赖稳定 */
  const openTaskFocus = useCallback((ref: string): void => {
    openBoardTab();
    setTaskFocus({ ref, nonce: Date.now() });
  }, [openBoardTab]);
  const services = useMemo<TabServices>(
    () => ({ board: projection.board, delegations: [...projection.delegations], team: [...projection.team], onReview: reviewTask, onTabMeta, agentActivities: agentActivitiesBySession[openSessionId] ?? {}, todos: [...projection.sessionTodos], todoBatches, turnGoal, taskFocus, onOpenTask: openTaskFocus }),
    [projection, reviewTask, onTabMeta, agentActivitiesBySession, openSessionId, todoBatches, turnGoal, taskFocus, openTaskFocus],
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

  // G14.2xx 附接水合:切会话即拉盘档回填(仅在本地无此会话态或空态时落——不覆写在途编辑);
  // 拉到(含空档)即记水合,写透闸门随之放开
  useEffect(() => {
    if (connInstance === null || connState !== 'open' || openSessionId === '') return;
    if (hydratedRef.current.has(openSessionId)) return;
    let dead = false;
    const done = (): void => {
      // 水合标记在 GET 落定后才放行写透——在途期间空态初值不得抢先覆盘
      hydratedRef.current.add(openSessionId);
    };
    // 异步面调用(daemon 未附会话等 404 → 拒绝走容错,不炸渲染)
    void Promise.resolve().then(() => connInstance.guiState(openSessionId)).then(
      ({ state }) => {
        if (dead) return;
        done();
        const parsed = parseTabSession(state);
        if (parsed === null) return;
        setTabStates((s) => {
          const cur = s[openSessionId];
          // 本地已有在途标签(非空)以内存为准;空态/缺席才落盘档
          if (cur !== undefined && (cur.tabs.length > 0 || cur.recentClosed.length > 0)) return s;
          return { ...s, [openSessionId]: parsed };
        });
      },
      () => {
        if (dead) return;
        done(); // 拉档失败:内存态继续用,写透闸门放开(下次变更仍会写透)
      },
    );
    return () => {
      dead = true;
    };
  }, [connInstance, connState, openSessionId]);

  // G14.2xx 变更写透(500ms 防抖,每会话一把):标签任何变化最终落 <slug>/gui/sessions/<id>.json;
  // 水合前不写(防空态初值覆盘)
  useEffect(() => {
    if (openSessionId === '' || connState !== 'open' || connInstance === null) return;
    if (!hydratedRef.current.has(openSessionId)) return;
    const timers = saveTimersRef.current;
    const prev = timers.get(openSessionId);
    if (prev !== undefined) clearTimeout(prev);
    timers.set(
      openSessionId,
      setTimeout(() => {
        timers.delete(openSessionId);
        void connInstance.saveGuiState(openSessionId, { v: 1, ...tabStates[openSessionId] });
      }, 500),
    );
  }, [tabStates, openSessionId, connState, connInstance]);

  const tabState = tabStates[openSessionId] ?? emptyTabSession();
  /** G12 左栏宽度可调(use-menu-resize 单点):菜单宽与拖宽手柄逻辑见钩子 */
  const { menuWidth, startMenuResize } = useMenuResize(shellRef, () => sidebarOccupied);
  /** 视口宽跟踪(2026-10-23 越视口修复的数据源):持久宽只在拖拽中钳制,窗口缩窄/换页后
   *  渲染态从不重钳——残留宽令 .sx-menu 被 max-width 挤成缝隙、三栏行整体溢出视口。
   *  resize 即重渲,下方渲染期钳制以实时视口重算。 */
  const [viewportW, setViewportW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setViewportW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  /** 浮窗抽屉切换(2026-10-24 二轮裁定):三栏全部触底才浮——视口(本地/zoom)窄于菜单最小 240
   *  +主栏最小 320+抽屉最小 296=856 时右栏转悬浮抽屉(fixed 右满高盖正文,z 低于窗控簇),
   *  否则恒分栏。压缩顺序(用户裁定):右缘起=侧栏→主栏→菜单→浮窗;左缘反向;展开只吃主栏宽 */
  const sidebarFloating = viewportW / zoomScale() < 240 + MAIN_MIN_WIDTH + MIN_TAB_WIDTH;
  /** 右栏渲染期钳制宽——分栏态预留主栏最小宽(320);浮窗态=纯覆盖层,**不挤占主栏/composer**
   *  (2026-10-24 用户裁定「抽屉是上浮的,为什么占输入框宽度」——dock 不让位,抽屉盖在上面),
   *  上界只留 24px 边距,下限 MIN_TAB_WIDTH=296。视觉/本地换算 /zoomScale() 契约同前 */
  const sidebarRenderW = Math.min(
    tabState.width,
    sidebarFloating
      ? Math.max(MIN_TAB_WIDTH, viewportW / zoomScale() - menuWidth - 24)
      : Math.max(0, viewportW / zoomScale() - menuWidth - MAIN_MIN_WIDTH),
  );
  /** 右栏实际占宽(未渲染=0:欢迎页/折叠/settings/浮窗态——浮窗不占布局宽,菜单/主栏不受钳) */
  const sidebarOccupied = !settingsOpen && page === 'chat' && !tabState.collapsed && !sidebarFloating ? sidebarRenderW : 0;
  const activeTab = tabState.tabs.find((t) => t.uid === tabState.activeUid) ?? null;

  /** 拖宽边条 mousedown:window mousemove 计算宽(右栏在右侧,向左拖=变宽;min 440 在
   *  tab-state.setWidth 单点,拖拽上界=视口−菜单−440——无固定最大宽但不越视口,G14.2xx 用户
   *  裁定),mouseup 解绑 + 移 active 类;每次 move 直接落态(React 批处理兜底);sessionId
   *  起拖时定格(拖拽中会话切换属病态,不追)。G14.2xx 起拖基线取「当前渲染宽」:状态可能
   *  滞留护栏外(先拖宽菜单再拖本边条),不取渲染宽则向窄拖先空走死区 */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (page !== 'chat' || openSessionId === '' || tabState.collapsed) return;
    e.preventDefault(); // 拖宽期间禁原生文本选择拖选(G8e 终审 B;.sx-resizer 另挂 user-select:none)
    const el = e.currentTarget;
    el.classList.add('active');
    const startX = e.clientX;
    // 拖拽上界随态:分栏预留主栏最小宽;浮窗=覆盖层只留 24px 边距(不挤 composer,见 sidebarRenderW);
    // 下限 296 在 setWidth 单点(起拖定格,拖拽中无 resize 事件模式不翻转)
    const floating = sidebarFloating;
    const cap = (): number => window.innerWidth / zoomScale() - menuWidth - (floating ? 24 : MAIN_MIN_WIDTH);
    const startWidth = Math.min(tabState.width, cap());
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

  const sidebarWidth = page === 'chat' && openSessionId !== '' ? (tabState.collapsed ? 32 : sidebarRenderW) : 32;

  /** G14.2xx 限宽动态化:--chat-max 不再钉 880px——ResizeObserver 分盯 .sx-main 与 .sx-sidebar,
   *  各按自身实时内容宽经 chatMaxFor 阶梯落内联值(同一策略覆盖主对话、欢迎页、辅助对话、
   *  子智能体转录页;流列/输入卡随三栏拖拽、右栏折叠、视口缩放即时跟宽)。首次 observe 即回调,
   *  首帧就位零闪;jsdom 桩回调宽 0,chatMaxFor 托底不落负。deps:两容器随设置态/页面/折叠/
   *  切会话换挂,重挂后需重挂观察器 */
  const mainRef = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const els = [mainRef.current, sidebarRef.current].filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        (entry.target as HTMLElement).style.setProperty(
          '--chat-max',
          `${Math.round(chatMaxFor(entry.contentRect.width))}px`,
        );
      }
    });
    els.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [settingsOpen, page, tabState.collapsed, openSessionId]);

  return (
    <div
      className={[
        IS_SHELL ? 'sx-shell sx-desktop' : 'sx-shell',
        // 浮窗抽屉面(2026-10-24 用户裁定):窄视口右栏悬浮不占布局宽,主栏吃满
        // (模式 pill 塌缩已改底栏实测溢出驱动 pills-tight,壳级不再派生 sx-main-narrow)
        sidebarFloating ? 'sx-sidebar-float' : '',
      ].filter(Boolean).join(' ')}
      ref={shellRef}
      style={{
        '--menu-w': `${menuWidth}px`,
        '--sidebar-w': `${sidebarOccupied}px`,
      } as CSSProperties}
    >
      {settingsOpen && connInstance !== null ? (
        /* G8c-T8 设置态:左栏+主栏整体切换(SettingsShell 内含左导航与所选面板),右标签栏不渲染;
           Chat 卸载——返回重挂重播种(backHome 同语义),连接/板投影态不受扰 */
        <SettingsShell conn={connInstance} root={settingsRoot} onBack={closeSettings} />
      ) : (
        <>
          {/* 左栏:项目分组(Home 职能内化;装配中占位) */
          }
          {connInstance !== null ? (
            <ProjectMenu
              conn={connInstance}
              connState={connState}
              activeSessionId={openSessionId}
              activeRoot={openRoot}
              recentVersion={recentVersion}
              runningIds={runningIds}
              onOpenSession={openSession}
              onOpenDirectory={openProjectDirectory}
              onOpenSettings={openSettings}
              onNewChat={() => {
                setComposePresetRoot(null);
                setPage('welcome');
              }}
              onComposeIn={(root) => {
                setComposePresetRoot(root);
                setPage('welcome');
              }}
            />
          ) : (
            <nav className="sx-menu" aria-label="projects">
              <p className="home-loading">{t('Connecting…', '连接装配中…')}</p>
            </nav>
          )}
          {/* G12 左栏拖宽手柄:overlay 在 nav 右缘(负 margin 零布局占位),拖动改 --menu-w */}
          <div
            className="sx-menu-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('Resize sidebar', '调整侧栏宽度')}
            data-tip={t('Drag to resize', '拖动调整宽度')}
            onMouseDown={startMenuResize}
          />
          {/* 中栏:Chat 恒挂(无会话=欢迎空态);归档视图已内驻左栏 ArchiveSection(2026-10-21 裁定) */}
          <main className="sx-main" ref={mainRef}>
            {page === 'chat' && connInstance !== null ? (
              <Chat
                key={openSessionId}
                conn={connInstance}
                sessionId={openSessionId}
                journalId={openJournalId}
                chatMem={{ get: chatMemGet, put: chatMemPut }}
                connState={connState}
                onBack={backHome}
                sinkRef={chatSinkRef}
                onSeeded={seedFromSnapshot}
                onOpenFile={openFileTab}
                onOpenDiff={openDiffTab}
                onOpenAgent={openAgentTab}
                onOpenTask={(ref) => {
                  openBoardTab();
                  setTaskFocus({ ref, nonce: Date.now() });
                }}
                onOpenTab={openTabType}
                board={projection.board}
                onTodoBatches={setTodoBatches}
                onTurnGoal={setTurnGoal}
                pendingGoal={welcomeGoal ?? undefined}
                onPendingGoalDone={() => setWelcomeGoal(null)}
                root={openRoot}
                onTodos={setSessionTodos}
                onRenamed={() => setRecentVersion((v) => v + 1)}
                onSessionsMutated={() => setRecentVersion((v) => v + 1)}
                onSideChat={startSideChat}
                onOpenMemory={openMemoryTab}
                onFork={onForkStable}
                onOpError={showOpError}
                onRewind={(turn) => {
                  void connInstance
                    .rewindSession(openSessionId, turn)
                    .then(() => {
                      // 回退=换 journal 重新播种(Chat 内 reseed 由 key 不变触发不了——手动重挂:切走再切回同会话)
                      const rid = openSessionId;
                      const rr = openRoot;
                      const rj = openJournalId;
                      setPage('welcome');
                      requestAnimationFrame(() => openSession(rid, rr, rj));
                    })
                    .catch(showOpError);
                }}
              />
            ) : connInstance !== null ? (
              <WelcomeComposer
                conn={connInstance}
                presetRoot={composePresetRoot ?? undefined}
                onOpened={(sessionId, root, goal) => {
                  setWelcomeGoal({ root, goal });
                  openSession(sessionId, root);
                }}
              />
            ) : (
              <div className="sx-welcome-brand">Sunshinex</div>
            )}
          </main>
          {/* 右栏:会话标签页(G10:welcome 态整体不渲染;G14.28:折叠态也不渲染——展开钮入 Chat 顶栏) */}
          {page === 'chat' && !tabState.collapsed && (
          <aside className="sx-sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
            <TabStrip
              tabs={tabState.tabs}
              activeUid={tabState.activeUid}
              disabled={page !== 'chat'}
              onSelect={(uid) => setTabStates((s) => setActive(s, openSessionId, uid))}
              onReorder={(from, to) => setTabStates((s) => reorderTab(s, openSessionId, from, to))}
              onClose={closeTabInSession}
              onOpenType={(t) => {
                // G14.2xx 辅助对话特判:sidechat 需先 fork 出 side 会话(拿 sideId)再开页——
                // 直接 openTab 只会落无 sideId 的空壳档;startSideChat 完成装配+开页一条龙
                if (t === 'sidechat') {
                  startSideChat();
                  return;
                }
                openTabInSession(t, tabEntry(t).mintParams?.());
              }}
              onCycle={(d) => setTabStates((s) => cycleTab(s, openSessionId, d))}
              recentClosed={tabState.recentClosed}
              onReopenClosed={(i) => setTabStates((s) => reopenClosed(s, openSessionId, i, PROBE))}
              onCloseActive={() => {
                const uid = tabState.activeUid;
                if (uid !== null) closeTabInSession(uid);
              }}
            />
            {page === 'chat' && !tabState.collapsed && connInstance !== null && activeTab !== null && (
              // key={activeTab.uid}:同型标签(file→file)互切强制重挂——React 同树位同元素类型会复用
              // 一个 Files 实例(initialPath 自动加载 effect no-op,空标签串上一标签内容/路径输入)
              <div className="sx-tabbody" key={activeTab.uid}>

                {tabEntry(activeTab.type).render({
                  conn: connInstance,
                  sessionId: openSessionId,
                  root: openRoot,
                  params: activeTab.params,
                  services,
                  uid: activeTab.uid,
                  // G8b T7:标签体自治跳转面(DirectoryTab 文件行 → file 标签;Chat onOpenFile 同源)
                  openTab: openTabInSession,
                  // G14.2xx 标签自关面(file 页签探测到目录:移交 directory 页签后自关)
                  closeTab: closeTabInSession,
                  startSideChat,
                  ptyIdFor,
                  onPtyAllocated: handlePtyAllocated,
                  // G14.29 辅助对话:按 sideId 注入旁路 sink(App onEvent 同键路由帧)
                  chatSinkRef: activeTab.params.sideId !== undefined ? sideSinksRef.current.get(activeTab.params.sideId) : undefined,
                })}
              </div>
            )}
            {page === 'chat' && !tabState.collapsed && activeTab === null && (
              // G14.27 零标签空态=Codex 推荐项:标题+副题+常用页卡(点击即开,不再默认开任务页);
              // 目录页签入常用卡(与 TabStrip 同款 FolderTree 图标)
              <div className="sx-tab-empty">
                <div className="sx-tab-empty-title">{t('Open tabs', '打开标签页')}</div>
                <div className="sx-tab-empty-sub">{t('Choose tabs to open in the side panel.', '选择要在侧边面板中打开的标签。')}</div>
                <div className="sx-tab-empty-cards">
                  {([
                    ['side', MessageCircle, t('Side chat', '辅助对话'), () => startSideChat()],
                    ['tasks', ListTodo, t('Todos', '待办'), () => openTabInSession('tasks')],
                    ['diff', GitCompare, t('Review', '审查'), () => openTabInSession('diff')],
                    ['directory', FolderTree, t('Directory', '目录'), () => openTabInSession('directory')],
                  ] as const).map(([key, Icon, label, onClick]) => (
                    <button key={key} type="button" className="sx-tab-empty-card" onClick={onClick}>
                      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {page === 'chat' && !tabState.collapsed && <div className="sx-resizer" onMouseDown={startResize} />}
          </aside>
          )}
        </>
      )}
      {opError !== '' && (
        <div className="sx-toast" role="alert">
          {opError}
        </div>
      )}
      {/* 2026-10-23 用户裁定:[|] 唯一渲染=本簇(web 贴窗口最右/桌面 −□× 左),对话页常驻
          不随收展换实现——页签条自有钮两套渲染致切换变尺寸,已退役 */}
      <WindowControls showSideToggle={page === 'chat' && !settingsOpen} onToggleRightSidebar={() => setTabStates((s) => setCollapsed(s, openSessionId, !(s[openSessionId]?.collapsed ?? false)))} />
    </div>
  );
}

/** 桌面壳判定(2026-10-23 用户实测修正):UA 含 Electron 不充分——ZCode 等 Electron 系
 *  浏览器的内嵌页同样命中,致 web 误吃桌面让位(页签条 92px 幽灵簇位,[|] 不贴右缘);
 *  须自家 preload 桥在场才算桌面壳(桥由 contextBridge 注入,先于页面脚本,模块期可判) */
const IS_SHELL =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Electron') &&
  typeof (window as unknown as { sunshinexWindow?: unknown }).sunshinexWindow !== 'undefined';

/** 桌面窗控桥(preload 注入;浏览器态无此全局) */
interface SunshinexWindowBridge {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  onMaximizedChange: (cb: (v: boolean) => void) => () => void;
}
const winBridge = (): SunshinexWindowBridge | undefined =>
  IS_SHELL ? (window as unknown as { sunshinexWindow?: SunshinexWindowBridge }).sunshinexWindow : undefined;

/** 桌面窗控簇:[|] 侧栏开关(唯一渲染——web 贴窗口最右/桌面 −□× 左,同件同尺寸不随收展
 *  变形,页签条自有钮已退役)+ − □ × 自绘按钮(桌面态)——sx-iconbtn 同款圆角 hover,
 *  撤原生 WCO 方块。−□× 走 preload IPC,关闭=驻留 hide 语义 */
function WindowControls({ showSideToggle, onToggleRightSidebar }: { showSideToggle: boolean; onToggleRightSidebar: () => void }): JSX.Element {
  const bridge = winBridge();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => bridge?.onMaximizedChange(setMaximized), [bridge]);
  // [|] 仅对话页显示(欢迎/设置页无右栏);簇其余为窗口三钮(桌面态)
  return (
    <div className="sx-wincontrols">
      {showSideToggle && (
        <button type="button" className="sx-winbtn" aria-label="toggle side panel" data-tip={t('Open side panel', '打开侧边栏')} onClick={onToggleRightSidebar}>
          <PanelRight size={14} strokeWidth={1.75} />
        </button>
      )}
      {bridge !== undefined && (
        <>
          <button type="button" className="sx-winbtn" aria-label="minimize window" onClick={() => bridge.minimize()}>
            <Minus size={14} strokeWidth={1.75} />
          </button>
          <button type="button" className="sx-winbtn" aria-label={maximized ? 'restore window' : 'maximize window'} onClick={() => bridge.toggleMaximize()}>
            {maximized ? <Copy size={12} strokeWidth={1.75} /> : <Square size={12} strokeWidth={1.75} />}
          </button>
          <button type="button" className="sx-winbtn" aria-label="close window" onClick={() => bridge.close()}>
            <X size={14} strokeWidth={1.75} />
          </button>
        </>
      )}
    </div>
  );
}
