import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseLanguage, setLanguage } from './i18n';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { createConnection } from './connection';
import type { Connection, ConnectionState, SnapshotResponse } from './connection';
import { applyBoardEvent, applyDelegation, boardEventFrom, emptyBoard } from './projection';
import type { TaskBoardState, Delegation } from './projection';
import { Chat } from './pages/Chat';
import type { ChatSink } from './pages/Chat';
import { ProjectMenu } from './sidebar/ProjectMenu';
import { SettingsShell } from './settings/SettingsShell';
import { TabStrip } from './tabs/TabStrip';
import { tabEntry, registryProbe } from './tabs/registry';
import type { TabServices } from './tabs/registry';
import { ensureSession, openTab, closeTab, setActive, cycleTab, setCollapsed, setWidth, emptyTabSession } from './tabs/tab-state';
import type { TabStates, TabTypeId, TabParams } from './tabs/tab-state';
import { applyAgentEvent } from './tabs/agent-activity';
import type { AgentActivities } from './tabs/agent-activity';
import type { SessionEvent } from '../../src/types';

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
 * 标签仍可从目录/+菜单开);右栏 collapsed 只余折叠钮,拖宽边条 clamp 200..720(右栏在右,
 * 向左拖=变宽)。
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

/** token 解析(main 装配同源逻辑):URL ?token= 优先(非空即回写 localStorage 持久),回落 localStorage */
const TOKEN_STORAGE_KEY = 'sunshinex.token';

function readToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl !== null && fromUrl !== '') {
    localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
}

/** 判重/单例探针(tab-state 真实现,TAB_REGISTRY 装配;模块级单例——零态闭包可安全共享) */
const PROBE = registryProbe();

/** 会话根:token 在场才建连接(单连接生命周期,token 变更=重装配) */
export function App(): JSX.Element {
  const [token, setToken] = useState<string>(readToken);
  if (token === '') return <TokenGate onSave={(t) => setToken(t)} />;
  return <AppShell token={token} />;
}

/** token 输入页(无 token 不建连接;提交即持久 localStorage 并进入会话) */
function TokenGate({ onSave }: { onSave: (token: string) => void }): JSX.Element {
  const [value, setValue] = useState('');
  return (
    <form
      className="token-gate"
      onSubmit={(e) => {
        e.preventDefault();
        const t = value.trim();
        if (t === '') return;
        localStorage.setItem(TOKEN_STORAGE_KEY, t);
        onSave(t);
      }}
    >
      <label>
        serve token
        <input aria-label="token input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </label>
      <button type="submit">Connect</button>
      <p className="hint">token 亦可经 URL 携带:?token=&lt;serve-token&gt;</p>
    </form>
  );
}

/** 应用壳:单连接装配 + 三栏路由(左 ProjectMenu|中 Chat 恒挂|右标签栏);welcome = 无会话空态 */
function AppShell({ token }: { token: string }): JSX.Element {
  const [page, setPage] = useState<'welcome' | 'chat'>('welcome');
  const [openSessionId, setOpenSessionId] = useState<string>('');
  /** 当前会话所属工作区 root(ProjectMenu activeRoot 组自动展开的判据;'' = 无) */
  const [openRoot, setOpenRoot] = useState<string>('');
  /** G8a 标签态总表:每会话独立(backHome 保留——重开同会话标签还原,spec §1) */
  const [tabStates, setTabStates] = useState<TabStates>({});
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [board, setBoard] = useState<TaskBoardState>(emptyBoard);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  /** G5 teammate 投影(App 态):snapshot.team 经 Chat onSeeded 回填——reseed 即更新 */
  const [team, setTeam] = useState<Array<{ name: string; busy: boolean }>>([]);
  /** G8d 子代理活动聚合(App 态):payload.subagent 标签流经 applyAgentEvent 归约——Agents 标签
   *  只读消费(services.agentActivities);delegation 起止 label 命中既有卡时改状态(权威终语) */
  const [agentActivities, setAgentActivities] = useState<AgentActivities>({});
  const connRef = useRef<Connection | null>(null);
  /** 连接实例态:effect 装配后落位(左栏/中栏/标签体消费;null = 装配中占位) */
  const [connInstance, setConnInstance] = useState<Connection | null>(null);
  /** 事件分发判据:连接回调闭包在装配时固定,会话切换经 ref 免闭包陈旧 */
  const sessionRef = useRef<string>('');
  sessionRef.current = openSessionId;
  /** Chat 事件转投面:Chat 装配期注册(卸载注销)——onEvent/onReset 经此投递 */
  const chatSinkRef = useRef<ChatSink | null>(null);
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
   *  不渲染,Chat 卸载——返回重播种,与 backHome 同语义可接受);settingsRoot=设置面项目上下文
   *  (开设置时快照 openRoot,无则 ''=仅全局;项目选择器可切) */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRoot, setSettingsRoot] = useState('');

  /** 播种窗重开(清缓冲):openSession/onReset/onResetSession 三处——均伴随 Chat reseed,
   *  窗内残留帧属旧基线/旧板,弃 */
  const reopenBoardSeedWindow = (): void => {
    boardPendingRef.current = [];
    boardSeedingRef.current = true;
  };

  useEffect(() => {
    const conn = createConnection({
      baseUrl: import.meta.env.VITE_SERVE_URL ?? location.origin,
      token,
      onEvent: (sessionId, e: SessionEvent, seq: number) => {
        if (sessionId !== sessionRef.current) return; // 他会话帧丢弃(连接层全收,投影只挂当前会话)
        if (e.type.startsWith('task-') || e.type.startsWith('gate-')) {
          // G6 seq 门:播种窗内缓冲(onSeeded 后过滤重放),窗外直投
          if (boardSeedingRef.current) boardPendingRef.current.push({ e, seq });
          else setBoard((b) => applyBoardEvent(b, boardEventFrom(e)));
          return;
        }
        if (e.type.startsWith('delegation-')) {
          if (boardSeedingRef.current) boardPendingRef.current.push({ e, seq });
          else {
            setDelegations((d) => applyDelegation(d, e));
            // G8d:delegation 起止无 subagent 标签——payload.label 命中既有卡才改状态(Runner 权威
            // 终语:ended failed → error·done → done;未建卡原引用返回,React 同引用即免重渲染)
            setAgentActivities((a) => applyAgentEvent(a, e));
          }
        }
        if (typeof e.payload?.subagent === 'string') {
          // G8d 子代理事件另轨(Agents 标签聚合):不投 chat——chat reducer 入口另有同判过滤兜底
          // (种子重放等路径仍过 reducer,零害保留);建卡/行化/水位在此单点归约
          setAgentActivities((a) => applyAgentEvent(a, e));
          return;
        }
        chatSinkRef.current?.on(e, seq);
      },
      onReset: () => {
        // 重连/首连同路径:板/委派投影清零 + 播种窗重开(随补发帧经 onSeeded 过滤重放;Chat 投影
        // 由 sink.reset 清+本会话重播种;welcome 无 sink 时帧被会话过滤,窗恒空悬挂至下次 openSession)
        reopenBoardSeedWindow();
        setBoard(emptyBoard());
        setDelegations([]);
        setAgentActivities({}); // G8d:子代理聚合清零(重连补发帧重建——连接层 seq 过滤防双应用)
        chatSinkRef.current?.reset();
      },
      // G4 挂起面装配:连接层回调闭包固定,经 sessionRef 过滤本会话后转投 Chat sink(卡片区);
      //  他会话挂起卡不显(本会话外无渲染面),他会话 reset 不触发重播种
      onApproval: (sessionId, pid, req) => {
        if (sessionId !== sessionRef.current) return;
        chatSinkRef.current?.onApproval(pid, req);
      },
      onAsk: (sessionId, pid, req) => {
        if (sessionId !== sessionRef.current) return;
        chatSinkRef.current?.onAsk(pid, req);
      },
      onResetSession: (sessionId) => {
        if (sessionId !== sessionRef.current) return;
        // G3.5 交接 d 收口(G5):会话维 reset 清 board/delegations 投影(仅连接级 onReset 清的缺口
        //  ——会话 reset 后旧任务悬挂)+ 播种窗重开清缓冲(窗内帧属旧板,弃);Chat 卡区清+重播种经 sink
        reopenBoardSeedWindow();
        setBoard(emptyBoard());
        setDelegations([]);
        setAgentActivities({}); // G8d:会话维 reset 子代理聚合同清(swap 新 Harness,旧卡作废)
        chatSinkRef.current?.resetSession();
      },
      onStateChange: setConnState,
    });
    connRef.current = conn;
    setConnInstance(conn);
    return () => {
      connRef.current = null;
      setConnInstance(null);
      conn.close();
    };
  }, [token]);

  /** 拖宽在途兜底解绑(会话切走/壳卸毁时 window 监听不泄漏) */
  /** GUI chrome 双语(G10-C3c):语言源 = daemon settings language 键,连接装配即同步 */
  useEffect(() => {
    if (connInstance === null) return;
    connInstance.settings().then(
      (view) => {
        const raw = view.keys.find((k) => k.key === 'language')?.value ?? undefined;
        setLanguage(parseLanguage(raw ?? undefined));
      },
      () => {},
    );
  }, [connInstance]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  /** 左栏选中会话(attach/新建完成):切路由(Chat 装配期自播种基线)+ ensureSession 建席
   *  (缺省「任务」页)+ 板投影/team 清零(会话切换串态防线——快照落定后经 onSeeded 重建
   *  权威态)+ 播种窗重开;tabStates 已有该会话则原样(重开同会话标签还原) */
  const openSession = (sessionId: string, root: string): void => {
    sessionRef.current = sessionId;
    setOpenSessionId(sessionId);
    setOpenRoot(root);
    setTabStates((s) => ensureSession(s, sessionId, PROBE));
    reopenBoardSeedWindow();
    setBoard(emptyBoard());
    setDelegations([]);
    setTeam([]);
    setAgentActivities({}); // G8d:会话切换串态防线(板/team 同款——聚合只挂当前会话帧)
    setPage('chat');
  };

  /** 返回欢迎态:会话关窗(Chat 卸毁本地态;连接保持,再开经左栏重播种)+ 板投影/team 清零
   *  (无会话期无帧消费,残留即陈旧)+ 播种窗缓冲清(再开重开窗);tabStates 保留(每会话
   *  独立留存,spec §1——重开同会话标签还原) */
  const backHome = (): void => {
    sessionRef.current = '';
    setOpenSessionId('');
    setOpenRoot('');
    reopenBoardSeedWindow();
    setBoard(emptyBoard());
    setDelegations([]);
    setTeam([]);
    setAgentActivities({}); // G8d:无会话期无帧消费,残留即陈旧
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
   *  tab-state(同目标重开=聚焦既有,单例类型单份) */
  const openTabInSession = (type: TabTypeId, params: TabParams = {}): void => {
    setTabStates((s) => openTab(s, openSessionId, type, params, PROBE));
  };

  /** G8b pty 分配落定记账(TerminalTab 回传;registry render props 面)——useCallback 零依赖
   *  (仅 ref)保稳定:TerminalTab 装配 effect 以此为依赖,inline 箭头会令其随 App 重渲染重跑 */
  const handlePtyAllocated = useCallback((uid: string, ptyId: string): void => {
    ptyIdsRef.current.set(uid, ptyId);
  }, []);

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
    let nextBoard = snap.board;
    let nextDelegations = snap.delegations;
    for (const f of replay) {
      if (f.e.type.startsWith('task-') || f.e.type.startsWith('gate-')) {
        nextBoard = applyBoardEvent(nextBoard, boardEventFrom(f.e));
      } else if (f.e.type.startsWith('delegation-')) {
        nextDelegations = applyDelegation(nextDelegations, f.e);
        // G8e-T2:delegation 帧补投子代理聚合(与 board/delegation 同窗)——窗外路径本就投
        // applyAgentEvent(权威终语:ended failed→error/done→done;label 命中既有卡才动),
        // 窗内缓冲帧此前只重放板/委派不投聚合,delegation 终语在播种窗内被吞(卡滞 running)
        setAgentActivities((a) => applyAgentEvent(a, f.e));
      }
    }
    setTeam(snap.team ?? []);
    setBoard(nextBoard);
    setDelegations(nextDelegations);
  };

  /** 标签体服务面(任务/Agents 标签消费):板投影 + 浅拷贝数组(既有 Board 收可变数组,T3 桥接)+
   *  G8d 子代理活动聚合(AgentsTab 只读) */
  const services = useMemo<TabServices>(
    () => ({ board, delegations: [...delegations], team: [...team], onReview: reviewTask, agentActivities }),
    [board, delegations, team, reviewTask, agentActivities],
  );

  /** 当前会话标签席(welcome 期空席占位——TabStrip 灰条;宽 32) */
  const tabState = tabStates[openSessionId] ?? emptyTabSession();
  const activeTab = tabState.tabs.find((t) => t.uid === tabState.activeUid) ?? null;

  /** 拖宽边条 mousedown:window mousemove 计算宽(右栏在右侧,向左拖=变宽;clamp 200..720 在
   *  tab-state.setWidth 单点),mouseup 解绑 + 移 active 类;每次 move 直接落态(React 批处理
   *  兜底);sessionId 起拖时定格(拖拽中会话切换属病态,不追) */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (page !== 'chat' || openSessionId === '' || tabState.collapsed) return;
    e.preventDefault(); // 拖宽期间禁原生文本选择拖选(G8e 终审 B;.sx-resizer 另挂 user-select:none)
    const el = e.currentTarget;
    el.classList.add('active');
    const startX = e.clientX;
    const startWidth = tabState.width;
    const sessionId = openSessionId;
    const onMove = (ev: MouseEvent): void => {
      setTabStates((s) => setWidth(s, sessionId, startWidth + startX - ev.clientX));
    };
    const stop = (): void => {
      el.classList.remove('active');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = stop;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  };

  const sidebarWidth = page === 'chat' && openSessionId !== '' ? (tabState.collapsed ? 32 : tabState.width) : 32;

  return (
    <div className="sx-shell">
      {settingsOpen && connInstance !== null ? (
        /* G8c-T8 设置态:左栏+主栏整体切换(SettingsShell 内含左导航与所选面板),右标签栏不渲染;
           Chat 卸载——返回重挂重播种(backHome 同语义),连接/板投影态不受扰 */
        <SettingsShell conn={connInstance} root={settingsRoot} onRootChange={setSettingsRoot} onBack={closeSettings} />
      ) : (
        <>
          {/* 左栏:项目分组(Home 职能内化;装配中占位) */}
          {connInstance !== null ? (
            <ProjectMenu
              conn={connInstance}
              connState={connState}
              activeSessionId={openSessionId}
              activeRoot={openRoot}
              onOpenSession={openSession}
              onOpenSettings={openSettings}
            />
          ) : (
            <nav className="sx-menu" aria-label="projects">
              <p className="home-loading">连接装配中…</p>
            </nav>
          )}
          {/* 中栏:Chat 恒挂(无会话=欢迎空态) */}
          <main className="sx-main">
            {page === 'chat' && connInstance !== null ? (
              <Chat
                key={openSessionId}
                conn={connInstance}
                sessionId={openSessionId}
                connState={connState}
                onBack={backHome}
                sinkRef={chatSinkRef}
                onSeeded={seedFromSnapshot}
                onOpenFile={(p) => openTabInSession('file', { path: p })}
                onOpenDiff={(callId, path) => openTabInSession('diff', { callId, path })}
                onFork={() => {
                  if (connInstance === null) return;
                  void connInstance
                    .sessionAnchors(openSessionId)
                    .then(async (a) => {
                      const last = a.length > 0 ? a[a.length - 1]!.turn : 1;
                      const r = await connInstance.forkSession(openSessionId, last);
                      openSession(r.sessionId, openRoot);
                    })
                    .catch(() => {});
                }}
                onRewind={(turn) => {
                  void connInstance
                    .rewindSession(openSessionId, turn)
                    .then(() => {
                      // 回退=换 journal 重新播种(Chat 内 reseed 由 key 不变触发不了——手动重挂:切走再切回同会话)
                      const rid = openSessionId;
                      const rr = openRoot;
                      setPage('welcome');
                      requestAnimationFrame(() => openSession(rid, rr));
                    })
                    .catch(() => {});
                }}
              />
            ) : (
              <div className="sx-welcome" aria-label="welcome">
                <div className="sx-welcome-brand">
                  Sunshinex<span className="sx-welcome-dot" />
                </div>
                <p className="sx-welcome-title">选择左侧会话,或在工作区分组内新建</p>
                <p className="sx-welcome-hint">
                  <kbd className="sx-kbd">Alt+Shift+S</kbd> 唤起窗口(桌面端) · 右栏「+」打开文件 / 任务 / 终端
                </p>
              </div>
            )}
          </main>
          {/* 右栏:会话标签页(无会话=灰条 32px;collapsed 只余折叠钮;标签体=活动标签渲染) */}
          <aside className="sx-sidebar" style={{ width: sidebarWidth }}>
            <TabStrip
              tabs={tabState.tabs}
              activeUid={tabState.activeUid}
              collapsed={tabState.collapsed || page !== 'chat'}
              disabled={page !== 'chat'}
              onSelect={(uid) => setTabStates((s) => setActive(s, openSessionId, uid))}
              onClose={closeTabInSession}
              onOpenType={(t) => openTabInSession(t, tabEntry(t).mintParams?.())}
              onToggleCollapse={() =>
                setTabStates((s) => setCollapsed(s, openSessionId, !(s[openSessionId]?.collapsed ?? false)))
              }
              onCycle={(d) => setTabStates((s) => cycleTab(s, openSessionId, d))}
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
                  params: activeTab.params,
                  services,
                  uid: activeTab.uid,
                  // G8b T7:标签体自治跳转面(DirectoryTab 文件行 → file 标签;Chat onOpenFile 同源)
                  openTab: openTabInSession,
                  ptyIdFor,
                  onPtyAllocated: handlePtyAllocated,
                })}
              </div>
            )}
            {page === 'chat' && !tabState.collapsed && <div className="sx-resizer" onMouseDown={startResize} />}
          </aside>
        </>
      )}
    </div>
  );
}
