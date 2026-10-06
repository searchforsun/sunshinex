import { useEffect, useRef, useState } from 'react';
import { createConnection } from './connection';
import type { Connection, ConnectionState, SnapshotResponse } from './connection';
import { applyBoardEvent, applyDelegation, boardEventFrom, emptyBoard } from './projection';
import type { TaskBoardState, Delegation } from './projection';
import { Home } from './pages/Home';
import { Chat } from './pages/Chat';
import { Board } from './pages/Board';
import type { ChatSink } from './pages/Chat';
import type { SessionEvent } from '../../src/types';

/**
 * G3.5 App 路由壳(会话中心):本地态 'home' | 'chat' + openSessionId——token 门面内单连接
 * (Home HTTP 面与 chat 事件面共用),Home 选中(attach/new)→ 挂 Chat;顶栏只余全局面
 * (brand/连接态),会话维顶栏(返回首页/sessionId/状态条)随 Chat 页。
 * 连接装配(会话维):onEvent(sessionId, e, seq) 单 WS 收全会话帧,sessionRef 判据过滤他会话
 * (本会话帧经 chatSinkRef 转投 Chat——连接回调闭包装配时固定,Chat 装配期注册 sink);板/委派
 * 投影随事件维稳(重连=onReset 清零+daemon 全量补发帧重建,G5 板页消费)。
 * Chat(T4δ)以 key={sessionId} 挂载:对话面本地态(reducer 投影/输入/播种门/竞态缓冲)随组件
 * 销毁——两会话先后打开各自投影独立,无跨会话串扰,不断连重连。onReset(首连与重连同路径)
 * → Chat.reset 本会话重播种(重连=重置投影+全量重放裁定)。G4 挂起面:onApproval/onAsk/
 * onResetSession 三回调同 pattern——sessionRef 过滤本会话后经 chatSinkRef 转投 Chat 卡片区。
 * G5 看板页:会话内 Chat|Board 双 tab(sessionTab 本地态;Chat 以 hidden 面常驻——tab 切换
 * 不卸毁对话面本地态,挂起卡/竞态缓冲/滚动零重播种)。Board props 全装配:board/delegations
 * 投影 + team(App 态,经 Chat onSeeded 回调自快照回填——事件流无 teammate 面,reseed 即更新;
 * 快照本就携带 board/delegations,一并回填:开 s2 即见 s2 快照板而非 s1 残留——会话切换串态
 * 根除;openSession/backHome 亦清板投影双保险,重开经快照重建权威态)。
 * gate 审批 onReview → conn.boardReview(sessionId, taskId, approved)。
 * onResetSession(G3.5 交接 d 收口):会话维 reset 除 Chat 重播种外,board/delegations 投影
 * 亦清(此前仅连接级 onReset 清——会话 reset 后板投影悬挂旧任务)。
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

/** 应用壳:单连接装配 + 路由(home|chat);chat 分支挂 Chat 页(key={sessionId} 会话隔离) */
function AppShell({ token }: { token: string }): JSX.Element {
  const [page, setPage] = useState<'home' | 'chat'>('home');
  const [openSessionId, setOpenSessionId] = useState<string>('');
  /** G5 会话内 tab:chat|board(Chat 常驻 hidden 面,Board 条件挂载——切换零重播种) */
  const [sessionTab, setSessionTab] = useState<'chat' | 'board'>('chat');
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [board, setBoard] = useState<TaskBoardState>(emptyBoard);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  /** G5 teammate 投影(App 态):snapshot.team 经 Chat onSeeded 回填——reseed 即更新 */
  const [team, setTeam] = useState<Array<{ name: string; busy: boolean }>>([]);
  const connRef = useRef<Connection | null>(null);
  /** 连接实例态:effect 装配后落位(Home/Chat 面消费;null = 装配中占位) */
  const [connInstance, setConnInstance] = useState<Connection | null>(null);
  /** 事件分发判据:连接回调闭包在装配时固定,会话切换经 ref 免闭包陈旧 */
  const sessionRef = useRef<string>('');
  sessionRef.current = openSessionId;
  /** Chat 事件转投面:Chat 装配期注册(卸载注销)——onEvent/onReset 经此投递 */
  const chatSinkRef = useRef<ChatSink | null>(null);

  useEffect(() => {
    const conn = createConnection({
      baseUrl: import.meta.env.VITE_SERVE_URL ?? location.origin,
      token,
      onEvent: (sessionId, e: SessionEvent, seq: number) => {
        if (sessionId !== sessionRef.current) return; // 他会话帧丢弃(连接层全收,投影只挂当前会话)
        if (e.type.startsWith('task-') || e.type.startsWith('gate-')) {
          setBoard((b) => applyBoardEvent(b, boardEventFrom(e)));
          return;
        }
        if (e.type.startsWith('delegation-')) setDelegations((d) => applyDelegation(d, e));
        chatSinkRef.current?.on(e, seq);
      },
      onReset: () => {
        // 重连/首连同路径:板/委派投影清零(随补发帧重建);Chat 投影由 sink.reset 清+本会话重播种
        setBoard(emptyBoard());
        setDelegations([]);
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
        //  ——会话 reset 后旧任务悬挂);Chat 卡区清+重播种经 sink
        setBoard(emptyBoard());
        setDelegations([]);
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

  /** Home 选中会话(attach/new 完成):切路由(Chat 装配期自播种基线);tab 归位 chat + 板投影/
   *  team 清零(会话切换串态防线——快照落定后经 onSeeded 重建权威态) */
  const openSession = (sessionId: string): void => {
    sessionRef.current = sessionId;
    setOpenSessionId(sessionId);
    setSessionTab('chat');
    setBoard(emptyBoard());
    setDelegations([]);
    setTeam([]);
    setPage('chat');
  };

  /** 返回首页:会话关窗(Chat 卸毁本地态;连接保持,再开经 Home 重播种)+ 板投影/team 清零
   *  (首页期间无会话帧消费,残留即陈旧) */
  const backHome = (): void => {
    sessionRef.current = '';
    setOpenSessionId('');
    setSessionTab('chat');
    setBoard(emptyBoard());
    setDelegations([]);
    setTeam([]);
    setPage('home');
  };

  /** G5 gate 审批装配:Board onReview → boardReview(sessionId, taskId, approved)——失败倒
   *  Chat error 条不静默(经 sink 合成 error 帧,seq 取上界保证种子缓冲过滤恒放行;成功面无
   *  HTTP 回执帧,daemon 侧 review 触发的 gate-resolved/task-status 事件帧自然回投板投影) */
  const reviewTask = (taskId: string, approved: boolean): void => {
    const conn = connRef.current;
    if (conn === null) return;
    void conn.boardReview(sessionRef.current, taskId, approved).catch((err: unknown) => {
      chatSinkRef.current?.on(
        { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() },
        Number.MAX_SAFE_INTEGER,
      );
    });
  };

  /** G5 Chat 播种回调:快照权威态回填 App 投影——team(事件流无此面)+board/delegations
   *  (快照本就携带:会话打开/reseed 即板随快照,事件帧续推叠加其后;旧档无 team 段防 undefined) */
  const seedFromSnapshot = (snap: SnapshotResponse): void => {
    setTeam(snap.team ?? []);
    setBoard(snap.board);
    setDelegations(snap.delegations);
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">sunshinex</span>
        <span className={`conn-dot conn-${connState}`} aria-label={`connection: ${connState}`} />
        <span className="conn-text">{connState}</span>
      </header>
      {page === 'home' ? (
        connInstance !== null ? (
          <Home conn={connInstance} onOpenSession={openSession} />
        ) : (
          <main className="home" aria-label="home">
            <p className="home-loading">连接装配中…</p>
          </main>
        )
      ) : connInstance !== null ? (
        <div className="session-shell">
          {/* G5 会话内 tab:Chat|Board(openSessionId 在场才渲染本壳) */}
          <nav className="session-tabs" aria-label="session tabs">
            <button type="button" aria-pressed={sessionTab === 'chat'} onClick={() => setSessionTab('chat')}>
              Chat
            </button>
            <button type="button" aria-pressed={sessionTab === 'board'} onClick={() => setSessionTab('board')}>
              Board
            </button>
          </nav>
          {/* Chat 常驻(hidden 面):tab 切换不卸毁——挂起卡/竞态缓冲/输入零重播种 */}
          <div className={`pane pane-chat${sessionTab === 'chat' ? '' : ' hidden'}`} hidden={sessionTab !== 'chat'}>
            <Chat
              key={openSessionId}
              conn={connInstance}
              sessionId={openSessionId}
              connState={connState}
              onBack={backHome}
              sinkRef={chatSinkRef}
              onSeeded={seedFromSnapshot}
            />
          </div>
          {sessionTab === 'board' && (
            <Board
              board={board}
              delegations={delegations}
              team={team}
              onReview={reviewTask}
              onBack={() => setSessionTab('chat')}
            />
          )}
        </div>
      ) : null}
      {/* board/delegations 投影 G5 板页消费(随事件/重放维稳;本壳只路由与连接装配) */}
    </div>
  );
}
