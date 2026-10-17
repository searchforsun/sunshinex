import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ListTodo, ShieldCheck, Unlock } from 'lucide-react';
import { initialChatState } from '../chat-reducer';
import type { ChatEntry, ChatState } from '../chat-reducer';
import { ComposerCard } from '../composer/ComposerCard';
import { ComposerPlusPanel } from '../composer/ComposerPlusPanel';
import { CommandPalette } from '../CommandPalette';
import { pathBasename } from '../ui-util';
import type { CmdItem } from '../CommandPalette';
import { t } from '../i18n';

/**
 * T4δ Chat 页(会话维对话面;叙事史与批序全录 docs/superpowers/plans/2026-10-17-chat-split-plan.md
 * 附录——批F-7d 迁出,本注留现役口径):事件经 App 壳 sinkRef 转投,本地 reducer 投影随组件销毁
 * (key={sessionId} 挂载隔离);播种竞态缓冲/挂起卡/队列/命令面板/文件面板/提交路径已分件
 * (pages/chat/* 六渲染件七 hooks),本文件保编排+composer 键链(filePal UI 部第二十轮裁定留置)。
 */

/** App → Chat 事件转投面:Chat 装配期注册到 sinkRef(卸载注销 null)——连接层回调闭包固定,
 *  App 侧经 ref 转投免闭包陈旧 */
import { useCommandPalette } from './chat/use-command-palette';
import { ComposerPillsLeft, ComposerPillsRight } from './chat/ComposerPills';
import { SteerQueue } from './chat/SteerQueue';
import { ChatTopbar } from './chat/ChatTopbar';
import { useChatDerived, runFooterMapOf } from './chat/use-chat-derived';
import { useChatScroll } from './chat/use-chat-scroll';
import { useChatTitle } from './chat/use-chat-title';
import { useChatSessionInfo } from './chat/use-chat-session-info';
import { useChatSubmit } from './chat/use-chat-submit';
import { useChatComposerSide } from './chat/use-chat-composer-side';
import { slashItemsFor } from './chat/use-command-palette';
import { useChatFold } from './chat/use-chat-fold';
import { MessageList } from './chat/MessageList';
import { AskDock } from './chat/AskDock';
import { useSessionEvents } from './chat/use-session-events';
import { ApprovalCard } from './chat/PendingCards';
import { atomicRange, expandFileRefs, fileHit, FilePalette, renderMentionSpans, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './chat/mention';
export { atomicRange, expandFileRefs, fileHit, FilePalette, renderMentionSpans, renderUserMd, splitMentionTokens, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './chat/mention';
export type { MentionToken, TokenGuardVerdict } from './chat/mention';
export { buildMdComponents, buildUserMdComponents, keepUrl, mdComponentsPlain, MermaidBlock } from './chat/md-render';
export { baseModelName, ChatEntryView, CollapsibleBubble, ThinkingEntryView } from './chat/EntryViews';
import type { AskPick } from './chat/PendingCards';
import { useWorkspaceFiles } from './chat/use-workspace-files';
import { useQueue } from './chat/use-queue';
export { ToolEntryView } from './chat/ToolEntry';
export type { TodoBatch } from './chat/ToolEntry';
export type { ChatSink, ChatProps, ToolCallInfo } from './chat/chat-types';
import type { ChatProps, ToolCallInfo } from './chat/chat-types';





/** G14.133 审批模式三档统一图标(pill 与菜单同源——静态 Hand 两套渲染退役):
 *  plan=ListTodo / dontAsk=Unlock / manual=ShieldCheck */
export function ModeIcon({ mode, size = 13 }: { mode: 'dontAsk' | 'manual' | 'plan'; size?: number }): JSX.Element {
  const Icon = mode === 'plan' ? ListTodo : mode === 'manual' ? ShieldCheck : Unlock;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}




/** tokens 格式:共享面迁移 ui-util.fmtTokens(G14.17)——本文件 re-export 保既有引用零迁移 */



/** G14.212 会话滚动位存档(localStorage `sunshinex.chat-scroll`):id → { d: 距底 px, t: 时刻 }。
 *  非贴底(>80px,同贴底判定阈值)才记;贴底离开删档(再进照旧跳底)。内存单例跨 Chat 重挂载
 *  存活(key 换装即读),localStorage 节流落盘(冷却 800ms 直写+尾随写);容量封顶 100(超出丢
 *  最旧),存储满/禁用静默 */
const SCROLL_KEY = 'sunshinex.chat-scroll';
type ScrollMem = Record<string, { d: number; t: number }>;
let scrollMem: ScrollMem | null = null;
let scrollFlushAt = 0;
let scrollFlushTimer: ReturnType<typeof setTimeout> | null = null;
function scrollMemMap(): ScrollMem {
  if (scrollMem !== null) return scrollMem;
  try {
    const raw = localStorage.getItem(SCROLL_KEY);
    const obj = raw === null ? null : (JSON.parse(raw) as ScrollMem);
    scrollMem = obj !== null && typeof obj === 'object' ? obj : {};
  } catch {
    scrollMem = {};
  }
  return scrollMem;
}
function flushScrollMem(): void {
  if (scrollFlushTimer !== null) {
    clearTimeout(scrollFlushTimer);
    scrollFlushTimer = null;
  }
  scrollFlushAt = Date.now();
  if (scrollMem === null) return;
  try {
    const entries = Object.entries(scrollMem)
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, 100);
    localStorage.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 存储满/禁用:静默 */
  }
}
function saveScrollPos(id: string, dist: number): void {
  const m = scrollMemMap();
  if (dist <= 0) delete m[id];
  else m[id] = { d: Math.round(dist), t: Date.now() };
  if (scrollFlushTimer !== null) return;
  if (Date.now() - scrollFlushAt > 800) flushScrollMem();
  else scrollFlushTimer = setTimeout(flushScrollMem, 800);
}
/** 存档读取:仅非贴底位(≤80px 视为贴底语义,回 null 走跳底) */
function peekScrollPos(id: string): number | null {
  const hit = scrollMemMap()[id];
  const out = hit !== undefined && hit.d > 80 ? hit.d : null;
  return out;
}

/** G14.95 slash 面板令牌解析:caret 前 /词。atStart=开头(命令+技能) / 中间(仅技能)。
 *  模块层导出(App 欢迎页 /命令 目标分流复用) */
export const slashTokenAt = (text: string, caret: number): { query: string; from: number; atStart: boolean } | null => {
  const m = /\/([\w-]*)$/.exec(text.slice(0, caret));
  if (m === null) return null;
  return { query: m[1] ?? '', from: m.index, atStart: m.index === 0 };
};

export function Chat({ conn, sessionId, connState, sinkRef, onSeeded, onOpenFile, onOpenDiff, onOpenAgent, onOpenTask, board, onFork, pendingGoal, onPendingGoalDone, root, onRenamed, showExpandSidebar, onExpandSidebar, onSideChat, freshView, fixedTitle, journalId, onTodos, onOpenMemory, initialInsert, onTodoBatches, onTurnGoal, onOpenTab }: ChatProps): JSX.Element {
  const [chat, setChat] = useState<ChatState>(initialChatState);
  /** G14.213 滚动位存档键:journal 档案 id(稳定)优先,缺省回落 sessionId(测试桩/旁路面) */
  const archiveKey = journalId !== undefined && journalId !== '' ? journalId : sessionId;


  const [input, setInput] = useState('');
  /** G10-C4 composer pills:会话权限态 + 模型信息(snapshot 回显,切换即乐观更新) */
  const [sessMode, setSessMode] = useState<'dontAsk' | 'manual' | 'plan'>('dontAsk');
  const [sessEffort, setSessEffort] = useState<string | undefined>(undefined);
  /** pill 开合('plus' = + 附加面板) */
  const [pillOpen, setPillOpen] = useState<'mode' | 'model' | 'plus' | null>(null);
  /** textarea 引用(+ 面板插入收口后焦点回输入框) */
  /** textarea 引用(+ 面板插入收口后焦点回输入框) */
  /** 流区贴底跟随(G13 反馈轮):滚动容器 ref + 「用户是否贴底」旁路 ref——贴底(含初始态)时
   *  每次渲染(流式 token/条目增删)自动归底;用户上翻超阈值即放手,再触底恢复跟随 */
  const chatScrollRef = useRef<HTMLElement | null>(null);
  // G14.212/G14.213 再进恢复上次浏览位:挂载读非贴底存档(距底 px,键=journalId 稳定身份)——
  // 存档位待恢复 + 贴底跟随挂起(stick 初值 false,每渲染归底 effect 让位;恢复后 onScroll 接管)。
  // 贴底离开无存档=照旧跳底
  const scrollRestoreRef = useRef<number | null>(peekScrollPos(archiveKey));
  const chatStickRef = useRef(scrollRestoreRef.current === null);
  /** G14.85 @ 工作区文件选择:文件清单懒加载(BFS 限深限数,跳噪声目录)+触发态 */
  const [filePal, setFilePal] = useState<{ query: string; from: number } | null>(null);
  const [filePalFiles, setFilePalFiles] = useState<string[]>([]);
  const [filePalActive, setFilePalActive] = useState(0);
  // G14.211 @ 面板点外即收:收口此前只有 Esc/改写输入两条路,焦点离开输入框后 Esc 不可达、
  // 点外无处理 = 面板滞留(「无法关闭」直感)。pointerdown 落 composer 卡外即收;面板行在
  // 卡内(overlays 锚卡根),选中点击不受影响
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Element && !e.target.closest('.sx-composer')) setFilePal(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, []);
  /** G14.126 @文件名 记账:选中面板行时 basename → 相对路径(发送期展开解析第一优先) */
  const pickRelRef = useRef(new Map<string, string>());
  /** G14.213 IME 组合中标记:onSelect 归位在组合期跳过(防打断输入法) */
  const composingRef = useRef(false);
  /** 工作区文件索引 hook(D32 批B 数据部):装载/缓存/预热/解析器——记账表注入,pickRelRef 写入面留 UI */
  const { resolveFileRef, loadWorkspaceFiles } = useWorkspaceFiles(conn, sessionId, root, pickRelRef);
  /** 队列面 hook(D32 批B):排队 chips 状态/折叠/refreshQueued/pauseAndSend——会话流可见化与 @ 展开
   *  依赖注入（resolveFileRef 此处已完成声明）；行为零变化（Chat.pause-send.test 为锚） */
  const { queued, setQueued, queueFolded, setQueueFolded, refreshQueued, pauseAndSend } = useQueue(
    conn,
    sessionId,
    root,
    resolveFileRef,
    expandFileRefs,
    setChat,
  );
  const { cmdData, setCmdData, cmdActive, setCmdActive, skillCmds } = useCommandPalette(conn, sessionId);
  /** G14.213 欢迎页接力取用(ref 跳板):事件 hook 的 reseed 闭包经此恒取最新 submitText。
   *  声明前置于事件 hook(deps 求值早于 submitText 定义);赋值仍在其定义处,首帧空档无消费路径 */
  const submitTextRef = useRef<(text: string) => Promise<void>>(() => Promise.resolve());
  /** 会话事件 hook(D32 批C):播种门/种子窗缓冲/挂起卡/事件分流 sink 装配 + G5 idle 清卡——
   *  投影态与队列/pill 设定器注入;行为零变化(Chat.test 为锚) */
  const { toolInputs, cards, seeding, sendApproval, sendAsk } = useSessionEvents({
    conn,
    sessionId,
    sinkRef,
    chat,
    freshView,
    pendingGoal,
    onPendingGoalDone,
    onSeeded,
    onTodos,
    initialInsert,
    setInput,
    setChat,
    setQueued,
    refreshQueued,
    setSessMode,
    setSessEffort,
    submitTextRef,
    flushScrollMem,
  });

  /** 派生投影面(批F-4):任务名/待办批次/关联轮次/动态计数——纯投影收敛 use-chat-derived */
  const { taskNameOf, todoActive, taskActive } = useChatDerived({
    chat,
    toolInputs,
    board,
    onTodoBatches,
    onTurnGoal,
  });
  const runFooterByEntry = runFooterMapOf(chat.entries, chat.status);

  // 滚动四 effects + 轮次折叠簇(批F-5):refs 宿主持有,行为零变化
  const { dockRef } = useChatScroll({
    chatScrollRef,
    chatStickRef,
    scrollRestoreRef,
    seeding,
    entriesLen: chat.entries.length,
  });
  const { collapsedRuns, toggleRun, hiddenKeys, onEntryToggleClick, onEntryOpenDiff, onEntryRestore } = useChatFold({
    chat,
    setChat,
    conn,
    sessionId,
    onOpenDiff,
    chatScrollRef,
    chatStickRef,
  });

  // 标题子系统 + 模型/圆环数据面(批F-6)
  const { titleEditing, setTitleEditing, titleDraft, setTitleDraft, commitTitle, displayTitle } = useChatTitle({
    conn,
    sessionId,
    fixedTitle,
    entries: chat.entries,
    onRenamed,
  });
  const { modelInfo, setModelInfo, ctxInfo, refreshCtx, runCount } = useChatSessionInfo({ conn, sessionId, chat });

  const running = chat.status === 'running';
  /** G14.63 运行状态行「本轮」口径:末个流式 run 的基线差值(会话累计−轮起点);无基线回退累计 */
  /** G14.80 未决问询卡:ask 挂起时输入框变为选择题表单 */
  const askCards = cards.filter((c) => c.kind === 'ask');
  /** G14.91 ask 作答态(dock 级统一提交):pid → {labels, custom};任一题未答不可提交 */
  const [askPicks, setAskPicks] = useState<Record<string, AskPick>>({});
  // 卡组更替(全答提交/跳过/回执移除)即清作答态,防陈旧 pid 累积
  useEffect(() => {
    if (askCards.length === 0) setAskPicks({});
  }, [askCards.length]);
  /** G14.88 审批卡 dock 化:挂起时 dock 变确认框(输入框/队列隐藏),确认后恢复——与 ask 同形 */
  const approvalCards = cards.filter((c) => c.kind === 'approval');
  const lastLiveRun = running
    ? [...chat.entries].reverse().find((e) => e.kind === 'run' && e.streaming === true)
    : undefined;
  const liveSteps = lastLiveRun?.stepsBase !== undefined ? Math.max(0, chat.steps - lastLiveRun.stepsBase) : chat.steps;
  const liveTokens = lastLiveRun?.tokensBase !== undefined ? Math.max(0, chat.tokens - lastLiveRun.tokensBase) : chat.tokens;
  /** G14.74 回到底部钮:非贴底即显(滚动 handler 里置态,值不变时 React 自动跳过重渲染) */
  const [atBottom, setAtBottom] = useState(scrollRestoreRef.current === null); // G14.212 恢复中非贴底:跳底钮即显
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /** G6 工具条目 → input 暂存配对:P4 起 callId 直挂条目(内核条目 input 全量随档,旧 key 编码解码退役) */
  const toolInfoOf = (entry: ChatEntry): ToolCallInfo | undefined => {
    const cid = entry.callId;
    return cid !== undefined && cid.length > 0 ? toolInputs[cid] : undefined;
  };

  /** G7 write 展开的 diff 寻址键:条目 callId 直取(无 callId 面 undefined——不拉 diff,恒单列现内容) */
  const callIdOf = (entry: ChatEntry): string | undefined => {
    const cid = entry.callId;
    return cid !== undefined && cid.length > 0 ? cid : undefined;
  };



  /** pills/+ 面板外点收(面板内点与 + 钮自持——多选文件连续点选不闪收) */
  useEffect(() => {
    if (pillOpen === null) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Element) {
        if (e.target.closest('.sx-plus-panel') !== null || e.target.closest('.composer-plus-btn') !== null) return;
        if (pillOpen !== 'plus' && e.target.closest('.composer-pills') !== null) return;
        setPillOpen(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pillOpen]);

  /** G5 会话回收(daemon 会话 id 寻址):confirm → deleteSession → onBack 回首页;
   *  失败留在会话示错条(HTTP 409 running 等不静默) */

  // 提交路径 §7(批F-7a):hook 返还三件;ref 赋值留此(声明在事件 hook 前,恒取最新)
  const { submitText, send, interrupt } = useChatSubmit({
    conn,
    sessionId,
    running,
    sessMode,
    root,
    resolveFileRef,
    cmdData,
    setChat,
    onSideChat,
    refreshQueued,
    input,
    setInput,
  });
  /** G14.213 欢迎页接力取用(ref 跳板,声明前置于事件 hook):恒取最新 submitText */
  submitTextRef.current = submitText;
  const { onInputClick } = useChatComposerSide({
    pickRelRef,
    inputRef,
    setInput,
    input,
    resolveFileRef,
    onOpenFile,
  });



  /** G14.95 面板项(渲染期,光标位置):/ 令牌 → 面板项;空=面板不开(无匹配自动关) */
  const slashPanelItems: CmdItem[] | null = (() => {
    const caret = inputRef.current?.selectionStart ?? input.length;
    const items = slashItemsFor(cmdData, skillCmds, slashTokenAt(input, caret));
    return items.length > 0 ? items : null;
  })();

  /** G14.95 输入框高亮层:token 着色 spans(与 textarea 同排版) */
  const renderHighlightSpans = (text: string): ReactNode => renderMentionSpans(text);

  /** 流区滚动:贴底跟随置态 + G14.213 容量守卫存档(短会话/mermaid 换渲等瞬时塌陷不记不删——
   *  防塌陷窗内杂散 scroll 把非贴底存档误清;贴底删档/非贴底记距底位) */
  const handleChatScroll = (e: { currentTarget: HTMLElement }): void => {
    const el = e.currentTarget;
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    chatStickRef.current = stick;
    setAtBottom(stick);
    if (el.scrollHeight - el.clientHeight > 80) {
      saveScrollPos(archiveKey, stick ? 0 : el.scrollHeight - el.scrollTop - el.clientHeight);
    }
  };

  return (
    <>
      <ChatTopbar
        fixedTitle={fixedTitle}
        titleEditing={titleEditing}
        titleDraft={titleDraft}
        setTitleDraft={setTitleDraft}
        commitTitle={commitTitle}
        setTitleEditing={setTitleEditing}
        displayTitle={displayTitle}
        sessionId={sessionId}
        tokens={chat.tokens}
        steps={chat.steps}
        running={running}
        todoActive={todoActive}
        taskActive={taskActive}
        conn={conn}
        onOpenTab={onOpenTab}
        showExpandSidebar={showExpandSidebar}
        onExpandSidebar={onExpandSidebar}
      />

      <MessageList
        entries={chat.entries}
        hiddenKeys={hiddenKeys}
        toolInfoOf={toolInfoOf}
        callIdOf={callIdOf}
        conn={conn}
        sessionId={sessionId}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
        onOpenAgent={onOpenAgent}
        onOpenTask={onOpenTask}
        taskNameOf={taskNameOf}
        collapsedRuns={collapsedRuns}
        toggleRun={toggleRun}
        submitText={submitText}
        runFooterByEntry={runFooterByEntry}
        onEntryOpenDiff={onEntryOpenDiff}
        onEntryRestore={onEntryRestore}
        onFork={onFork}
        onEntryToggleClick={onEntryToggleClick}
        chatScrollRef={chatScrollRef}
        onScroll={handleChatScroll}
        running={running}
        liveSteps={liveSteps}
        liveTokens={liveTokens}
      />
      {/* G12 统一输入卡:与欢迎页同一份 ComposerCard(唯一差异:无项目选择条,.composer 只提供
       *  会话语境限宽贴底)。textarea 自增高 rows 随换行 1-6 派生;Enter 提交 / Shift+Enter 换行;
       *  发送/停止共用 32px 圆形实心钮(↑/■,aria-label send/stop 保查询性) */}
      <div className="chat-dock" ref={dockRef}>
        <div className="chat-dock-fade" aria-hidden="true" />
      {/* G14.88 审批挂起时队列条隐藏(dock 整体让位确认框),确认/拒绝后恢复 */}
      {queued.length > 0 && approvalCards.length === 0 && (
        <SteerQueue
          queued={queued}
          queueFolded={queueFolded}
          setQueueFolded={setQueueFolded}
          setQueued={setQueued}
          conn={conn}
          sessionId={sessionId}
          refreshQueued={refreshQueued}
          pauseAndSend={pauseAndSend}
          setInput={setInput}
        />
      )}
        {!atBottom && (
          <button
            type="button"
            className="jump-down"
            aria-label="scroll to bottom"
            title={t('Scroll to bottom', '回到底部')}
            onClick={() => {
              const el = chatScrollRef.current;
              if (el !== null) el.scrollTo({ top: el.scrollHeight }); // G14.74:直接跳底(用户裁定)
            }}
          >
            <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        {approvalCards.length > 0 ? (
          /* G14.88:审批挂起时输入框变为确认框(与 ask 同形)——Allow/Deny/Always 回执后恢复输入框 */
          <div className="ask-dock">
            {approvalCards.map((c) => (
              <ApprovalCard key={c.pid} req={c.req} onDecision={(d) => sendApproval(c.pid, d)} />
            ))}
          </div>
        ) : askCards.length > 0 ? (
          <AskDock askCards={askCards} askPicks={askPicks} setAskPicks={setAskPicks} sendAsk={sendAsk} />
        ) : (
        <ComposerCard
          className="chat-composer"
          label="message input"
        value={input}
        rows={Math.min(6, Math.max(1, (input.match(/\n/g) ?? []).length + 1))}
        placeholder={running ? t('Insert into the running session…', '插入运行中会话…') : t('Give sunshinex a task…', '给 sunshinex 一个任务…')}
        disabled={connState !== 'open' || seeding}
        onChange={(v) => {
          setInput(v);
          // G14.124 面板跟随输入(光标前 @token 即开,裸 @ 也开);无匹配=渲染面自然关闭
          const caret = inputRef.current?.selectionStart ?? v.length;
          const m = /@([\w./:\\-]*)$/.exec(v.slice(0, caret));
          if (m !== null) {
            setFilePal({ query: m[1] ?? '', from: caret - (m[1]?.length ?? 0) - 1 });
            void loadWorkspaceFiles().then((files) => setFilePalFiles(files));
          } else if (filePal !== null) {
            setFilePal(null);
          }
        }}
        onKeyDown={(e) => {
          // G14.212 token 原子性:不可在 token 中间落字(字符键/空格/IME Process)——阻止并把
          // 光标钉到 token 尾,下一击落边界;边界编辑(:L 行锚续写)放行
          if ((e.key.length === 1 || e.key === 'Process') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const taA = e.currentTarget as HTMLTextAreaElement;
            const cs = taA.selectionStart ?? input.length;
            const ce = taA.selectionEnd ?? cs;
            const [as, ae] = atomicRange(input, cs, ce);
            if (as !== cs || ae !== ce) {
              e.preventDefault();
              taA.setSelectionRange(ae, ae);
              return;
            }
          }
          // G14.213 ←/→ 单击跨整个 token(尾→头 / 头→尾,不逐字走进中间);有选区时原生移动
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const taA = e.currentTarget as HTMLTextAreaElement;
            const c = taA.selectionStart ?? 0;
            const ce = taA.selectionEnd ?? c;
            if (c === ce) {
              const dir = e.key === 'ArrowLeft' ? -1 : 1;
              const nc = c + dir;
              if (nc >= 0 && nc <= taA.value.length) {
                const span = tokenSpanAt(taA.value, nc);
                if (span !== null) {
                  e.preventDefault();
                  const to = dir < 0 ? span[0] : span[1];
                  taA.setSelectionRange(to, to);
                }
              }
            }
          }
          if (e.key !== 'Process' && e.nativeEvent.isComposing !== true) composingRef.current = false; // 组合结束兜底复位(合成事件无 isComposing,取原生)
          // G14.148 /memory(-rm) 精确输入 + Enter → 开记忆标签(不进面板补全循环/命令通道;
          // TUI 交互多选在 GUI 的同位=记忆标签的勾选删除面)
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && /^\/memory(-rm)?\s*$/.test(input)) {
            e.preventDefault();
            setInput('');
            onOpenMemory?.();
            return;
          }
          // G14.156 @/技能 token 整体删除:无选区时 token 内 Backspace/Delete 整删不逐字符
          if (e.key === 'Backspace' || e.key === 'Delete') {
            const ta = e.currentTarget as HTMLTextAreaElement;
            const caret = ta.selectionStart ?? input.length;
            if (ta.selectionStart === ta.selectionEnd) {
              const range = tokenDeleteRange(input, caret, e.key);
              if (range !== null) {
                e.preventDefault();
                const [s, e2] = range;
                setInput((prev) => prev.slice(0, s) + prev.slice(e2));
                requestAnimationFrame(() => { inputRef.current?.setSelectionRange(s, s); });
                return;
              }
            }
          }
          // G14.85 @ 工作区文件选择:光标前 @token → 文件面板(方向循环/Enter 选中/Esc 关闭)
          // G14.121 token 兼容绝对路径(:\ /);选中插入绝对路径(底层索引统一绝对路径口径)
          // G14.211 面板活性=锚点仍在(input[filePal.from]==='@'):键面 preventDefault 直改
          // 输入(token 整删等)不触发 onChange,残锚面板在此收口——否则空输入仍按残 query
          // 命中旧文件,面板滞留且 Enter 可幽灵插入
          const taEl = e.currentTarget as HTMLTextAreaElement;
          const caret = taEl.selectionStart ?? input.length;
          const atMatch = /@([\w./:\\-]*)$/.exec(input.slice(0, caret));
          if (atMatch !== null) {
            setFilePal({ query: atMatch[1] ?? '', from: caret - (atMatch[1]?.length ?? 0) - 1 });
            void loadWorkspaceFiles().then((files) => setFilePalFiles(files));
          } else if (filePal !== null && input[filePal.from] !== '@') {
            setFilePal(null);
          }
          if (atMatch !== null || (filePal !== null && input[filePal.from] === '@')) {
            const items = filePalFiles.filter((f) => fileHit(f, filePal?.query ?? '')).slice(0, 12);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (items.length > 0) {
                setFilePalActive((a) => (e.key === 'ArrowDown' ? (a + 1) % items.length : (a - 1 + items.length) % items.length));
                setFilePal((fp) => fp ?? { query: '', from: 0 });
              }
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setFilePal(null);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && items.length > 0) {
              e.preventDefault();
              const rel = items[Math.min(filePalActive, items.length - 1)];
              // G14.126 选中只插短写 @文件名(输入框显形=图标+文件名);相对路径记入账本,
              // 发送期 expandFileRefs 据此展开为 md 绝对链接;按 @token 区间替换
              const base = pathBasename(rel);
              pickRelRef.current.set(base, rel);
              const atFrom = filePal?.from ?? caret - (atMatch?.[1]?.length ?? 0) - 1;
              const atEnd = atFrom + 1 + (filePal?.query ?? '').length;
              setInput((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
              setFilePal(null);
              return;
            }
          }
          // G14.95 / 面板:开头=命令+技能;中间=仅技能;无匹配(items 空)面板不开=自动关
          const slashToken = atMatch === null ? slashTokenAt(input, caret) : null;
          const slashItems = slashItemsFor(cmdData, skillCmds, slashToken);
          if (slashToken !== null && slashItems.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setCmdActive((a) => (e.key === 'ArrowDown' ? (a + 1) % slashItems.length : (a - 1 + slashItems.length) % slashItems.length));
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setCmdData(null); // 本次收起(重开输入 / 即回)
              return;
            }
            if (e.key === 'Tab') {
              e.preventDefault();
              const item = slashItems[cmdActive];
              if (item !== undefined) setInput((prev) => prev.slice(0, slashToken.from) + item.cmd + ' ' + prev.slice(caret));
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              const item: CmdItem | undefined = slashItems[cmdActive];
              // G14.213 命令项+参数已敲:整行直跑(supported 判定在清单);skill 项不在此列——
              // 落底部纯文本发送(daemon 已 400,skills 普通文本语义)
              if (item !== undefined && item.kind === 'cmd' && input.includes(' ') && item.ok && slashToken.atStart) {
                e.preventDefault();
                setInput('');
                conn.runCommand(sessionId, input).catch(() => {});
                return;
              }
              // 补全仅当 / 词尚未敲完(无参数);skill 项参数已敲同样落底部纯文本发送
              if (item !== undefined && !input.includes(' ')) {
                e.preventDefault();
                setInput((prev) => prev.slice(0, slashToken.from) + item.cmd + ' ' + prev.slice(caret)); // 补全,面板续开收参数
                return;
              }
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault(); // 提交不分流换行进内容面(受控清空,防闪换行)
            send();
          }
        }}
        onBeforeInput={(e) => {
          // G14.212 token 原子性兜底面:键入/IME/粘贴/拖放的 beforeinput 部分命中 token 即拦
          // (插入=光标钉 token 尾;删除=扩整删)——keydown 网之外的编辑面在此收口
          const ev = e.nativeEvent as InputEvent;
          const ta = e.currentTarget;
          const s = ta.selectionStart ?? 0;
          const en = ta.selectionEnd ?? 0;
          const v = tokenGuardVerdict(input, s, en, ev.inputType ?? '');
          if (v.action === 'redirectEnd') {
            e.preventDefault();
            ta.setSelectionRange(v.to, v.to);
          } else if (v.action === 'splice') {
            e.preventDefault();
            setInput((prev) => prev.slice(0, v.s) + prev.slice(v.e));
            requestAnimationFrame(() => ta.setSelectionRange(v.s, v.s));
          }
        }}
        onPasteGuard={(e) => {
          const ta = e.currentTarget;
          const s = ta.selectionStart ?? 0;
          const en = ta.selectionEnd ?? 0;
          const [as, ae] = atomicRange(input, s, en);
          if (as !== s || ae !== en) {
            e.preventDefault();
            ta.setSelectionRange(ae, ae);
          }
        }}
        onCompositionGuard={(e) => {
          composingRef.current = true; // G14.213 组合中:onSelect 归位跳过
          const ta = e.currentTarget;
          const s = ta.selectionStart ?? 0;
          const en = ta.selectionEnd ?? 0;
          const [as, ae] = atomicRange(input, s, en);
          if (as !== s || ae !== en) e.preventDefault();
        }}
        onCompositionEndGuard={() => {
          composingRef.current = false;
        }}
        onSelectGuard={() => {
          // G14.213 光标不落 token 中间:↑↓/Home/End 等原生移动后的兜底归位(钉 token 尾;
          // ←→ 在 keydown 已跨 token);IME 组合中跳过防打断
          if (composingRef.current) return;
          const ta = inputRef.current;
          if (ta === null) return;
          const s = ta.selectionStart ?? 0;
          const en = ta.selectionEnd ?? 0;
          if (s !== en) return;
          const span = tokenSpanAt(ta.value, s);
          if (span !== null) ta.setSelectionRange(span[1], span[1]);
        }}
        overlays={
          // G14.121 @ 文件面板(此前数据链在而渲染面缺失——@ 弹窗从未出现的根因):命中才渲染;
          // G14.211 锚点校验:@ 已被整删/程序化改写后 filePal 残留,锚位不再是 '@' 即不渲染
          filePal !== null && input[filePal.from] === '@' && filePalFiles.some((f) => fileHit(f, filePal.query)) ? (
            <FilePalette
              items={filePalFiles.filter((f) => fileHit(f, filePal.query)).slice(0, 12)}
              active={Math.min(filePalActive, 11)}
              onHover={setFilePalActive}
              onPick={(p) => {
                // G14.126 选中只插短写 @文件名,相对路径记入账本(发送期展开)
                const base = pathBasename(p);
                pickRelRef.current.set(base, p);
                const atFrom = filePal.from;
                const atEnd = atFrom + 1 + filePal.query.length;
                setInput((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
                setFilePal(null);
                inputRef.current?.focus();
                // G14.211 光标钉在插入 token 之后(@+名+空格右沿):面板行点击前 textarea 的
                // 旧光标位在 @query 内,focus 恢复旧位=落回 token 中间
                requestAnimationFrame(() => {
                  const ta = inputRef.current;
                  if (ta === null) return;
                  const to = Math.min(atFrom + base.length + 2, ta.value.length);
                  ta.setSelectionRange(to, to);
                });
              }}
            />
          ) : pillOpen === 'plus' ? (
            <ComposerPlusPanel
              conn={conn}
              sessionId={sessionId}
              root={root}
              onInsert={(text) => {
                setInput((v) => (v.trim() === '' ? text : `${v.replace(/\s+$/, '')} ${text}`));
                setPillOpen(null);
                inputRef.current?.focus();
              }}
            />
          ) : slashPanelItems !== null ? (
            (() => {
              const items = slashPanelItems;
              const active = Math.min(cmdActive, Math.max(0, items.length - 1));
              const pick = (item: CmdItem): void => {
                if (!item.ok) return;
                const tok = slashTokenAt(input, input.length);
                const from = tok !== null ? tok.from : input.length;
                const caret = inputRef.current?.selectionStart ?? input.length;
                setInput(input.slice(0, from) + item.cmd + ' ' + input.slice(caret));
              };
              return <CommandPalette items={items} active={active} onHover={setCmdActive} onPick={pick} />;
            })()
          ) : null
        }
        inputRef={inputRef}
        highlight={renderHighlightSpans(input)}
        onInputClick={onInputClick}
        onDropFile={(rel) => {
          // G14.144 拖入文件 → caret 处插 @文件名(短写,账本解析;G14.211 原 @全相对路径过长)
          const ta = inputRef.current;
          const pos = ta?.selectionStart ?? input.length;
          const base = rel.split(/[\\/]/).pop() ?? rel;
          pickRelRef.current.set(base, rel);
          setInput((prev) => prev.slice(0, pos) + `@${base} ` + prev.slice(pos));
          inputRef.current?.focus();
          // G14.211 光标钉在插入 token 之后(同 onPick:旧光标位恢复=token 中间)
          requestAnimationFrame(() => {
            const ta2 = inputRef.current;
            if (ta2 === null) return;
            const to = Math.min(pos + base.length + 2, ta2.value.length);
            ta2.setSelectionRange(to, to);
          });
        }}
        footLeft={
          <ComposerPillsLeft
            pillOpen={pillOpen}
            setPillOpen={setPillOpen}
            sessMode={sessMode}
            setSessMode={setSessMode}
            conn={conn}
            sessionId={sessionId}
          />
        }
        footRight={
          <ComposerPillsRight
            pillOpen={pillOpen}
            setPillOpen={setPillOpen}
            conn={conn}
            sessionId={sessionId}
            ctxInfo={ctxInfo}
            refreshCtx={refreshCtx}
            runCount={runCount}
            steps={chat.steps}
            tokens={chat.tokens}
            cacheTokens={chat.cacheTokens}
            modelInfo={modelInfo}
            setModelInfo={setModelInfo}
            sessEffort={sessEffort}
            setSessEffort={setSessEffort}
            running={running}
            input={input}
            send={send}
            interrupt={interrupt}
            connState={connState}
            seeding={seeding}
          />
        }
        />
        )
        }
      </div>
    </>
  );
}
