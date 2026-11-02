import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n';
import { t as tLabel } from './i18n';
import { GitCompare, Globe, MessageCircle, Copy, Minus, PanelRight, Square, SquareTerminal, X, type LucideIcon } from 'lucide-react';
import type { CSSProperties, MutableRefObject } from 'react';
import type { Connection, ConnectionState } from './connection';
import type { TodoItem } from '../../src/types';
import type { SessionProjection } from './projection';
import { EMPTY_PROJECTION, useConnectionWiring } from './use-connection-wiring';
import { Chat } from './pages/Chat';
import { DirOpenerContext } from './pages/chat/md-render';
import { ChatScrollbar } from './pages/chat/ChatScrollbar';
import type { ChatSink } from './pages/Chat';
import { ProjectMenu } from './sidebar/ProjectMenu';
import { PanelLeft } from 'lucide-react';
import { SettingsShell } from './settings/SettingsShell';
import { TabStrip } from './tabs/TabStrip';
import { Suspense } from 'react';
import { tabEntry, registryProbe } from './tabs/registry';
import { TabSkeleton } from './tabs/TabSkeleton';
import type { TabServices } from './tabs/registry';
import { REFRESHABLE_TAB_TYPES } from './tabs/sidebar-refresh';
import { ensureSession, openTab, closeTab, setActive, cycleTab, reorderTab, setCollapsed, patchTabMeta, emptyTabSession, reopenClosed, stripTabType, WELCOME_TAB_SEAT } from './tabs/tab-state';
import type { TabStates, TabTypeId, TabParams } from './tabs/tab-state';
import { useBoardSeed } from './use-board-seed';
import { WelcomeComposer } from './welcome/WelcomeComposer';
import type { WelcomeGoal } from './welcome/WelcomeComposer';
import { CHAT_MAX_EVENT, chatMaxFor } from './thread-width';
import { useAppearanceSync } from './use-appearance-sync';
import { useOpError } from './use-op-error';
import { useShellLayout } from './use-shell-layout';
import { useTabPersistence } from './use-tab-persistence';
import { useAgentBuckets, useChatMemory, useShadowHydrationRefs, bindShadowHydration } from './use-agent-projections';
import { NavButtons } from './NavButtons';
import { useNavHistory } from './use-nav-history';
import { useRestoreLast } from './use-restore-last';
import { usePtyRegistry } from './use-pty-registry';
import { useHeavyTabLru } from './use-heavy-tab-lru';
import { cleanPathInput, isAbsPath, joinWsPath, OPEN_DEFAULT_KEY, pathBasename, workspaceOfAbs } from './ui-util';

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
  const [welcomeGoal, setWelcomeGoal] = useState<WelcomeGoal | null>(null);
  const [page, setPage] = useState<'welcome' | 'chat'>('welcome');
  /** 2026-10-27 欢迎页全局草稿:座判定按页面不按 openSessionId——进欢迎页(新对话)不清会话,残留侧栏即此根因 */
  const isWelcome = page === 'welcome';
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
  const { agentActivitiesBySession, bumpActs, dropPendingFolds, flushActsNow } = useAgentBuckets();
  /** G14.2xx b 转录内存缓存(use-agent-projections 单点):Chat 卸载写回/重挂缓存直渲 */
  const { chatMemGet, chatMemPut } = useChatMemory((key) => runningIds.has(key)); // TTL 豁免:运行中会话不剔(60min,2026-10-26)
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
  const connRef = useRef<Connection | null>(null);
  /** 事件分发判据:连接回调闭包在装配时固定,会话切换经 ref 免闭包陈旧 */
  const sessionRef = useRef<string>('');
  sessionRef.current = openSessionId;
  /** Chat 事件转投面:Chat 装配期注册(卸载注销)——onEvent/onReset 经此投递 */
  const chatSinkRef = useRef<ChatSink | null>(null);
  /** G14.29 辅助会话 sink 表(sideId → sink ref):连接帧按键路由到旁路 Chat(板/委派/子智能体不聚) */
  const sideSinksRef = useRef<Map<string, MutableRefObject<ChatSink | null>>>(new Map());
  /** 板播种窗(use-board-seed 单点,2026-10-27 技术债轮 D53 批F 外提):G6 seq 门缓冲/重开/
   *  快照回填一条域一条文件;refs 穿透 use-connection-wiring 帧路由 */
  /** 快照 team.busy 权威(封悬空 agent run；与影子水合共用) */
  const busyTeamRef = useRef<ReadonlySet<string>>(new Set());
  const busyTeamReadyRef = useRef(false);
  const { boardPendingRef, boardSeedingRef, reopenBoardSeedWindow, seedFromSnapshot } = useBoardSeed({
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
  const connInstance = useConnectionWiring({
    sessionRef, chatSinkRef, sideSinksRef, boardPendingRef, boardSeedingRef,
    shadowHydrateRef, shadowHydratedRef, shadowHydratingRef, shadowBufRef, shadowCutRef, dropPendingActsRef, connRef,
    reopenBoardSeedWindow, bumpActs, setRecentVersion, setRunningIds, setProjection,
    setTodoBatches, setConnState, setBgTasks, setCatalogTick,
  });
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
        // 持久化编号题(daemon fork 落 meta「辅助对话 N」;2026-10-31 用户裁定页签显编号)
        const title = await conn.getSessionTitle(r.sessionId).then((x) => (typeof x.title === 'string' && x.title !== '' ? x.title : undefined)).catch(() => undefined);
        openTabInSession('sidechat', { sideId: r.sessionId, insert, ...(title !== undefined ? { title } : {}) });
      } catch {
        /* fork 失败静默(旁路非关键路径) */
      }
    })();
  };

  /** 辅助对话页签恢复(2026-10-31 用户裁定「辅助对话持久化+编号页签」):重进主会话即按 /sides
   *  清单恢复 辅助对话 N 页签(在座 side 会话才恢复——daemon 重启后缺席;用户关过的页签经
   *  dismissedRef 记忆不复活) */
  const sideTabDismissedRef = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    const conn = connInstance;
    if (conn === null || page !== 'chat' || openSessionId === '') return;
    void conn.sessionSides(openSessionId).then(
      (sides) => {
        const dismissed = sideTabDismissedRef.current.get(openSessionId);
        for (const sd of sides) {
          if (sd.sessionId === undefined) continue;
          if (dismissed?.has(sd.sessionId) === true) continue;
          setTabStates((st) => {
            const cur = st[openSessionId];
            if (cur !== undefined && cur.tabs.some((x) => x.params.sideId === sd.sessionId)) return st;
            return openTab(ensureSession(st, openSessionId, PROBE), openSessionId, 'sidechat', { sideId: sd.sessionId, title: sd.title }, PROBE);
          });
        }
      },
      () => undefined,
    );
  }, [connInstance, openSessionId, page]);

  const openSession = (sessionId: string, root: string, journalId?: string, inheritWelcomeDraft = false): void => {
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
    sessionRef.current = sessionId;
    const jid = journalId !== undefined && journalId !== '' ? journalId : sessionId;
    setOpenSessionId(sessionId);
    setOpenJournalId(jid);
    setOpenRoot(root);
    setTabStates((s) => ensureSession(s, sessionId, PROBE));
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
    void connRef.current
      ?.saveAppGuiState({ v: 1, lastRoot: root, ...(journalId !== undefined && journalId !== '' ? { lastJournalId: journalId } : {}) })
      .catch(() => undefined);
  };

  /** 恢复现场(use-restore-last 单点,2026-10-27 技术债轮 D53 批F 外提):指针档重放打开链,
   *  单次闸防 StrictMode 双跑(与既有 effect 序一致——原位即在此回调域) */
  useRestoreLast({ connInstance, connState, openSession });

  /** 返回欢迎态的壳层清场(记录面分离:backHome 记史,导航回放经 applyNav 复用本函数) */
  const leaveToWelcome = (): void => {
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
   *  重播种),welcome 则回欢迎空态;关壳即 bump settingsEpoch 重读 agentTeams(表单 autosave 已落) */
  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    setSettingsEpoch((v) => v + 1);
  }, []);

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
  const openDiffTab = useCallback((callId: string, path: string): void => { openTabInSession('diff', { callId, path }); }, [openTabInSession]);
  const openAgentTab = useCallback((label: string, agentTitle?: string, task?: string): void => { openTabInSession('agent', { label, agentTitle, task }); }, [openTabInSession]);
  /** 浏览器工具联动(2026-10-31 用户裁定「浏览器默认直接打开侧栏的浏览器」):agent 走
   *  browser_navigate 时 Chat 上抛 url,此处开 web 页签跟随(判重由 openTabInSession 承担) */
  const openWebTab = useCallback((url: string): void => { openTabInSession('web', { url }); }, [openTabInSession]);
  /** M2 融合(2026-11-02 用户裁定「页内超链接开新页签,和浏览器一样」):guest 弹窗 URL 由壳转发
   *  (main setWindowOpenHandler → builtin:open-url),此处开新侧栏 web 页签;判重由 openTab 承担 */
  // 订阅只挂一次,回调经 ref 取最新 openWebTab(闭包滞留首帧会话座=开签落错座,页签不可见)
  const openWebTabRef = useRef(openWebTab);
  openWebTabRef.current = openWebTab;
  useEffect(() => {
    const bridge = window.sunshinexWindow;
    if (bridge?.onOpenUrl === undefined) return;
    return bridge.onOpenUrl((url) => openWebTabRef.current(url));
  }, []);
  /** agents 页签 id=智能体团队页签(卡片流;tab 持久化档兼容保留旧 id);agentTeams 关闭时不挂载 */
  const openBoardTab = useCallback((): void => {
    if (!agentTeamsOn) return;
    openTabInSession('agents', {});
  }, [openTabInSession, agentTeamsOn]);
  const openTabType = useCallback((type: TabTypeId): void => {
    if (type === 'agents' && !agentTeamsOn) return;
    openTabInSession(type, {});
  }, [openTabInSession, agentTeamsOn]);
  const hiddenMenuIds = useMemo(
    () => (agentTeamsOn ? undefined : new Set<string>(['agents'])),
    [agentTeamsOn],
  );

  /** 记忆页签+定位(2026-10-31 用户裁定「点击打开侧栏对应记忆行」):focus slug 随 render props
   *  下发 MemoryTab,展开并滚至对应行;nonce 保证同 slug 重复点击仍触发 */
  const [memoryFocus, setMemoryFocus] = useState<{ slug: string; nonce: number } | undefined>(undefined);
  const openMemoryTab = useCallback((focus?: string): void => {
    openTabInSession('memory');
    setMemoryFocus(focus !== undefined && focus !== '' ? { slug: focus, nonce: Date.now() } : undefined);
  }, [openTabInSession]);
  /** 学习技能页签+定位(2026-11-01 用户裁定「点击正文 学习|更新技能 → 侧栏展开指定技能,内容原样展示」):
   *  与记忆同构——focus slug 随 render props 下发 LearnedSkillsTab,展开并滚至对应行 */
  const [learnedFocus, setLearnedFocus] = useState<{ slug: string; nonce: number } | undefined>(undefined);
  const openLearnedTab = useCallback((focus?: string): void => {
    openTabInSession('learned');
    setLearnedFocus(focus !== undefined && focus !== '' ? { slug: focus, nonce: Date.now() } : undefined);
  }, [openTabInSession]);
  /** 2026-10-27 目录树入左菜单层(用户裁定):menuDir={root,sessionId,locate?} 驱动 ProjectMenu 目录视图;
   *  locate=相对目录,树打开后逐层展开定位;sessionId 由 ensureSessionForRoot 落值 */
  const [menuDir, setMenuDir] = useState<{ root: string; sessionId: string; locate?: string } | null>(null);
  /** 组头/正文目录链:ensureSession → 左菜单目录视图;locate 相对路径则树内展开定位 */
  const openProjectDirectory = useCallback((root: string, locate?: string): void => {
    if (connInstance === null || root === '') return;
    setMenuClosed(false);
    // 同项目目录视图已开:只换 locate(避免重拉建席)
    if (menuDir !== null && menuDir.root === root) {
      setMenuDir({ ...menuDir, locate });
      return;
    }
    void Promise.resolve()
      .then(() => connInstance.sessionsOf(root))
      .then((rows) => {
        const first = rows[0];
        return first !== undefined
          ? { sessionId: first.liveSessionId ?? connInstance.newSession(root).then((r) => r.sessionId) }
          : connInstance.newSession(root).then((r) => ({ sessionId: r.sessionId }));
      })
      .then(({ sessionId }) => Promise.resolve(sessionId).then((sid) => setMenuDir({ root, sessionId: sid, locate })))
      .catch(showOpError);
    // eslint 不入依赖(setMenuClosed/setMenuDir 恒稳;connInstance 由连接生命周期持有)
  }, [connInstance, menuDir]);
  /** 目录路径:在册项目 → 左侧树定位该项目+相对路径;否则按用户默认打开方式(资源管理器/vscode…)外开 */
  const openDirectoryPath = useCallback((raw: string): void => {
    if (connInstance === null) return;
    const cleaned = cleanPathInput(raw);
    const abs = isAbsPath(cleaned)
      ? cleaned.replace(/[\\/]+$/, '') || cleaned
      : joinWsPath(openRoot || '', cleaned).replace(/[\\/]+$/, '');
    if (abs === '') return;
    void connInstance
      .workspaces()
      .then((rows) => {
        const hit = workspaceOfAbs(abs, rows.flatMap((r) => (r.root !== undefined && r.root !== '' ? [r.root] : [])));
        if (hit !== null) {
          openProjectDirectory(hit.root, hit.rel === '' ? undefined : hit.rel);
          return;
        }
        return connInstance.openInEditor(abs, localStorage.getItem(OPEN_DEFAULT_KEY) ?? 'explorer');
      })
      .catch(showOpError);
  }, [connInstance, openRoot, openProjectDirectory]);
  /** 文件开签;尾斜杠=目录 → 走 openDirectoryPath(正文目录芯片/畸形 ./D:\\… 同口径) */
  const openFileTab = useCallback((p: string): void => {
    const cleaned = cleanPathInput(p);
    if (/[\\/]$/.test(cleaned) || /[\\/]$/.test(p.trim())) {
      openDirectoryPath(cleaned === '' ? p : cleaned);
      return;
    }
    openTabInSession('file', { path: cleaned === '' ? p : cleaned });
  }, [openTabInSession, openDirectoryPath]);
  /** 树内点文件排队旗:目标会话成为打开会话后补开文件标签(欢迎页/无会话态先建席再进) */
  const pendingFileTabRef = useRef<string | null>(null);
  useEffect(() => {
    if (openSessionId === '' || pendingFileTabRef.current === null) return;
    const p0 = pendingFileTabRef.current;
    pendingFileTabRef.current = null;
    openFileTab(p0);
  }, [openSessionId, openFileTab]);
  /** 树内点文件→右侧文件标签:有打开会话直接开(服务端信任根已放行跨项目);无会话(欢迎页)→
   *  建席+attach+openSession 进会话,标签经 pendingFileTabRef 排队补开 */
  const openFileFromTree = useCallback((path: string, root: string): void => {
    const abs = joinWsPath(root, path);
    if (openSessionId !== '') {
      openFileTab(abs);
      return;
    }
    if (connInstance === null) return;
    pendingFileTabRef.current = abs;
    void Promise.resolve()
      .then(() => connInstance.sessionsOf(root))
      .then((rows) => {
        const first = rows[0];
        if (first === undefined) return connInstance.newSession(root).then((r) => ({ sessionId: r.sessionId, journalId: undefined as string | undefined }));
        return connInstance
          .newSession(root)
          .then(({ sessionId }) => connInstance.attach(sessionId, first.id).then((r) => ({ sessionId: r.sessionId, journalId: first.id })));
      })
      .then(({ sessionId, journalId }) => openSession(sessionId, root, journalId))
      .catch((err: unknown) => {
        // 建席链败:排队旗回收——残留会在用户下次打开任意会话时补开出陈旧路径的幽灵文件标签
        pendingFileTabRef.current = null;
        showOpError(err);
      });
    // eslint 不入依赖(openSession 恒稳;connInstance 由连接生命周期持有)
  }, [openSessionId, openFileTab, connInstance]);
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

  /** pty 记账(use-pty-registry 单点,2026-10-27 技术债轮 D53 批F 外提):terminal 标签 uid→ptyId */
  const { handlePtyAllocated, ptyIdFor, takePtyId } = usePtyRegistry(openSessionId, setTabStates);

  /** G8b 关标签链(TabStrip onClose/onCloseActive 共用):被关标签为 terminal 且 pty 已记账 →
   *  fire-and-forget killPty(拒约吞——关标签不等 HTTP;已关会话侧幂等)再关标签态 */
  const closeTabInSession = (uid: string): void => {
    // 辅助对话页签关闭即记忆(重进主会话不复活;切会话不误记——按当前席上该页签的 sideId 记)
    const seat = isWelcome ? WELCOME_TAB_SEAT : openSessionId;
    const tab = tabStates[seat]?.tabs.find((x) => x.uid === uid);
    if (tab !== undefined && tab.type === 'sidechat' && tab.params.sideId !== undefined) {
      const set = sideTabDismissedRef.current.get(seat) ?? new Set<string>();
      set.add(tab.params.sideId);
      sideTabDismissedRef.current.set(seat, set);
    }
    const t = tabState.tabs.find((x) => x.uid === uid);
    if (t?.type === 'terminal') {
      const ptyId = takePtyId(uid);
      if (ptyId !== undefined) {
        const conn = connRef.current;
        // killPty 尽力而为:标签已关,失败=daemon 侧 pty 随会话 teardown 兜底回收,无用户可见后果
        if (conn !== null) {
          if (isWelcome) void conn.killPtyAt(ptyId).catch(() => {});
          else void conn.killPty(openSessionId, ptyId).catch(() => {});
        }
      }
    }
    setTabStates((s) => closeTab(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, uid));
  };

  /** 任务板停钮：pending|running → boardStop。失败倒 Chat error 条。 */
  const stopTask = useCallback((taskId: string): void => {
    const conn = connRef.current;
    if (conn === null) return;
    void conn.boardStop(sessionRef.current, taskId).catch((err: unknown) => {
      chatSinkRef.current?.on(
        { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() },
        Number.MAX_SAFE_INTEGER,
      );
    });
  }, []);

  /** 标签体服务面(任务板/agent 转录页签消费):板投影 + 浅拷贝数组(既有 Board 收可变数组,T3 桥接)+
   *  G8d 子智能体活动聚合(agent 只读转录页只读) */
  /** G14.2xx web 标签元数据回写:页内导航 url/页名 → patchTabMeta(标签条标题/判重键同源演进,
   *  浏览器原生标签形);useCallback 零依赖稳定——services useMemo 不因回写重建 */
  /** 页签切换(agent 驱动内置浏览器页签时侧栏跟随):同 onTabMeta 双座都试,并展开收起的侧栏 */
  const onActivateTab = useCallback((sessionId: string, uid: string): void => {
    setTabStates((s) => {
      const has = (seat: string): boolean => s[seat]?.tabs.some((t) => t.uid === uid) === true;
      const seat = has(sessionId) ? sessionId : has(WELCOME_TAB_SEAT) ? WELCOME_TAB_SEAT : undefined;
      return seat === undefined ? s : setActive(setCollapsed(s, seat, false), seat, uid);
    });
  }, []);
  const onTabMeta = useCallback((sessionId: string, uid: string, patch: { url?: string; pageTitle?: string; pageIcon?: string }): void => {
    // 欢迎页页签落 '@welcome' 草稿座,而渲染传入的 sessionId 是 openSessionId(欢迎页不清,指向上个
    // 会话)——只按 sessionId 回写会落空,欢迎页浏览器页签名/站标永不更新;uid 全局唯一,双座都试
    setTabStates((s) => patchTabMeta(patchTabMeta(s, sessionId, uid, patch), WELCOME_TAB_SEAT, uid, patch));
  }, []);
  /** 后台任务页签+行定位(task_wait 链路;与板面 openTaskFocus 分立——账本≠板) */
  const [bgFocus, setBgFocus] = useState<{ id: string; nonce: number } | undefined>(undefined);
  const openBgTaskFocus = useCallback((id: string): void => {
    openTabInSession('bgtasks');
    if (id !== '') setBgFocus({ id, nonce: Date.now() });
  }, [openTabInSession]);
  /** 工具行定位:开任务板页签 + focus。`bg:` 前缀=后台任务账本行(task_wait);
   *  `team:` 前缀=队卡定位；其余=板任务行高亮(create_agent_team_task/agent_team_task_wait 等) */
  const openTaskFocus = useCallback((ref: string): void => {
    if (ref.startsWith('bg:')) {
      openBgTaskFocus(ref.slice(3));
      return;
    }
    openBoardTab();
    if (ref.startsWith('team:')) setTaskFocus({ ref: ref.slice(5), nonce: Date.now(), kind: 'team' });
    else setTaskFocus({ ref, nonce: Date.now(), kind: 'task' });
  }, [openBoardTab, openBgTaskFocus]);
  /** 智能体团队刷新:快照整替 board/teams/team/delegations(成员名册仅快照有——漏 team 即「暂无成员」) */
  const refreshBoard = useCallback((sessionId: string): Promise<void> => {
    if (connRef.current === null) return Promise.resolve();
    return connRef.current.sessionSnapshot(sessionId).then((snap) =>
      setProjection((p) => ({
        ...p,
        board: snap.board,
        teams: snap.teams ?? [],
        team: snap.team ?? [],
        delegations: snap.delegations ?? [],
      })),
    );
  }, []);
  const services = useMemo<TabServices>(
    () => ({
      board: projection.board, delegations: [...projection.delegations], team: [...projection.team], teams: projection.teams, onStopTask: stopTask, onTabMeta, onActivateTab, agentActivities: agentActivitiesBySession[openSessionId] ?? {}, todos: [...projection.sessionTodos],
      // todo 批次合并(权威播种+转录派生):同签名派生优先(条目随回填/live 更新 ts 更新),ts 正序
      todoBatches: (() => {
        const bySig = new Map<string, import('./pages/Chat').TodoBatch>();
        for (const b of seededTodoBatches) bySig.set(b.items.map((i) => i.text).join('|'), b);
        for (const b of todoBatches) bySig.set(b.items.map((i) => i.text).join('|'), b);
        return [...bySig.values()].sort((a, b) => a.ts - b.ts);
      })(),
      taskFocus, onOpenTask: openTaskFocus,
      refreshBoard,
      bgTasks,
      onRefreshBgTasks: (): Promise<void> =>
        connRef.current === null
          ? Promise.resolve()
          : connRef.current.sessionTasks(openSessionId).then((rows) => setBgTasks(rows)),
    }),
    [projection, stopTask, onTabMeta, agentActivitiesBySession, openSessionId, todoBatches, seededTodoBatches, taskFocus, openTaskFocus, refreshBoard, bgTasks],
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
  const activeTab = tabState.tabs.find((t) => t.uid === tabState.activeUid) ?? null;

  /** 窗口程序化拖拽:拖拽面是 [data-drag-band]。按下后光标移动满 4px 才发 drag-start,
   *  纯点击不通知壳(壳侧 setPosition 在无边框窗上会改宽高)。mouseup 发 drag-end。
   *  双击拖拽面切换最大化。按钮、输入和弹层不进入拖拽。 */
  useEffect(() => {
    if (!IS_SHELL) return;
    let armed = false;
    let sx = 0;
    let sy = 0;
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t === null || t.closest('button, input, textarea, select, [role="button"], [role="dialog"], [role="menu"]') !== null) return;
      if (t.closest('[data-drag-band]') === null) return;
      armed = true;
      sx = e.screenX;
      sy = e.screenY;
    };
    const onMove = (e: MouseEvent): void => {
      if (!armed || e.buttons !== 1) return;
      if (Math.hypot(e.screenX - sx, e.screenY - sy) < 4) return;
      armed = false;
      winBridge()?.dragStart?.();
    };
    const onUp = (): void => {
      armed = false;
      winBridge()?.dragEnd?.();
    };
    const onDbl = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t === null || t.closest('button, input, textarea, select, [role="button"], [role="dialog"], [role="menu"]') !== null) return;
      if (t.closest('[data-drag-band]') === null) return;
      winBridge()?.toggleMaximize?.();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('dblclick', onDbl, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('dblclick', onDbl, true);
      winBridge()?.dragEnd?.();
    };
  }, []);

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
   *  切会话换挂,重挂后需重挂观察器 */
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
  }, [settingsOpen, page, tabState.collapsed, openSessionId]);

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
              onOpenDirectory={(root) => { openProjectDirectory(root); }}
              dirView={menuDir}
              onCloseDirView={() => setMenuDir(null)}
              onOpenFileFromTree={openFileFromTree}
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
                    setTabStates((s) => setCollapsed(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, true));
                  }
                }}
                conn={connInstance}
                sessionId={openSessionId}
                journalId={openJournalId}
                chatMem={{ get: chatMemGet, put: chatMemPut }}
                connState={connState}
                onBack={backHome}
                sinkRef={chatSinkRef}
                onSeeded={(snap) => {
                  seedFromSnapshot(snap);
                  // todo 批次权威投影播种(daemon journal 全量派生;快照未带=旧 daemon,清空走纯派生面)
                  setSeededTodoBatches(snap.todoBatches ?? []);
                }}
                onOpenFile={openFileTab}
                onOpenDiff={openDiffTab}
                onOpenAgent={openAgentTab}
                onOpenWeb={openWebTab}
                onOpenTask={openTaskFocus}
                onOpenTab={openTabType}
                agentTeamsOn={agentTeamsOn}
                bgRunning={bgTasks.filter((r) => r.status === 'running').length}
                board={projection.board}
                teams={projection.teams}
                onTodoBatches={setTodoBatches}
                pendingGoal={welcomeGoal ?? undefined}
                onPendingGoalDone={() => setWelcomeGoal(null)}
                root={openRoot}
                onTodos={setSessionTodos}
                onRenamed={() => setRecentVersion((v) => v + 1)}
                onSessionsMutated={() => setRecentVersion((v) => v + 1)}
                onSideChat={startSideChat}
                onOpenMemory={openMemoryTab}
                onOpenLearned={openLearnedTab}
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
                  // 发出去=临时会话转正:唯一放行草稿继承的入口(第 4 参,见 openSession 迁移门)
                  openSession(sessionId, root, undefined, true);
                }}
              />
              </>
            ) : (
              <div className="sx-welcome-brand">Sunshinex</div>
            )}
          </main>
          {/* 右栏:会话标签页(G10:welcome 态整体不渲染;G14.28:折叠态也不渲染——展开钮入 Chat 顶栏) */}
          {(page === 'chat' || page === 'welcome') && !tabState.collapsed && (
          <aside className="sx-sidebar" ref={sidebarRef} style={{ '--sb-w': `${tabState.width}px`, '--drawer-w': `${sidebarRenderW}px` } as CSSProperties}>
            <TabStrip
              tabs={tabState.tabs}
              activeUid={tabState.activeUid}
              disabled={page !== 'chat' && page !== 'welcome'}
              welcomeOnly={isWelcome}
              projectName={openRoot !== '' ? pathBasename(openRoot.replace(/[\/]+$/, '')) : undefined}
              onSelect={(uid) => setTabStates((s) => setActive(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, uid))}
              onReorder={(from, to) => setTabStates((s) => reorderTab(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, from, to))}
              onClose={closeTabInSession}
              onOpenType={(t) => {
                // G14.2xx 辅助对话特判:sidechat 需先 fork 出 side 会话(拿 sideId)再开页——
                // 直接 openTab 只会落无 sideId 的空壳档;startSideChat 完成装配+开页一条龙
                if (t === 'sidechat') {
                  startSideChat();
                  return;
                }
                if (t === 'agents' && !agentTeamsOn) return;
                openTabInSession(t, tabEntry(t).mintParams?.());
              }}
              onCycle={(d) => setTabStates((s) => cycleTab(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, d))}
              recentClosed={tabState.recentClosed}
              onReopenClosed={(i) => {
                const seat = isWelcome ? WELCOME_TAB_SEAT : openSessionId;
                const entry = tabState.recentClosed[i];
                if (entry?.type === 'agents' && !agentTeamsOn) return;
                setTabStates((s) => reopenClosed(s, seat, i, PROBE));
              }}
              hiddenMenuIds={hiddenMenuIds}
              onCloseActive={() => {
                const uid = tabState.activeUid;
                if (uid !== null) closeTabInSession(uid);
              }}
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
                    {isWelcome && !['file', 'web', 'terminal'].includes(t.type) ? (
                      /* 2026-10-27 欢迎页全局草稿:会话绑定型页签(待办/审查/智能体/上下文等)在无会话
                          草稿座不渲染内容——首个输入建席迁移后自动可用。2026-10-29 用户实测修正:
                          判定按页面(isWelcome)不按 openSessionId 空——5232DCE 起进欢迎页不清
                          openSessionId,开过会话再回欢迎页此条件恒假,浏览器/终端卡与 + 菜单全灭 */
                      <div className="sx-tab-empty">
                        <div className="sx-tab-empty-title">{tLabel('Available after a session starts', '会话开始后可用')}</div>
                        <div className="sx-tab-empty-sub">{tLabel('This panel is session-bound. Send a message to bind the draft sidebar to a session.', '此面板绑定会话。发送一条消息即可把当前草稿侧栏绑定到会话。')}</div>
                      </div>
                    ) : (
                    tabEntry(t.type).render({
                      conn: connInstance,
                      sessionId: openSessionId,
                      root: openRoot,
                      params: t.params,
                      services,
                      uid: t.uid,
                      openTab: openTabInSession,
                      openFilePath: openFileTab, // 目录回抛走左树定位/配置打开方式外开(2026-10-30)
                      closeTab: closeTabInSession,
                      startSideChat,
                      ptyIdFor,
                      onPtyAllocated: handlePtyAllocated,
                      chatSinkRef: t.params.sideId !== undefined ? sideSinksRef.current.get(t.params.sideId) : undefined,
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
                  {(isWelcome
                    ? [
                        ['web', Globe, t('Browser', '浏览器'), (): void => openTabInSession('web')],
                        ['terminal', SquareTerminal, t('Terminal', '终端'), (): void => openTabInSession('terminal')],
                      ] as [string, LucideIcon, string, () => void][]
                    : [
                        ['side', MessageCircle, t('Side chat', '辅助对话'), (): void => startSideChat()],
                        ['web', Globe, t('Browser', '浏览器'), (): void => openTabInSession('web')],
                        ['terminal', SquareTerminal, t('Terminal', '终端'), (): void => openTabInSession('terminal')],
                        ['diff', GitCompare, t('Review', '审查'), (): void => openTabInSession('diff')],
                      ] as [string, LucideIcon, string, () => void][]).map(([key, Icon, label, onClick]) => (
                    <button key={key} type="button" className="sx-tab-empty-card" onClick={onClick}>
                      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(page === 'chat' || page === 'welcome') && !tabState.collapsed && <div className="sx-resizer" onMouseDown={startResize} />}
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

/** 桌面壳判定(2026-10-23 用户实测修正):UA 含 Electron 不充分——ZCode 等 Electron 系
 *  浏览器的内嵌页同样命中,致 web 误吃桌面让位(页签条 92px 幽灵簇位,[|] 不贴右缘);
 *  须自家 preload 桥在场才算桌面壳(桥由 contextBridge 注入,先于页面脚本,模块期可判) */
const IS_SHELL =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Electron') &&
  typeof window.sunshinexWindow !== 'undefined';

/** 桌面窗控桥(preload 注入;浏览器态无此全局——形态单点声明见 env-global.d.ts Window.sunshinexWindow) */
const winBridge = (): Window['sunshinexWindow'] => (IS_SHELL ? window.sunshinexWindow : undefined);

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
