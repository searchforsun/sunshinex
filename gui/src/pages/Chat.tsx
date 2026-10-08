import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft, ArrowUp, Bot, Brain, ChevronDown, Copy, FileText, FolderSearch, GitBranch, Globe,
  ListTodo, MoreHorizontal, PenLine, Search, Sparkles, Square, Terminal, Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { applyChatEvent, appendUserMessage, initialChatState, seedChatFromSnapshot } from '../chat-reducer';
import type { ChatEntry, ChatState } from '../chat-reducer';
import { groupEntriesByDay } from '../chat-groups';
import { DiffPanel } from '../diff-panel';
import type { Connection, ConnectionState, DiffResp, GuiApprovalReq, GuiAskAnswer, GuiAskReq, SnapshotResponse } from '../connection';
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
 * 清;reseed 后快照 status=idle 亦触发);③onSeeded(快照落定回调,App 借此取 snapshot.team
 * 存 App 态——事件流无 teammate 面,Board 侧栏的唯一来源)。
 * G7 增三面:①reseed 挂起卡重建——snapshot.pending 逐项 addCard({pid,kind,req})(req 透传
 * 落地,刷新/重连后卡内容可恢复;连接层 pid 去重拦了 daemon 重发帧,快照是唯一来源);②reseed
 * 时 toolInputs 清(旧投影 callId 配对残留不污染新投影);③write 条目展开接 conn.fetchDiff
 * (old/new 双列;404/失败退单列现内容)。unmount cleanup 增 seedGenRef++(G6 终审首优先):
 * 在途快照应答经 gen 失配早退,防陈旧 onSeeded 污染 App 态。
 * G8d T5 交互清单:①输入面 textarea 自增高(rows 随换行数 1-6 派生;Enter 提交 preventDefault,
 * Shift+Enter 换行走默认);②流式条末挂 span.sx-stream-cursor(闪灭动画在 app.css 特批小段);
 * ③状态条 tokens/steps 改图标+数字组(sx-stat 组类名+lucide Coins/Footprints,样式面归 G8e)。
 * G9 B3b(spec docs/superpowers/specs/2026-10-08-codex-desktop-1to1-design.md §3):用户条目
 * UserEntryView(memo)右对齐胶囊+hover 浮现复制(剥 `> ` 前缀写剪贴板,失败 1.5s 示「未复制」);
 * 条目按日分组(groupEntriesByDay 纯投影)跨日插居中日期分隔——每日组顶部一条,与 Codex 实机同形。
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
  /** G6 write 工具 path 按钮回调(App 切 Files tab 并带 initialPath;可选防测试桩免配)。G8d 起
   *  降为回退通道:callId 在场的 write 条目优先走 onOpenDiff(开 diff 标签),callId 缺场(种子
   *  条/无 callId 面)仍开文件标签预览 */
  onOpenFile?: (path: string) => void;
  /** G8d write 条目 path 钮主通道:开 diff 标签(callId 寻址,App 接 openTabInSession('diff',
   *  {callId,path}));可选防测试桩免配——缺场时全部回落 onOpenFile */
  onOpenDiff?: (callId: string, path: string) => void;
}

/** 挂起卡(approval/ask 判别联合;pid 为 daemon 级寻址键) */
type PendingCard =
  | { kind: 'approval'; pid: string; req: GuiApprovalReq }
  | { kind: 'ask'; pid: string; req: GuiAskReq };

/** G6 工具条目结构面:tool-call 帧 payload.input 的本地暂存（chat-reducer 的 ChatEntry 只存 md
 *  两行文本,diff 展开需 input 原文——本组件 sink.on 面旁路暂存,按 callId 寻址配对条目 key） */
interface ToolCallInfo {
  /** 工具规范名（事件 text——batch-runner emit 首参,如 'write'/'read'） */
  name: string;
  /** 调用入参原对象（payload.input;write 形态 {path, content} 现场核 builtin.ts） */
  input: Record<string, unknown>;
}

/** 工具条 md(`● verb\n⎿ result`)的渲染侧只读拆解——与 chat-reducer 内部同形约定,不入其模块 */
function verbOf(md: string): string {
  const nl = md.indexOf('\n');
  return md.startsWith('● ') && nl > 2 ? md.slice(2, nl) : md;
}

function resultOf(md: string): string {
  const m = md.indexOf('⎿ ');
  return m >= 0 ? md.slice(m + 2) : '';
}

/** G6 工具条目(折叠态一行/点击展开):write 工具(name==='write',call 名判定——事件 text 即
 *  注册名)展开接 G7 fetchDiff(oldStr=oldContent/newStr=newContent 双列;加载期先示右列现内容
 *  +加载标,404/失败退单列现内容——快照种子条/无 callId 面恒单列)+ path 文本按钮(G8d 起
 *  callId 在场优先 onOpenDiff 开 diff 标签,缺场回落 onOpenFile 文件标签预览);其他工具展开
 *  result 摘要行。折叠行 `● verb [path] [⎿ result]`——verb 行与 result 行并作一行(md 两行
 *  的折叠视图)。 */
function ToolEntryView({
  entry,
  info,
  conn,
  sessionId,
  callId,
  onOpenFile,
  onOpenDiff,
}: {
  entry: ChatEntry;
  info?: ToolCallInfo;
  conn: Connection;
  sessionId: string;
  callId?: string;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (callId: string, path: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  /** G7 diff 拉取态:undefined=未拉/在途(null 前先示右列现内容);null=拉取失败(退单列现内容);
   *  对象=成功(DiffPanel 双列)。拉一次缓存——折叠再展开不重拉 */
  const [diff, setDiff] = useState<DiffResp | null | undefined>(undefined);
  const verb = verbOf(entry.md);
  const result = resultOf(entry.md);
  const target = info !== undefined && typeof info.input.path === 'string' ? info.input.path : undefined;
  const isWrite = info !== undefined && info.name === 'write' && target !== undefined;
  const fallbackNew = info !== undefined && typeof info.input.content === 'string' ? info.input.content : '';

  /** 展开且可寻址(callId 在场——种子条/无 callId 面不拉)即异步拉 diff;折叠即弃在途应答
   *  (面板已不在场),重展开重拉;已缓存(diff≠undefined)不重拉 */
  useEffect(() => {
    if (!expanded || isWrite !== true || callId === undefined || diff !== undefined) return;
    let alive = true;
    conn.fetchDiff(sessionId, callId).then(
      (d) => {
        if (alive) setDiff(d);
      },
      () => {
        if (alive) setDiff(null); // 404 无快照/会话已回收等——退单列现内容
      },
    );
    return () => {
      alive = false;
    };
  }, [expanded, isWrite, callId, diff, conn, sessionId]);

  return (
    <div className={`entry entry-tool${expanded ? ' tool-expanded' : ''}`}>
      <button type="button" className="tool-summary" onClick={() => setExpanded((v) => !v)}>
        <ToolIcon verb={verb} />
        <span className="tool-verb">{target !== undefined ? `${verb} ${target}` : verb}</span>
        {result !== '' && <span className="tool-result-inline"> · {result}</span>}
      </button>
      {expanded &&
        (isWrite && info !== undefined ? (
          <div className="tool-detail">
            {(onOpenDiff !== undefined || onOpenFile !== undefined) && (
              // G8d:callId 在场优先开 diff 标签(双列/判重经 registry);缺场(种子条/无 callId 面)
              // 回落 onOpenFile 文件标签预览——title 同步分流提示
              <button
                type="button"
                className="tool-path"
                title={onOpenDiff !== undefined && callId !== undefined ? '打开 diff 标签' : '在文件标签预览'}
                onClick={() => {
                  if (onOpenDiff !== undefined && callId !== undefined) onOpenDiff(callId, target!);
                  else onOpenFile?.(target!);
                }}
              >
                {target}
              </button>
            )}
            {diff !== undefined && diff !== null ? (
              <DiffPanel oldStr={diff.oldContent} newStr={diff.newContent} />
            ) : diff === null ? (
              <DiffPanel newStr={fallbackNew} />
            ) : (
              <>
                <div className="diff-loading" role="status">
                  diff 加载中…
                </div>
                <DiffPanel newStr={fallbackNew} />
              </>
            )}
          </div>
        ) : (
          <pre className="tool-result">{result !== '' ? result : '(无结果)'}</pre>
        ))}
    </div>
  );
}

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

/** 工具动词 → 图标(渲染面映射;md 形态不变,未知工具通用件) */
const TOOL_ICONS: Record<string, LucideIcon> = {
  read: FileText, write: PenLine, exec: Terminal, grep: Search, glob: FolderSearch,
  skill: Sparkles, webfetch: Globe, websearch: Globe, memory: Brain, todo_write: ListTodo,
  worktree: GitBranch, spawn: Bot, task_stop: Square, task_wait: ListTodo,
};
function ToolIcon({ verb }: { verb: string }): JSX.Element {
  const Icon = TOOL_ICONS[verb] ?? Wrench;
  return <Icon size={12} strokeWidth={1.75} aria-hidden="true" />;
}

/** 思考链折叠行(G10-C3,Codex「Thought for Ns」同形):收起=「思考 Ns/思考中…」,展开=思考文本井 */
const ThinkingEntryView = memo(function ThinkingEntryView({ entry }: { entry: ChatEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="entry entry-thinking">
      <button type="button" className="thinking-summary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronDown
          size={12}
          strokeWidth={1.75}
          aria-hidden="true"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform var(--dur-basic) var(--ease-enter)' }}
        />
        {entry.streaming === true ? '思考中…' : entry.seconds !== undefined ? `思考 ${entry.seconds}s` : '思考'}
      </button>
      {open && <pre className="thinking-detail">{entry.md}</pre>}
    </div>
  );
});

/** 用户条目(Codex 形,G9 spec §3.1):右对齐胶囊(前景 5%/8% 底)+ 下方 hover 浮现复制钮;
 *  Edit 钮不做(无会话回退功能,spec §0 非目标)。md 的 `> ` 引用形态在胶囊内平铺(CSS 收平)。
 *  复制失败(权限等)钮 1.5s 示「未复制」tertiary 态,不弹错。memo 同 ChatEntryView——流式帧
 *  只重渲染流式条(未包 memo 时每帧带动 user 条 md 重渲染,计数回归被击穿)。 */
const UserEntryView = memo(function UserEntryView({ entry }: { entry: ChatEntry }): JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = (): void => {
    const text = entry.md.replace(/^> ?/gm, '');
    navigator.clipboard?.writeText(text).then(
      () => setCopied('ok'),
      () => setCopied('fail'),
    );
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied('idle'), 1500);
  };
  return (
    <div className="entry entry-user">
      <div className="user-bubble">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.md}</ReactMarkdown>
      </div>
      <div className="user-actions">
        <button type="button" className="user-action" title={copied === 'fail' ? '未复制' : copied === 'ok' ? '已复制' : '复制'} onClick={copy}>
          <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
          {copied === 'ok' ? '已复制' : copied === 'fail' ? '未复制' : '复制'}
        </button>
      </div>
    </div>
  );
});

/** 单条渲染单元(React.memo):reducer 保未动条目引用——流式 token 帧只有流式条重渲染(md 解析 O(1) 摊销)。
 *  G8d T5:streaming 条末挂流式光标 span.sx-stream-cursor(闪灭动画定义在 app.css 特批小段;done 收段
 *  条 streaming=false → 光标随 memo 重渲染退场) */
const ChatEntryView = memo(function ChatEntryView({ entry }: { entry: ChatEntry }): JSX.Element {
  return (
    <div className={`entry entry-${entry.kind}${entry.streaming === true ? ' streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.md}</ReactMarkdown>
      {entry.streaming === true && <span className="sx-stream-cursor" aria-hidden="true" />}
    </div>
  );
});

export function Chat({ conn, sessionId, connState, onBack, sinkRef, onSeeded, onOpenFile, onOpenDiff }: ChatProps): JSX.Element {
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [input, setInput] = useState('');
  /** G6 工具条 input 暂存(callId → {name, input}):diff 展开面的数据源——sink.on 旁路暂存
   *  (reducer 的 md 两行不含 input 原文);播种窗内缓冲帧同样暂存(缓冲补投创建的条目可配对) */
  const [toolInputs, setToolInputs] = useState<Record<string, ToolCallInfo>>({});
  /** G4 挂起卡列表(pid 维:回执落定即移;resetSession/idle 清空) */
  const [cards, setCards] = useState<PendingCard[]>([]);
  /** 顶栏 ⋯ 菜单开合(G10-C3;外点收) */
  const [moreOpen, setMoreOpen] = useState(false);
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

  /** G4 卡增(同 pid 防重挂——连接层已去重,本地二次防线;G7 reseed 重建复用)与移(回执落定即移) */
  const addCard = useCallback((card: PendingCard): void => {
    setCards((cs) => (cs.some((c) => c.pid === card.pid) ? cs : [...cs, card]));
  }, []);
  const removeCard = useCallback((pid: string): void => {
    setCards((cs) => cs.filter((c) => c.pid !== pid));
  }, []);

  /** 会话基线重建(挂载与 reset 同路径):清投影 + 缓冲 + G7 工具 input 暂存(旧投影的 callId 配对
   *  残留会污染新投影——reseed 后 tool:#/种子条不该再配到旧 input)→ sessionSnapshot 播种 → 种子
   *  落定后过滤缓冲(seq ≤ snapshot.lastSeq 丢)依序补投 + G7 挂起卡重建(snapshot.pending 逐项——
   *  连接层 pid 去重拦了 daemon 重发帧,快照是重连/刷新后卡内容的唯一来源;addCard pid 防重,实时
   *  挂起帧已挂的卡不重挂);失败倒 error 条不静默 */
  const reseed = useCallback((): void => {
    const gen = ++seedGenRef.current;
    pendingRef.current = [];
    seedingRef.current = true;
    // idle 清卡跳过 reseed 瞬态:initialChatState 的 running→idle 回摆不是真转换——若不豁免,
    // 重连时运行中挂起卡被瞬态清掉,而 daemon 重发被连接层 pid 去重拦下 → 卡永久丢(G4 不变式)
    prevStatusRef.current = null;
    setChat(initialChatState());
    setToolInputs({});
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
        // G7 挂起卡重建:快照 pending 段逐项(挂起中=status running,reseed 瞬态豁免保卡不误清)
        for (const row of snap.pending ?? []) {
          if (typeof row?.pid !== 'string' || row.pid.length === 0) continue;
          if (row.kind === 'approval') addCard({ kind: 'approval', pid: row.pid, req: (row.req ?? {}) as GuiApprovalReq });
          else if (row.kind === 'ask') addCard({ kind: 'ask', pid: row.pid, req: (row.req ?? {}) as GuiAskReq });
        }
      },
      (err: unknown) => {
        if (seedGenRef.current !== gen) return;
        pendingRef.current = []; // 无基线可滤,弃窗内帧(重连 reset/再开页会全量重放补齐)
        seedingRef.current = false;
        setSeeding(false);
        setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
      },
    );
  }, [conn, sessionId, addCard]);

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
        // G6 工具条 input 暂存:tool-call 帧的 payload.input 旁路存留(先于播种门——缓冲窗内
        // 到达的帧同样暂存,种子落定后补投创建的条目按 callId 可配对)
        if (e.type === 'tool-call') {
          const cid = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
          if (cid !== '') {
            const raw = e.payload?.input;
            const input = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
            setToolInputs((m) => ({ ...m, [cid]: { name: e.text ?? '', input } }));
          }
        }
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
      seedGenRef.current++; // G6 终审首优先(G7 落地):在途快照应答的 then 回调经 gen 失配早退——
      // 防 backHome→重开窗口内陈旧会话快照经 onSeeded 污染 App 态(team/board——旧板落新壳)
    };
  }, [sinkRef, reseed, addCard]);

  const running = chat.status === 'running';

  /** G6 工具条目 → input 暂存配对:条目 key `tool:<callId>`(重复 callId 的 `~n` 后缀剥掉;
   *  `tool:#`(无 callId 面)与播种条(`s<seq>`)不配对——快照 md 无 input,展开退 result 摘要) */
  const toolInfoOf = (entry: ChatEntry): ToolCallInfo | undefined => {
    if (!entry.key.startsWith('tool:') || entry.key.startsWith('tool:#')) return undefined;
    const cid = (entry.key.slice('tool:'.length).split('~')[0]) ?? '';
    return cid.length > 0 ? toolInputs[cid] : undefined;
  };

  /** G7 write 展开的 diff 寻址键:条目 key 同 toolInfoOf 的剥法(`tool:` 前缀 + `~n` 后缀;
   *  种子条/无 callId 面 undefined——不拉 diff,恒单列现内容) */
  const callIdOf = (entry: ChatEntry): string | undefined => {
    if (!entry.key.startsWith('tool:') || entry.key.startsWith('tool:#')) return undefined;
    const cid = (entry.key.slice('tool:'.length).split('~')[0]) ?? '';
    return cid.length > 0 ? cid : undefined;
  };

  /** G5 idle 清卡:status 经 running→idle 转换(run 收束——daemon 已对本 run 挂起 deny 回填)
   *  时置空本地卡列表;reseed 落定的 idle 快照亦经此路径(挂起已回填,不重建——见文件头裁定) */
  useEffect(() => {
    if (moreOpen === false) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('.chat-more-pop') === null && e.target.closest('.chat-more') === null) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [moreOpen]);

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
        <button type="button" className="back" aria-label="back" title="返回首页" onClick={onBack}>
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <span
          className="chat-title"
          title={`${sessionId} · ${chat.tokens} tokens · ${chat.steps} steps${running ? ' · 运行中' : ''}`}
        >
          {sessionId}
          {running && <span className="sx-session-dot running" aria-label="running" />}
        </span>
        <button
          type="button"
          className="chat-more sx-iconbtn"
          aria-label="chat actions"
          title="会话操作"
          onClick={() => setMoreOpen((v) => !v)}
        >
          <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {moreOpen && (
          <div className="sx-menu-pop chat-more-pop" role="menu" aria-label="chat actions menu">
            <button
              type="button"
              role="menuitem"
              className="sx-menuitem chat-more-delete"
              onClick={() => {
                setMoreOpen(false);
                deleteThisSession();
              }}
            >
              删除会话
            </button>
          </div>
        )}
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
        {chat.entries.length === 0 && (
          <div className="chat-empty" aria-label="chat empty">
            <div className="chat-empty-title">给 sunshinex 一个任务</div>
            <div className="chat-empty-hint">描述目标即可:模型流式作答,工具实时执行,写操作需审批</div>
          </div>
        )}
        {/* 会话流按日分组:跨日插居中日期分隔(纯投影 groupEntriesByDay;无 ts 头组无标不渲染) */}
        {groupEntriesByDay(chat.entries).flatMap((g) => [
          g.label !== '' ? (
            <div key={`day:${g.key}`} className="chat-day-sep" role="separator" aria-label={g.label}>
              {g.label}
            </div>
          ) : null,
          ...g.entries.map((entry) =>
            entry.kind === 'tool' ? (
              <ToolEntryView
                key={entry.key}
                entry={entry}
                info={toolInfoOf(entry)}
                conn={conn}
                sessionId={sessionId}
                callId={callIdOf(entry)}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
              />
            ) : entry.kind === 'user' ? (
              <UserEntryView key={entry.key} entry={entry} />
            ) : entry.kind === 'thinking' ? (
              <ThinkingEntryView key={entry.key} entry={entry} />
            ) : (
              <ChatEntryView key={entry.key} entry={entry} />
            ),
          ),
        ])}
      </main>
      <footer className="composer">
        {/* G8d T5 输入面 textarea 自增高:rows 随内容换行数 1-6 派生(state 单源,清空/提交自然回 1);
         *  Enter 提交 / Shift+Enter 换行(不 preventDefault——换行是 textarea 默认行为)。
         *  G9-B4(spec §4):浮卡容器(elevated 面+三层海拔+22px 超椭圆渐进)在 CSS;此处只分结构
         *  (textarea + composer-foot)并把发送/停止改 28px 圆形实心钮(↑/■ 图标,aria-label
         *  send/stop 保查询性)——权限/模型 pill 无功能对应物不做(spec §0 复刻纪律)。 */}
        <textarea
          aria-label="message input"
          className="message-input"
          value={input}
          rows={Math.min(6, Math.max(1, (input.match(/\n/g) ?? []).length + 1))}
          placeholder={running ? '插入运行中会话…' : '给 sunshinex 一个任务…'}
          disabled={connState !== 'open' || seeding}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault(); // 提交不分流换行进内容面(受控清空,防闪换行)
              send();
            }
          }}
        />
        <div className="composer-foot">
          {running ? (
            <button type="button" className="send" aria-label="stop" title="停止" onClick={interrupt}>
              <Square size={12} strokeWidth={2.5} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              aria-label="send"
              title="发送"
              onClick={send}
              disabled={connState !== 'open' || seeding}
            >
              <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
            </button>
          )}
        </div>
      </footer>
    </>
  );
}
