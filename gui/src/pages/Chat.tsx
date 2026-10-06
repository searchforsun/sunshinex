import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { applyChatEvent, appendUserMessage, initialChatState, seedChatFromSnapshot } from '../chat-reducer';
import type { ChatEntry, ChatState } from '../chat-reducer';
import type { Connection, ConnectionState, GuiApprovalReq, GuiAskAnswer, GuiAskReq, SnapshotResponse } from '../connection';
import type { SessionEvent } from '../../../src/types';

/**
 * T4δ Chat 页(G3 对话面会话化迁移):App 暂留的 G3 单页对话面(reducer/md 渲染/输入分流/Stop/
 * 状态条/播种门语义)整体迁入本组件,改会话维——动作走 :id(sessionSubmit/sessionSteer/
 * sessionInterrupt),基线经 conn.sessionSnapshot(sessionId) 播种;本地态(reducer 投影/输入/
 * 播种门)随组件销毁,App 以 key={sessionId} 挂载保证两会话先后打开互不串扰(无跨会话残留,
 * 不断连重连——连接生命周期在 App 壳)。
 *
 * 事件面经 App 壳转投(连接回调在 createConnection 装配时固定,Chat 无法自接):App 的 onEvent
 * 三参按 sessionRef 过滤本会话后经 sinkRef 投 `sink.on(e, seq)`;onReset(首连/重连同路径)投
 * `sink.reset()` → 本会话重播种(既有播种门语义:基线在途输入禁用,防本地回显被种子整替)。
 *
 * 每会话种子竞态缓冲(T3 收口):连接层抬基线(sessionSnapshot 应答抬高 lastSeqBySession)只在
 * HTTP 应答落定之后——seed 在途窗内到达的本会话帧已过连接层 seq 门,若直投 reducer 会被随后的
 * 种子整替清掉(丢帧),先缓冲;种子落定后以 seq ≤ snapshot.lastSeq 过滤(≤ 切割序者种子已含,
 * 再投即双应用)再依序投 reducer。G3 T3 连接层的单会话 armed/pending 语义在页内复刻(连接层
 * 已无 armed,页面自缓冲;reseed 时清缓冲重来,unmount 随组件销毁)。
 *
 * G4 挂起卡片区(转录上方固定区):App 的 onApproval/onAsk 经 sessionRef 过滤本会话后经 sink
 * 投递——ApprovalCard(kind/subject/reason + Allow/Deny/Always)/AskCard(question + 选项单/多选
 * + customIndex 自由输入 + Submit/Dismiss);回执走 conn.replyApproval/replyAsk(pid 契约:寻址
 * 用帧顶层 pid,非 req.id);卡列表 pid 管理——回执成功移,失败(404 已决)也移(不悬挂)。
 * 连接级 reset(重连)卡保留(daemon 未决重发被连接层 pid 去重);会话 reset 帧(resetSession)
 * 清卡(daemon 已 deny/dismissed 回填全部挂起)+清投影重播种。
 * G5 增两面:①顶栏 Delete(confirm → conn.deleteSession(sessionId) → onBack 回首页——Home
 * 行 Delete 以 journal id 寻址恒 404 退役,daemon 会话 id 才是回收端点的有效寻址);②status
 * 转 idle 清卡(effect 观察投影状态:run 收束 = daemon 已对本 run 挂起 deny 回填,本地卡随之
 * 清——reseed 后快照 status=idle 亦触发,不重建:snapshot.pending 仅 [{pid,kind}] 信号面,卡
 * req 内容不可恢复,跨会话卡恢复记档 G6+);③onSeeded(快照落定回调,App 借此取 snapshot.team
 * 存 App 态——事件流无 teammate 面,Board 侧栏的唯一来源)。
 */

/** App → Chat 事件转投面:Chat 装配期注册到 sinkRef(卸载注销 null)——连接层回调闭包固定,
 *  App 侧经 ref 转投免闭包陈旧 */
export interface ChatSink {
  /** 本会话帧(已过 App 侧 sessionId 过滤;seq 供种子竞态窗过滤) */
  on(e: SessionEvent, seq: number): void;
  /** 连接重置(首连/重连):清投影 + 本会话重播种(卡保留——挂起仍在 daemon 未决) */
  reset(): void;
  /** G4 审批挂起帧(已过 App 侧 sessionId 过滤;pid = 回执寻址键) */
  onApproval(pid: string, req: GuiApprovalReq): void;
  /** G4 问询挂起帧(同上) */
  onAsk(pid: string, req: GuiAskReq): void;
  /** G4 会话 reset 通知帧(本会话):清卡(daemon 已 deny/dismissed 回填) + 清投影重播种 */
  resetSession(): void;
}

export interface ChatProps {
  conn: Connection;
  /** 当前会话(:id 动作与播种的维) */
  sessionId: string;
  /** 连接状态机(App 壳单连接透传;composer 门:非 open 禁用) */
  connState: ConnectionState;
  /** 返回首页(App 路由回调;Chat 顶栏「返回首页」) */
  onBack(): void;
  /** App 持有的转投注册面(见 ChatSink) */
  sinkRef: MutableRefObject<ChatSink | null>;
  /** G5 快照落定回调(App 消费 snapshot.team 存态——Board 侧栏;可选防测试桩免配) */
  onSeeded?: (snap: SnapshotResponse) => void;
}

/** 挂起卡(approval/ask 判别联合;pid 为 daemon 级寻址键) */
type PendingCard =
  | { kind: 'approval'; pid: string; req: GuiApprovalReq }
  | { kind: 'ask'; pid: string; req: GuiAskReq };

/** G4 审批卡:三按钮字面即 ApprovalDecision(allow/deny/always)——回执经 HTTP,寻址 pid */
function ApprovalCard({ req, onDecision }: { req: GuiApprovalReq; onDecision: (decision: string) => void }): JSX.Element {
  return (
    <div className="pending-card approval-card">
      <div className="card-title">{`[approval ${req.kind ?? '?'}] ${req.subject ?? '(无标题)'}`}</div>
      {req.reason !== undefined && req.reason !== '' && <div className="card-reason">{req.reason}</div>}
      <div className="card-actions">
        <button type="button" className="approve" onClick={() => onDecision('allow')}>
          Allow
        </button>
        <button type="button" className="deny" onClick={() => onDecision('deny')}>
          Deny
        </button>
        <button type="button" className="always" onClick={() => onDecision('always')}>
          Always
        </button>
      </div>
    </div>
  );
}

/** G4 问询卡:选项单选(缺省)/多选(multiple);customIndex 在场 → 自由输入面(非空优先于勾选
 *  → custom 态);Dismiss 即 dismissed(正常放弃非错误)。空选+空输入 Submit 无动作 */
function AskCard({ req, onSubmit, onDismiss }: { req: GuiAskReq; onSubmit: (answer: GuiAskAnswer) => void; onDismiss: () => void }): JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const multiple = req.multiple === true;
  const allowCustom = req.customIndex !== undefined;

  const toggle = (label: string): void => {
    setSelected((s) =>
      multiple ? (s.includes(label) ? s.filter((l) => l !== label) : [...s, label]) : s.includes(label) ? [] : [label],
    );
  };

  const submit = (): void => {
    const text = custom.trim();
    if (text !== '') {
      onSubmit({ type: 'custom', text });
      return;
    }
    if (selected.length > 0) onSubmit({ type: 'selected', labels: selected });
  };

  return (
    <div className="pending-card ask-card">
      <div className="card-title">{req.question}</div>
      <div className="card-options">
        {req.options.map((o) => (
          <label key={o.label} className="card-option">
            <input type={multiple ? 'checkbox' : 'radio'} name="ask-option" checked={selected.includes(o.label)} onChange={() => toggle(o.label)} />
            <span>
              {o.label}
              {o.description !== undefined && o.description !== '' ? ` — ${o.description}` : ''}
            </span>
          </label>
        ))}
      </div>
      {allowCustom && (
        <input
          aria-label="custom answer"
          className="card-custom"
          value={custom}
          placeholder="Other… 自由输入"
          onChange={(e) => setCustom(e.target.value)}
        />
      )}
      <div className="card-actions">
        <button type="button" className="primary" onClick={submit}>
          Submit
        </button>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
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

export function Chat({ conn, sessionId, connState, onBack, sinkRef, onSeeded }: ChatProps): JSX.Element {
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [input, setInput] = useState('');
  /** G4 挂起卡列表(pid 维:回执落定即移;resetSession/idle 清空) */
  const [cards, setCards] = useState<PendingCard[]>([]);
  /** 播种在途门:基线快照落定前输入禁用——本地 user 回显先于种子落定会被种子整替清掉
   *  (挂载/reset → sessionSnapshot 异步应答),提交必须在权威基线之后 */
  const [seeding, setSeeding] = useState(true);
  /** seeding 的同步镜像:sink.on 闭包经 ref 读(状态更新异步,事件路径须即时判) */
  const seedingRef = useRef(true);
  /** 种子在途窗到达的本会话帧缓冲(reseed 清空重来;unmount 随组件销毁) */
  const pendingRef = useRef<Array<{ e: SessionEvent; seq: number }>>([]);
  /** 播种代次:后继 reseed(在途窗内重连)使先行应答失效 */
  const seedGenRef = useRef(0);
  /** G5 idle 清卡:前次 status 记账(ref 免 effect 重复触发)——仅 running→idle 转换清卡 */
  const prevStatusRef = useRef<ChatState['status'] | null>(null);
  /** onSeeded 的同步镜像(reseed 闭包经 ref 读,装配期固定免依赖数组抖动) */
  const onSeededRef = useRef<((snap: SnapshotResponse) => void) | undefined>(onSeeded);
  onSeededRef.current = onSeeded;

  /** 会话基线重建(挂载与 reset 同路径):清投影 + 缓冲 → sessionSnapshot 播种 → 种子落定后
   *  过滤缓冲(seq ≤ snapshot.lastSeq 丢)依序补投;失败倒 error 条不静默 */
  const reseed = useCallback((): void => {
    const gen = ++seedGenRef.current;
    pendingRef.current = [];
    seedingRef.current = true;
    setChat(initialChatState());
    setSeeding(true);
    conn.sessionSnapshot(sessionId).then(
      (snap) => {
        if (seedGenRef.current !== gen) return; // 后继 reseed 已接管(在途窗内重连)
        let next = seedChatFromSnapshot(snap.messages, snap.status);
        for (const f of pendingRef.current) {
          if (f.seq > snap.lastSeq) next = applyChatEvent(next, f.e); // ≤ 切割序:种子已含,丢(双应用防线)
        }
        pendingRef.current = [];
        seedingRef.current = false;
        setSeeding(false);
        setChat(next);
        onSeededRef.current?.(snap); // G5:App 借快照取 team(每次 reseed 均回填——重播种即更新)
      },
      (err: unknown) => {
        if (seedGenRef.current !== gen) return;
        pendingRef.current = []; // 无基线可滤,弃窗内帧(重连 reset/再开页会全量重放补齐)
        seedingRef.current = false;
        setSeeding(false);
        setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
      },
    );
  }, [conn, sessionId]);

  /** G4 卡增(同 pid 防重挂——连接层已去重,本地二次防线)与移(回执落定即移) */
  const addCard = useCallback((card: PendingCard): void => {
    setCards((cs) => (cs.some((c) => c.pid === card.pid) ? cs : [...cs, card]));
  }, []);
  const removeCard = useCallback((pid: string): void => {
    setCards((cs) => cs.filter((c) => c.pid !== pid));
  }, []);

  /** G4 回执:寻址用帧顶层 pid(T1 契约);成功移卡,失败(404 已决等)也移——不悬挂。
   *  失败面不再倒 error 条:挂起生命周期以 daemon 挂起表为准,本地卡只是其投影 */
  const sendApproval = useCallback(
    (pid: string, decision: string): void => {
      void conn.replyApproval(pid, decision).then(
        () => removeCard(pid),
        () => removeCard(pid),
      );
    },
    [conn, removeCard],
  );
  const sendAsk = useCallback(
    (pid: string, answer: GuiAskAnswer): void => {
      void conn.replyAsk(pid, answer).then(
        () => removeCard(pid),
        () => removeCard(pid),
      );
    },
    [conn, removeCard],
  );

  useEffect(() => {
    const sink: ChatSink = {
      on: (e, seq) => {
        if (seedingRef.current) {
          pendingRef.current.push({ e, seq }); // 种子在途:缓冲不投(直投会被种子整替清掉)
          return;
        }
        setChat((c) => applyChatEvent(c, e));
      },
      reset: () => reseed(),
      onApproval: (pid, req) => addCard({ kind: 'approval', pid, req }),
      onAsk: (pid, req) => addCard({ kind: 'ask', pid, req }),
      resetSession: () => {
        setCards([]); // daemon reset 已 deny/dismissed 回填该会话全部挂起——本地卡随之清
        reseed();
      },
    };
    sinkRef.current = sink;
    reseed();
    return () => {
      sinkRef.current = null;
      pendingRef.current = []; // unmount 清缓冲(组件销毁,无跨会话残留)
    };
  }, [sinkRef, reseed, addCard]);

  const running = chat.status === 'running';

  /** G5 idle 清卡:status 经 running→idle 转换(run 收束——daemon 已对本 run 挂起 deny 回填)
   *  时置空本地卡列表;reseed 落定的 idle 快照亦经此路径(挂起已回填,不重建——见文件头裁定) */
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = chat.status;
    if (prev !== null && prev !== 'idle' && chat.status === 'idle') setCards([]);
  }, [chat.status]);

  /** G5 会话回收(daemon 会话 id 寻址):confirm → deleteSession → onBack 回首页;
   *  失败留在会话示错条(HTTP 409 running 等不静默) */
  const deleteThisSession = (): void => {
    if (!window.confirm(`删除会话 ${sessionId}?此操作不可恢复(journal 档案保留)。`)) return;
    void conn.deleteSession(sessionId).then(
      () => onBack(),
      (err: unknown) => {
        setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
      },
    );
  };

  /** Enter 分流:idle 提交 / running 插话;本地 user 回显(`> text`),失败倒 error 条 */
  const send = (): void => {
    const text = input.trim();
    if (text === '') return;
    setChat((c) => appendUserMessage(c, text));
    setInput('');
    const req = running ? conn.sessionSteer(sessionId, text) : conn.sessionSubmit(sessionId, text);
    void req.catch((err: unknown) => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
    });
  };

  const interrupt = (): void => {
    void conn.sessionInterrupt(sessionId).catch((err: unknown) => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
    });
  };

  return (
    <>
      <header className="chat-topbar">
        <button type="button" className="back" onClick={onBack}>
          ← 返回首页
        </button>
        <span className="session-chip" title="当前会话">
          session {sessionId}
        </span>
        <span className={`status-text status-${chat.status}`}>{chat.status}</span>
        <span className="tokens">{chat.tokens} tokens</span>
        <span className="steps">{chat.steps} steps</span>
        <button type="button" className="delete" onClick={deleteThisSession}>
          Delete
        </button>
      </header>
      {cards.length > 0 && (
        <section className="pending-cards" aria-label="pending approvals and asks">
          {cards.map((c) =>
            c.kind === 'approval' ? (
              <ApprovalCard key={c.pid} req={c.req} onDecision={(d) => sendApproval(c.pid, d)} />
            ) : (
              <AskCard key={c.pid} req={c.req} onSubmit={(a) => sendAsk(c.pid, a)} onDismiss={() => sendAsk(c.pid, { type: 'dismissed' })} />
            ),
          )}
        </section>
      )}
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
  );
}
