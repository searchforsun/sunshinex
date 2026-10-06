import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createConnection } from './connection';
import type { Connection, ConnectionState } from './connection';
import { applyChatEvent, appendUserMessage, initialChatState, seedChatFromSnapshot } from './chat-reducer';
import type { ChatEntry, ChatState } from './chat-reducer';
import { applyBoardEvent, applyDelegation, boardEventFrom, emptyBoard } from './projection';
import type { TaskBoardState, Delegation } from './projection';
import { Home } from './pages/Home';
import type { SessionEvent } from '../../src/types';

/**
 * G3.5 App 路由骨架(会话中心):本地态 'home' | 'chat' + openSessionId——token 门面内单连接
 * (Home HTTP 面与 chat 事件面共用),Home 选中(attach/new)→ chat;顶栏简化(路由 Back +
 * 会话占位 chip + 连接态;旧 Chat|Board tab 退场,G5 板页另议)。
 * 连接装配(会话维):onEvent(sessionId, e, seq) 单 WS 收全会话帧,投影只挂当前会话
 * (sessionRef 判据,他会话帧丢弃);onReset(首连与重连同路径)清投影 + 当前会话重拉
 * sessionSnapshot 重建基线(重连=重置投影+全量重放裁定)。
 * chat 分支为占位骨架:占位条渲染 sessionId(T4δ 装真 Chat 组件),下方暂留 G3 单页对话面
 * 的流式渲染/输入分流(最小适配到 :id 形态——sessionSubmit/sessionSteer/sessionInterrupt),
 * 板/委派投影随事件维稳(G5 页消费)。
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

/** 单条渲染单元(React.memo):reducer 保未动条目引用——流式 token 帧只有流式条重渲染(md 解析 O(1) 摊销) */
const ChatEntryView = memo(function ChatEntryView({ entry }: { entry: ChatEntry }): JSX.Element {
  return (
    <div className={`entry entry-${entry.kind}${entry.streaming === true ? ' streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.md}</ReactMarkdown>
    </div>
  );
});

/** 应用壳:单连接装配 + 路由(home|chat) + chat 占位分支(旧单页对话面最小适配) */
function AppShell({ token }: { token: string }): JSX.Element {
  const [page, setPage] = useState<'home' | 'chat'>('home');
  const [openSessionId, setOpenSessionId] = useState<string>('');
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [board, setBoard] = useState<TaskBoardState>(emptyBoard);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [input, setInput] = useState('');
  /** 播种在途门:基线快照落定前输入禁用——本地 user 回显先于种子落定会被种子整替清掉
   *  (openSession/onReset → sessionSnapshot 异步应答),提交必须在权威基线之后 */
  const [seeding, setSeeding] = useState(false);
  const connRef = useRef<Connection | null>(null);
  /** 连接实例态:effect 装配后落位(Home 面消费;null = 装配中占位) */
  const [connInstance, setConnInstance] = useState<Connection | null>(null);
  /** 事件分发判据:连接回调闭包在装配时固定,会话切换经 ref 免闭包陈旧 */
  const sessionRef = useRef<string>('');
  sessionRef.current = openSessionId;

  /** 会话基线重建(打开会话与 onReset 同路径):清投影 → sessionSnapshot 播种;
   *  迟到应答经 sessionRef 复核(已切会话的种子不污新投影);拉取失败倒 error 条不静默 */
  const reseed = (id: string): void => {
    setChat(initialChatState());
    setBoard(emptyBoard());
    setDelegations([]);
    setSeeding(true);
    connRef.current?.sessionSnapshot(id).then(
      (snap) => {
        if (sessionRef.current !== id) return;
        setChat(seedChatFromSnapshot(snap.messages, snap.status));
        setBoard(snap.board);
        setDelegations(snap.delegations);
        setSeeding(false);
      },
      (err: unknown) => {
        if (sessionRef.current !== id) return;
        setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
        setSeeding(false);
      },
    );
  };

  useEffect(() => {
    const conn = createConnection({
      baseUrl: import.meta.env.VITE_SERVE_URL ?? location.origin,
      token,
      onEvent: (sessionId, e: SessionEvent) => {
        if (sessionId !== sessionRef.current) return; // 他会话帧丢弃(连接层全收,投影只挂当前会话)
        if (e.type.startsWith('task-') || e.type.startsWith('gate-')) {
          setBoard((b) => applyBoardEvent(b, boardEventFrom(e)));
          return;
        }
        if (e.type.startsWith('delegation-')) setDelegations((d) => applyDelegation(d, e));
        setChat((c) => applyChatEvent(c, e));
      },
      onReset: () => {
        // 重连/首连同路径:投影清零;当前会话逐会话重拉快照(多会话重置裁定——连接层不自动拉)
        const id = sessionRef.current;
        if (id === '') return;
        reseed(id);
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

  /** Home 选中会话(attach/new 完成):切路由 + 基线播种 */
  const openSession = (sessionId: string): void => {
    sessionRef.current = sessionId;
    setOpenSessionId(sessionId);
    setPage('chat');
    reseed(sessionId);
  };

  const running = chat.status === 'running';

  /** Enter 分流:idle 提交 / running 插话;本地 user 回显(`> text`),失败倒 error 条 */
  const send = (): void => {
    const text = input.trim();
    const conn = connRef.current;
    const id = sessionRef.current;
    if (text === '' || conn === null || id === '') return;
    setChat((c) => appendUserMessage(c, text));
    setInput('');
    const req = running ? conn.sessionSteer(id, text) : conn.sessionSubmit(id, text);
    void req.catch((err: unknown) => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
    });
  };

  const interrupt = (): void => {
    const conn = connRef.current;
    const id = sessionRef.current;
    if (conn === null || id === '') return;
    void conn.sessionInterrupt(id).catch((err: unknown) => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
    });
  };

  return (
    <div className="app">
      <header className="topbar">
        {page === 'chat' && (
          <button type="button" className="back" onClick={() => setPage('home')}>
            ← 工作区
          </button>
        )}
        <span className="brand">sunshinex</span>
        {page === 'chat' && (
          <span className="session-chip" title="session(T4δ 装真 Chat 视图)">
            session {openSessionId}
          </span>
        )}
        <span className={`conn-dot conn-${connState}`} aria-label={`connection: ${connState}`} />
        <span className="conn-text">{connState}</span>
        {page === 'chat' && (
          <>
            <span className={`status-text status-${chat.status}`}>{chat.status}</span>
            <span className="tokens">{chat.tokens} tokens</span>
            <span className="steps">{chat.steps} steps</span>
          </>
        )}
      </header>
      {page === 'home' ? (
        connInstance !== null ? (
          <Home conn={connInstance} onOpenSession={openSession} />
        ) : (
          <main className="home" aria-label="home">
            <p className="home-loading">连接装配中…</p>
          </main>
        )
      ) : (
        <>
          <main className="chat" aria-label="chat">
            {/* 占位条:渲染 sessionId(T4δ 装真 Chat 组件后退场);下方为 G3 单页对话面暂留 */}
            <div className="session-placeholder">{openSessionId}</div>
            {chat.entries.map((entry) => (
              <ChatEntryView key={entry.key} entry={entry} />
            ))}
          </main>
          <footer className="composer">
            <input
              aria-label="message input"
              className="message-input"
              value={input}
              placeholder={running ? '插入运行中会话…' : '给 sunshinex 一个任务…'}
              disabled={connState !== 'open' || seeding}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send();
              }}
            />
            {running ? (
              <button type="button" className="stop" onClick={interrupt}>
                Stop
              </button>
            ) : (
              <button type="button" className="send" onClick={send} disabled={connState !== 'open' || seeding}>
                Send
              </button>
            )}
          </footer>
        </>
      )}
      {/* board/delegations 投影 G5 页消费(随事件/快照维稳;本壳只对话流) */}
    </div>
  );
}
