import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createConnection } from './connection';
import type { Connection, ConnectionState } from './connection';
import { applyChatEvent, appendUserMessage, initialChatState, seedChatFromSnapshot } from './chat-reducer';
import type { ChatEntry, ChatState } from './chat-reducer';
import { applyBoardEvent, applyDelegation, boardEventFrom, emptyBoard } from './projection';
import type { TaskBoardState, Delegation } from './projection';
import type { SessionEvent } from '../../src/types';

/**
 * G3 对话页装配（G-D10：Codex 工作站的克制美学——单栏对话流 + 底部输入区 + 顶部状态条；
 * 无侧栏无多窗，板/委派视图 G5 页，Board tab 禁用占位）。App() 无 props 自装配：
 * - 三投影 useState（chat/board/delegations）+ 单连接 useEffect——onEvent 分发（task-/gate- → 板，
 *   delegation- → 委派+chat notice，其余进 chat reducer）；onResync 全重置（snapshot 唯一基线源：
 *   seedChatFromSnapshot + board/delegations 直取）；onStateChange 记连接态。
 * - token 门面：URL ?token= 优先（回写 localStorage 持久——刷新/重连免带参）→ localStorage
 *   ('sunshinex.token')；均缺场显示输入页。
 * - md 渲染：react-markdown + remark-gfm（entries 按 kind 样式钩子，代码块纯 pre 无高亮）；
 *   条目 React.memo——reducer 保未动条目引用，流式 token 帧重渲染收敛 O(1)（仅流式条）。
 * - 输入分流：Enter 在 idle=submit / running=steer；Stop 按钮替换提交语义（中断）。
 */

interface ImportMetaEnv {
  readonly VITE_SERVE_URL?: string;
}
declare global {
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/** token 解析（main 装配同源逻辑）：URL ?token= 优先（非空即回写 localStorage 持久），回落 localStorage */
const TOKEN_STORAGE_KEY = 'sunshinex.token';

function readToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl !== null && fromUrl !== '') {
    localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
}

/** 会话根：token 在场才建连接（单连接生命周期，token 变更=重装配） */
export function App(): JSX.Element {
  const [token, setToken] = useState<string>(readToken);
  if (token === '') return <TokenGate onSave={(t) => setToken(t)} />;
  return <ChatPage token={token} />;
}

/** token 输入页（无 token 不建连接；提交即持久 localStorage 并进入会话） */
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
      <p className="hint">token 亦可经 URL 携带：?token=&lt;serve-token&gt;</p>
    </form>
  );
}

/** 单条渲染单元（React.memo）：reducer 保未动条目引用——流式 token 帧只有流式条重渲染（md 解析 O(1) 摊销） */
const ChatEntryView = memo(function ChatEntryView({ entry }: { entry: ChatEntry }): JSX.Element {
  return (
    <div className={`entry entry-${entry.kind}${entry.streaming === true ? ' streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.md}</ReactMarkdown>
    </div>
  );
});

/** 对话页：连接装配 + 三投影 + 输入区（G-D10 单栏） */
function ChatPage({ token }: { token: string }): JSX.Element {
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [board, setBoard] = useState<TaskBoardState>(emptyBoard);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [input, setInput] = useState('');
  const connRef = useRef<Connection | null>(null);

  useEffect(() => {
    const conn = createConnection({
      baseUrl: import.meta.env.VITE_SERVE_URL ?? location.origin,
      token,
      onEvent: (e: SessionEvent) => {
        if (e.type.startsWith('task-') || e.type.startsWith('gate-')) {
          setBoard((b) => applyBoardEvent(b, boardEventFrom(e)));
          return;
        }
        if (e.type.startsWith('delegation-')) setDelegations((d) => applyDelegation(d, e));
        setChat((c) => applyChatEvent(c, e));
      },
      onResync: (snap) => {
        // 全投影重置：snapshot 是唯一基线源（重连/首连同路径）
        setChat(seedChatFromSnapshot(snap.messages, snap.status));
        setBoard(snap.board);
        setDelegations(snap.delegations);
      },
      onStateChange: setConnState,
    });
    connRef.current = conn;
    return () => {
      connRef.current = null;
      conn.close();
    };
  }, [token]);

  const running = chat.status === 'running';

  /** Enter 分流：idle 提交 / running 插话；本地 user 回显（`> text`，与归档面同款），失败倒 error 条 */
  const send = (): void => {
    const text = input.trim();
    const conn = connRef.current;
    if (text === '' || conn === null) return;
    setChat((c) => appendUserMessage(c, text));
    setInput('');
    const req = running ? conn.steer(text) : conn.submit(text);
    void req.catch((err: unknown) => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
    });
  };

  const interrupt = (): void => {
    void connRef.current?.interrupt().catch((err: unknown) => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
    });
  };

  return (
    <div className="app">
      <header className="topbar">
        <nav className="tabs" aria-label="views">
          <button type="button" className="tab tab-active">Chat</button>
          <button type="button" className="tab" disabled title="G5">Board</button>
        </nav>
        <span className={`conn-dot conn-${connState}`} aria-label={`connection: ${connState}`} />
        <span className="conn-text">{connState}</span>
        <span className={`status-text status-${chat.status}`}>{chat.status}</span>
        <span className="tokens">{chat.tokens} tokens</span>
        <span className="steps">{chat.steps} steps</span>
      </header>
      <main className="chat" aria-label="chat">
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
          disabled={connState !== 'open'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send();
          }}
        />
        {running ? (
          <button type="button" className="stop" onClick={interrupt}>Stop</button>
        ) : (
          <button type="button" className="send" onClick={send} disabled={connState !== 'open'}>Send</button>
        )}
      </footer>
      {/* board/delegations 投影 G5 页消费（本页只对话流；状态在此已随事件/快照维护） */}
    </div>
  );
}
