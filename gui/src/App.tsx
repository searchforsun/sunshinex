import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n';
import { GitCompare, MessageCircle, ListTodo, FolderTree, Copy, Minus, PanelRight, Square, X } from 'lucide-react';
import type { CSSProperties, MutableRefObject } from 'react';
import type { Connection, ConnectionState, SnapshotResponse } from './connection';
import type { TodoItem } from '../../src/types';
import { applyBoardEvent, applyDelegation, boardEventFrom, type SessionProjection } from './projection';
import { EMPTY_PROJECTION, useConnectionWiring } from './use-connection-wiring';
import { Chat } from './pages/Chat';
import type { ChatSink } from './pages/Chat';
import { ProjectMenu } from './sidebar/ProjectMenu';
import { PanelLeft } from 'lucide-react';
import { SettingsShell } from './settings/SettingsShell';
import { TabStrip } from './tabs/TabStrip';
import { Suspense } from 'react';
import { tabEntry, registryProbe } from './tabs/registry';
import { TabSkeleton } from './tabs/TabSkeleton';
import type { TabServices } from './tabs/registry';
import { ensureSession, openTab, closeTab, setActive, cycleTab, reorderTab, setCollapsed, patchTabMeta, emptyTabSession, reopenClosed } from './tabs/tab-state';
import type { TabStates, TabTypeId, TabParams } from './tabs/tab-state';
import { applyAgentEvent } from './tabs/agent-activity';
import type { SessionEvent } from '../../src/types';
import { WelcomeComposer } from './welcome/WelcomeComposer';
import type { WelcomeGoal } from './welcome/WelcomeComposer';
import { chatMaxFor } from './thread-width';
import { useAppearanceSync } from './use-appearance-sync';
import { useOpError } from './use-op-error';
import { useShellLayout } from './use-shell-layout';
import { useTabPersistence } from './use-tab-persistence';
import { useAgentBuckets, useChatMemory, useShadowHydrationRefs, bindShadowHydration } from './use-agent-projections';
import { NavButtons } from './NavButtons';
import { useNavHistory } from './use-nav-history';

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
  const { agentActivitiesBySession, bumpActs } = useAgentBuckets();
  /** G14.2xx b 转录内存缓存(use-agent-projections 单点):Chat 卸载写回/重挂缓存直渲 */
  const { chatMemGet, chatMemPut } = useChatMemory((key) => runningIds.has(key)); // TTL 豁免:运行中会话不剔(60min,2026-10-26)
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

  /** 外观偏好同步(use-appearance-sync 单点,2026-10-27 技术债轮 D53 批E 外提):语言源随 daemon
   *  settings + 公共持久化偏好上收(/app/gui-state 覆盖本地,zoom/theme/fontPreset)两件一次性同步 */
  useAppearanceSync(connInstance);

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
    const jid = journalId !== undefined && journalId !== '' ? journalId : sessionId;
    setOpenSessionId(sessionId);
    setOpenJournalId(jid);
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
    recordNav({ k: 'chat', sessionId, root, journalId: jid }); // 导航史记录(navLock 回放期自抑制)
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

  /** 返回欢迎态的壳层清场(记录面分离:backHome 记史,导航回放经 applyNav 复用本函数) */
  const leaveToWelcome = (): void => {
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

  /** 返回欢迎态:会话关窗(Chat 卸毁本地态;连接保持,再开经左栏重播种)+ 板投影/team 清零
   *  (无会话期无帧消费,残留即陈旧)+ 播种窗缓冲清(再开重开窗);tabStates 保留(每会话
   *  独立留存,spec §1——重开同会话标签还原) */
  const backHome = (): void => {
    leaveToWelcome();
    recordNav({ k: 'welcome' });
  };

  /** 应用级导航历史(use-nav-history 单点,2026-10-27 技术债轮 D53 批D 外提):记录/回放/控制面/
   *  Alt+←/→ 键面一条链一个文件(navLock 回放抑制/零过期闭包语义随码);落点动词注入
   *  (welcome=壳层清场,chat=openSession 直达——会话常驻 daemon 零重播链) */
  const { navControls, recordNav } = useNavHistory({ goWelcome: leaveToWelcome, openSession, settingsOpen });

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
  const onTabMeta = useCallback((sessionId: string, uid: string, patch: { url?: string; pageTitle?: string; pageIcon?: string }): void => {
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

  /** 标签态持久化(use-tab-persistence 单点,2026-10-27 技术债轮 D53 批C-3 外提):附接水合拉档
   *  + 变更写透防抖,盘↔内存同步效应在钩子内(水合闸/防抖句柄为钩子私域) */
  useTabPersistence({ connInstance, connState, openSessionId, tabStates, setTabStates });

  const tabState = tabStates[openSessionId] ?? emptyTabSession();
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
    startResize,
    sidebarWidth,
  } = useShellLayout({
    shellRef,
    resizeCleanupRef,
    page,
    settingsOpen,
    openSessionId,
    tabCollapsed: tabState.collapsed,
    tabWidth: tabState.width,
    setTabStates,
  });
  const activeTab = tabState.tabs.find((t) => t.uid === tabState.activeUid) ?? null;

  /** 2026-10-26 二期 keep-alive LRU:重标签保留上限 4,超限自动关最久未触的非活动标签 */
  const HEAVY_TAB_TYPES = new Set<string>(['terminal', 'file', 'diff', 'taskboard', 'directory']);
  const heavyTouchRef = useRef<string[]>([]);
  const activeUidNow = activeTab?.uid ?? null;
  const activeTabType = activeTab?.type;
  useEffect(() => {
    if (activeUidNow === null || activeTabType === undefined || !HEAVY_TAB_TYPES.has(activeTabType)) return;
    heavyTouchRef.current = [...heavyTouchRef.current.filter((u) => u !== activeUidNow), activeUidNow];
  }, [activeUidNow, activeTabType]);
  useEffect(() => {
    const heavy = tabState.tabs.filter((t) => HEAVY_TAB_TYPES.has(t.type)).map((t) => t.uid);
    for (const u of heavy) if (!heavyTouchRef.current.includes(u)) heavyTouchRef.current.push(u);
    const order = heavyTouchRef.current.filter((u) => heavy.includes(u));
    const excess = order.slice(0, Math.max(0, order.length - 4)).filter((u) => u !== activeUidNow);
    for (const u of excess) {
      if (tabState.tabs.some((t) => t.uid === u)) closeTabInSession(u);
    }
  }, [tabState.tabs, activeUidNow, closeTabInSession]);



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
        /* 2026-10-24 拖拽重构:欢迎/连接页不渲染 TabStrip/ChatTopbar,整窗零 drag 把手(用户实测
           「欢迎页顶部无法拖窗」根因)。几何隔离 drag 轨:left+44 避让菜单关闭态呼出钮、right:148
           避让窗控簇(簇左缘 118+30 安全边)——drag 矩形与一切按钮互斥,无挖孔,CSS zoom 下拖拽
           位图错位也咬不到按钮;抽屉态左缘移至抽屉浮层右缘之外(CSS sx-menu-float 分支) */
        <div className="sx-dragrail" aria-hidden="true" />
      )}
      {settingsOpen && connInstance !== null ? (
        /* G8c-T8 设置态:左栏+主栏整体切换(SettingsShell 内含左导航与所选面板),右标签栏不渲染;
           Chat 卸载——返回重挂重播种(backHome 同语义),连接/板投影态不受扰 */
        <SettingsShell conn={connInstance} root={settingsRoot} onBack={closeSettings} />
      ) : (
        <>
          {/* 左栏:项目分组(Home 职能内化;装配中占位)。关闭态不渲染(顶栏 logo 呼出);
              浮窗抽屉态选中会话/设置/新会话/目录即自动收(各回调前挂 closeMenuDrawer) */
          }
          {!menuClosed && (connInstance !== null ? (
            <ProjectMenu
              conn={connInstance}
              connState={connState}
              activeSessionId={openSessionId}
              activeRoot={openRoot}
              recentVersion={recentVersion}
              runningIds={runningIds}
              nav={(() => {
                // 菜单头钮对(全局史):浮窗抽屉态导航即收抽屉(会话/设置同类「选中即收」口径)
                const back = (): void => { closeMenuDrawer(); navControls.back(); };
                const forward = (): void => { closeMenuDrawer(); navControls.forward(); };
                return { canBack: navControls.canBack, canForward: navControls.canForward, back, forward };
              })()}
              onOpenSession={(sessionId, root, journalId) => { closeMenuDrawer(); openSession(sessionId, root, journalId); }}
              onOpenDirectory={(root) => { closeMenuDrawer(); openProjectDirectory(root); }}
              onOpenSettings={() => { closeMenuDrawer(); openSettings(); }}
              onNewChat={() => {
                closeMenuDrawer();
                setComposePresetRoot(null);
                setPage('welcome');
                recordNav({ k: 'welcome' });
              }}
              onComposeIn={(root) => {
                closeMenuDrawer();
                setComposePresetRoot(root);
                setPage('welcome');
                recordNav({ k: 'welcome' });
              }}
              onCollapse={() => setMenuClosed(true)}
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
          {/* 中栏:Chat 恒挂(无会话=欢迎空态);归档视图已内驻左栏 ArchiveSection(2026-10-21 裁定) */}
          <main className="sx-main" ref={mainRef}>
            {page === 'chat' && connInstance !== null ? (
              <Chat
                key={openSessionId}
                nav={navControls}
                menuClosed={menuClosed}
                onToggleMenu={() => {
                  const opening = menuClosed;
                  setMenuClosed(!menuClosed);
                  // 两侧抽屉互斥(2026-10-24 用户裁定):开菜单抽屉即收右抽屉
                  if (opening && sidebarFloating && !tabState.collapsed) {
                    setTabStates((s) => setCollapsed(s, openSessionId, true));
                  }
                }}
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
                presetRoot={composePresetRoot ?? undefined}
                onOpened={(sessionId, root, goal, images) => {
                  setWelcomeGoal({ root, goal, ...(images !== undefined && images.length > 0 ? { images } : {}) });
                  openSession(sessionId, root);
                }}
              />
              </>
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
            {page === 'chat' && !tabState.collapsed && connInstance !== null && (
              // 2026-10-26 二期 keep-alive:全部 open 标签常挂,非活动 display:none+inert——
              // DOM/状态/滚动位/终端屏完整保留,互切零重建;重标签 LRU-4 超限自动关(下方 effect)
              tabState.tabs.map((t) => {
                const hidden = activeTab === null || t.uid !== activeTab.uid;
                return (
                  <div
                    key={t.uid}
                    className="sx-tabbody"
                    style={hidden ? { display: 'none' } : undefined}
                    {...(hidden ? { inert: '' as unknown as boolean } : {})}
                  >
                    {/* 二期分包:标签体 lazy——Suspense 骨架承接首开 chunk 加载 */}
                    <Suspense fallback={<TabSkeleton />}>
                    {tabEntry(t.type).render({
                      conn: connInstance,
                      sessionId: openSessionId,
                      root: openRoot,
                      params: t.params,
                      services,
                      uid: t.uid,
                      openTab: openTabInSession,
                      closeTab: closeTabInSession,
                      startSideChat,
                      ptyIdFor,
                      onPtyAllocated: handlePtyAllocated,
                      chatSinkRef: t.params.sideId !== undefined ? sideSinksRef.current.get(t.params.sideId) : undefined,
                    })}
                    </Suspense>
                  </div>
                );
              })
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
      <WindowControls showSideToggle={page === 'chat' && !settingsOpen} onToggleRightSidebar={() => {
        const opening = tabState.collapsed;
        setTabStates((s) => setCollapsed(s, openSessionId, !opening));
        // 两侧抽屉互斥(2026-10-24 用户裁定):浮窗态开右抽屉即收菜单抽屉
        if (opening && sidebarFloating) setMenuClosed(true);
      }} />
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
  /** 2026-10-25:Web 标签「在系统浏览器打开」——shell.openExternal,OS 默认浏览器承接(非 Electron 子窗) */
  openExternal?: (url: string) => Promise<{ ok: boolean }>;
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
