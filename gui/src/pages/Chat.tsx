import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { SESSION_KIND_SUNX } from '../connection';
import type { ReactNode } from 'react';
import { Eye, NotebookPen, ShieldCheck, Unlock } from 'lucide-react';
import { ImageLightbox } from '../ImageLightbox';
import { initialChatState } from '../chat-reducer';
import type { ChatEntry, ChatState } from '../chat-reducer';
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
import { TerminalDock } from '../tabs/terminal-dock';
import { ChatTopbar } from './chat/ChatTopbar';
import { useChatDerived, runFooterMapOfStable } from './chat/use-chat-derived';
import { flushScrollMem, peekScrollPos, saveScrollPos } from './chat/scroll-mem';
import { isProgBottom, markProgBottom, syncOverflowAnchor, useChatScroll } from './chat/use-chat-scroll';
import { useChatTitle } from './chat/use-chat-title';
import { useChatSessionInfo } from './chat/use-chat-session-info';
import { useChatSubmit } from './chat/use-chat-submit';
import { useChatComposerSide } from './chat/use-chat-composer-side';
import { slashItemsFor } from './chat/use-command-palette';
import { useChatFold } from './chat/use-chat-fold';
import { ChatScrollbar } from './chat/ChatScrollbar';
import { useSessionEvents } from './chat/use-session-events';
import { useChatUndo } from './chat/use-chat-undo';
import { useChatDynBlocks } from './chat/use-chat-dyn-blocks';
import { useChatDraft } from './chat/use-chat-draft';
import { useChatImages } from './chat/use-chat-images';
import { useChatSeenArchive } from './chat/use-chat-seen-archive';
import { useChatTerminalDock } from './chat/use-chat-terminal-dock';
import { expandFileRefs, expandRefContents, renderMentionSpans, slashTokenAt } from './chat/mention';
export { atomicRange, expandFileRefs, fileHit, FilePalette, rankFileHits, rebuildPickTokens, RefTokenChip, renderMentionSpans, renderUserMd, slashTokenAt, splitBrowserFences, splitMentionTokens, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './chat/mention';
export type { MentionToken, TokenGuardVerdict } from './chat/mention';
export { buildMdComponents, buildUserMdComponents, keepUrl, mdComponentsPlain, MermaidBlock, MD_REMARK_PLUGINS, MD_REHYPE_PLUGINS, MarkdownCached, renderMdCached } from './chat/md-render';
import { DirResolverContext, MdImageContext, MdImageKeyContext } from './chat/md-render';
export { useDirResolver } from './chat/md-render';
export { baseModelName, ChatEntryView, CollapsibleBubble, ThinkingEntryView } from './chat/EntryViews';
import { useWorkspaceFiles } from './chat/use-workspace-files';
import type { AskPick } from './chat/PendingCards';
import type { RefEntries, RefItem, RefPal } from './chat/ref-palette';
import { flatRefItems, unknownRefTokens } from './chat/ref-palette';
import { useQueue } from './chat/use-queue';
import { useComposerKeys } from './chat/use-composer-keys';
import { ChatComposerDock } from './chat/chat-composer-dock';
import { ChatTranscript } from './chat/chat-transcript';
import { RENDER_WINDOW_MAX } from './chat/MessageList';
import { usePopOutsideClose } from '../use-pop-outside-close';
import { useChatNotify } from './chat/use-chat-notify';
import { LiveChangesContext, TurnLatestContext, useLiveGitChanges } from './chat/use-live-changes';
import { TurnUndoContext, makeTurnUndoApi } from './chat/turn-undone-context';
import { useChatLocate } from './chat/use-chat-locate';
export { ToolEntryView } from './chat/ToolEntry';
export type { TodoBatch } from './chat/ToolEntry';
export type { ChatSink, ChatProps } from './chat/chat-types';
import type { ChatProps } from './chat/chat-types';
import type { ComposerEnv } from './chat/edit-composer';





/** G14.133 权限档统一图标(pill 与菜单同源——静态 Hand 两套渲染退役;权限档改名对齐后端):
 *  plan=NotebookPen / read-only=Eye / acceptEdits=ShieldCheck / full-access=Unlock(2026-11-03:plan 换 NotebookPen——原 ListTodo 与待办图标撞车,用户裁定换掉) */
export function ModeIcon({ mode, size = 13 }: { mode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan'; size?: number }): JSX.Element {
  const Icon = mode === 'plan' ? NotebookPen : mode === 'read-only' ? Eye : mode === 'acceptEdits' ? ShieldCheck : Unlock;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}




/** tokens 格式:共享面迁移 ui-util.fmtTokens(G14.17)——本文件 re-export 保既有引用零迁移 */

/** G14.212 会话滚动位存档单点(2026-10-27 技术债轮外提 chat/scroll-mem.ts——≤800 验收线回弹清算):
 *  saveScrollPos/peekScrollPos 原路径同名导入,行为零变化 */

/** G14.95 slash 面板令牌解析:原语下沉 mention.ts(与 atomicRange 同族单点),原路径再导出保消费方 */

export function Chat({ conn, active = true, sessionId, connState, sinkRef, onSeeded, onOpenFile, onOpenDiff, onOpenTurnDiff, onOpenAgent, onOpenWeb, onRunInTerminal, onOpenMemory, onOpenLearned, onOpenTask, board, teams, onFork, onOpError, onOpenArtifacts, pendingGoal, onPendingGoalDone, root, onRenamed, onSideChat, fixedTitle, kindHint, sideChat, journalId, onTodos, initialInsert, initialInsertContent, onInsertConsumed, onTodoBatches, onOpenTab, agentTeamsOn = true, bgRunning = 0, chatMem, onSessionsMutated, pins, persistPins, menuClosed, onToggleMenu, nav, onRunStart, todoFocus, leaderFocus, onSideAsk, onTodoLocate, onOpenSession, onRewind, ptyIdFor, onPtyAllocated, onCloseDockTab }: ChatProps): JSX.Element {
  /** G14.213 滚动位存档键:journal 档案 id(稳定)优先,缺省回落 sessionId(测试桩/旁路面) */
  const archiveKey = journalId !== undefined && journalId !== '' ? journalId : sessionId;
  // G14.2xx b 转录内存缓存:挂载命中即直渲缓存态(快照播种落定无缝整替校准),卸载写回最新投影
  const [chat, setChat] = useState<ChatState>(() => chatMem?.get(archiveKey) ?? initialChatState());
  const chatRef = useRef<ChatState>(chat);
  chatRef.current = chat;
  // 渲染窗口镜像(2026-11-17 切回卡顿实测轮):挂载读缓存上次展开宽度作为**后台补齐目标**
  // (MessageList 首帧恒只挂入口窗,空闲分批爬到目标);无缓存=MAX 预暖(冷会话平滑补齐口径不变)。
  // 每拍上抛即更 ref,卸载随 chatMem 写回——ref 而非 state:回放每批免整树重渲
  const renderWindowRef = useRef<number>(chatMem?.get(archiveKey)?.renderWindow ?? RENDER_WINDOW_MAX);
  const onRenderWindowChange = useCallback((n: number): void => {
    renderWindowRef.current = n;
  }, []);
  useEffect(() => {
    return () => {
      // memSeat 随写(2026-11-16 流畅轮):journal 键在 daemon 侧恒同一会话,但 attach 未收编时
      // 换座壳 id 会换——reseed sig-skip 须同座才免整替(防跨座串显),写回即落当前座别
      if (chatMem !== undefined) chatMem.put(archiveKey, { ...chatRef.current, memSeat: sessionId, renderWindow: renderWindowRef.current });
    };
  }, [archiveKey, chatMem, sessionId]);


  /** 2026-10-26 用户裁定:输入草稿按会话持久化(localStorage 键=journalId 优先同滚动存档口径);
   *  草稿存档/键迁移/芯片账本回灌+首问种子收口 use-chat-draft(D62 批I) */
  const refContentsRef = useRef(new Map<string, string>());
  const { input, setInput } = useChatDraft({ archiveKey, refContentsRef, initialInsert, initialInsertContent });

  /** 2026-11-10 终端下栏:显能读 settings·terminalDock(on/off,缺省 on;use-chat-session-info
   *  同款挂载拉取+config-changed 重拉),面板显隐本地态(入口钮切;设置翻 off 即卸载 dock)。
   *  开态/高度/显能簇收口 use-chat-terminal-dock(D62 批I) */
  const { dockOpen, setDockOpen, dockHeight, setDockHeight, terminalDockEnabled } = useChatTerminalDock({ conn, sessionId, root, sideChat });

  /** G10-C4 composer pills:会话权限态 + 模型信息(snapshot 回显,切换即乐观更新);缺省 full-access(serve 缺省档) */
  const [sessMode, setSessMode] = useState<'read-only' | 'acceptEdits' | 'full-access' | 'plan'>('full-access');
  const [sessEffort, setSessEffort] = useState<string | undefined>(undefined);
  /** 归档态(2026-10-21):快照播种对齐(sessMode 同链,use-session-events reseed 回填)——顶栏归档钮/徽标三态 */
  const [archived, setArchived] = useState(false);
  /** pill 开合('plus' = + 附加面板) */
  const [pillOpen, setPillOpen] = useState<'mode' | 'model' | 'plus' | null>(null);
  /** textarea 引用(+ 面板插入收口后焦点回输入框) */
  /** 流区贴底跟随(G13 反馈轮):滚动容器 ref + 「用户是否贴底」旁路 ref——贴底(含初始态)时
   *  每次渲染(流式 token/条目增删)自动归底;用户上翻超阈值即放手,再触底恢复跟随 */
  const chatScrollRef = useRef<HTMLElement | null>(null);
  // G14.212/G14.213 再进恢复上次浏览位:挂载读非贴底存档(距底 px,键=journalId 稳定身份)——
  // 存档位待恢复 + 贴底跟随挂起(stick 初值 false,每渲染归底 effect 让位;恢复后 onScroll 接管)。
  // 贴底离开无存档=照旧跳底
  const scrollRestoreRef = useRef<number | null>(peekScrollPos(archiveKey));
  const chatStickRef = useRef(scrollRestoreRef.current === null);
  /** 跟随闩位移指纹:上次 scroll 事件时的 scrollTop——本次事件里它没变=纯内容生长
   *  (钉底位被新内容顶成距底>0),不得据此释放 stick(二修根因见 handleChatScroll 注) */
  const chatLastTopRef = useRef(0);
  useChatLocate({ todoFocus, leaderFocus, chatScrollRef, chatStickRef });
  /** G14.85 @ 工作区文件选择:文件清单懒加载(BFS 限深限数,跳噪声目录)+触发态 */
  const [filePal, setFilePal] = useState<{ query: string; from: number } | null>(null);
  const [filePalFiles, setFilePalFiles] = useState<string[]>([]);
  const [filePalActive, setFilePalActive] = useState(0);
  /** agents-teams P1 §3.2 $/# 引用面板:触发态 + 两目录缓存(agents/teams id+name 投影)+单游标。
   *  entries 懒加载(refEntriesLoadedRef 门:首次命中拉一次,失败静默空列=面板照开仅无项;
   *  R5:未知引用提示只认这份缓存,从未拉过=跳过检查,不为提示补拉) */
  const [refPal, setRefPal] = useState<RefPal | null>(null);
  const [refEntries, setRefEntries] = useState<RefEntries>({ agents: [], teams: [] });
  const [refActive, setRefActive] = useState(0);
  const refEntriesLoadedRef = useRef(false);
  // G14.211 @ 面板点外即收:收口此前只有 Esc/改写输入两条路,焦点离开输入框后 Esc 不可达、
  // 点外无处理 = 面板滞留(「无法关闭」直感)。pointerdown 落 composer 卡外即收;面板行在
  // 卡内(overlays 锚卡根),选中点击不受影响
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      // G14.211 点外即收(@ 与 $/# 两面板同款:面板行锚 composer 卡内,卡内点不受影响)
      if (e.target instanceof Element && !e.target.closest('.sx-composer')) {
        setFilePal(null);
        setRefPal(null);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, []);
  /** G14.126 @文件名 记账:选中面板行时 basename → 相对路径(发送期展开解析第一优先) */
  const pickRelRef = useRef(new Map<string, string>());
  /** G14.213 IME 组合中标记:onSelect 归位在组合期跳过(防打断输入法) */
  const composingRef = useRef(false);
  /** 工作区文件索引 hook(D32 批B 数据部):装载/缓存/预热/解析器——记账表注入,pickRelRef 写入面留 UI */
  const { resolveFileRef, loadWorkspaceFiles, filesVer } = useWorkspaceFiles(conn, sessionId, root, pickRelRef);
  /** agents-teams P1 §3.2 引用目录懒加载:并行 agentsView+teamsView(root 同口径守卫——缺省/
   *  空串/'default' 走全局清单),结果投影 id+name(shadowed 行剔除——同 id 两级行只留生效者),
   *  缓存于 ref(首次命中后零网络);失败静默空列——面板照开仅无项(R5 不为提示补拉) */
  const loadRefEntries = useCallback((): void => {
    if (refEntriesLoadedRef.current) return;
    refEntriesLoadedRef.current = true;
    const refRoot = root !== undefined && root !== '' && root !== 'default' ? root : undefined;
    void Promise.all([conn.agentsView(refRoot), conn.teamsView(refRoot)]).then(
      ([a, tv]) => {
        setRefEntries({
          // 内置四角色并入候选池(2026-11-05 用户实测:零注册目录下 $ 弹了等于没弹)——内置本就
          // 可 $ 引用(spawn/agent 工具均收,agents 索引同源),同 id 注册行不重复列(builtin-first)
          agents: [
            ...a.builtins.map((b) => ({ id: b.role, name: b.name })),
            ...a.view.entries.filter((e) => !e.shadowed).map((e) => ({ id: e.id, name: e.name })),
          ].filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i),
          teams: tv.view.entries.filter((e) => !e.shadowed).map((e) => ({ id: e.id, name: e.name })),
        });
      },
      () => {}, // 失败静默:entries 保持空列(面板无项不开;不重试——零网络纪律)
    );
  }, [conn, root]);
  /** 目录引用解析(md 链接面/输入框高亮层共用):记账表优先、索引兜底——值带尾斜杠=目录
   *  (内部标记,显示/插入一律无斜杠)。依赖 filesVer:缓存落定即换新引用→context 值变化,
   *  驱动 memo 封存条目(会话恢复先于异步索引渲染)重渲补上黄目录图标 */
  const isDirRef = useCallback(
    (p: string): boolean => {
      const base = pathBasename(p.replace(/[\\/]+$/, ''));
      const hit = pickRelRef.current.get(base) ?? resolveFileRef(base);
      return hit !== undefined && /[\\/]$/.test(hit);
    },
    [resolveFileRef, filesVer],
  );
  /** 队列面 hook(D32 批B):排队 chips 状态/折叠/refreshQueued/pauseAndSend——会话流可见化与 @ 展开
   *  依赖注入（resolveFileRef 此处已完成声明）；行为零变化（Chat.pause-send.test 为锚） */
  const { queued, setQueued, queueFolded, setQueueFolded, refreshQueued, pauseAndSend } = useQueue(
    conn,
    sessionId,
    root,
    resolveFileRef,
    // 排队(steer)路径同口径:ref token 先展开全量再走 @ 文件展开
    (text, r, resolve) => expandRefContents(expandFileRefs(text, r, resolve), refContentsRef.current),
    setChat,
  );
  const { cmdData, setCmdData, cmdActive, setCmdActive, skills, reloadSkills } = useCommandPalette(conn, root);
  // 2026-11-07 用户实测「+ 能实时加出来,/ 不实时」:/ 面板在场即现拉技能清单(运行中新装技能实时可弹)
  useEffect(() => {
    if (slashTokenAt(input, inputRef.current?.selectionStart ?? input.length) !== null) reloadSkills();
  }, [input, reloadSkills]);
  /** G14.213 欢迎页接力取用(ref 跳板):事件 hook 的 reseed 闭包经此恒取最新 submitText。
   *  声明前置于事件 hook(deps 求值早于 submitText 定义);赋值仍在其定义处,首帧空档无消费路径 */
  const submitTextRef = useRef<(text: string, images?: string[]) => Promise<void>>(() => Promise.resolve());
  const expandRefsRef = useRef<(text: string) => string>((text) => text);
  /** 会话事件 hook(D32 批C):播种门/种子窗缓冲/挂起卡/事件分流 sink 装配 + G5 idle 清卡——
   *  投影态与队列/pill 设定器注入(G6 工具 input 旁路暂存 P11 T7 退役);行为零变化(Chat.test 为锚) */
  const { cards, seeding, sendApproval, sendAsk, sendPlanApproval } = useSessionEvents({
    conn,
    active,
    sessionId,
    sinkRef,
    chat,
    pendingGoal,
    onPendingGoalDone,
    onSeeded,
    onTodos,
    initialInsert,
    onInsertConsumed,
    setInput,
    setChat,
    setQueued,
    setSessMode,
    setSessEffort,
    setArchived,
    submitTextRef,
    flushScrollMem,
  });

  /** 派生投影面(批F-4):任务名/待办批次/关联轮次/动态计数——纯投影收敛 use-chat-derived
   *  (P11 T7 起字段单源:工具 input 暂存注入随旁路退役) */
  const { taskNameOf, taskAgentOf, teamNameOf, todoActive, todoTotal, taskDone, taskRunning, computerUseActive } = useChatDerived({
    chat,
    board,
    teams,
    onTodoBatches,
  });
  // 2026-10-26 滚动卡点修复:runFooter 投影引用稳定化——此前逐渲染 new Map,组级 memo 比较器恒失配,
  // 轮询/流式重渲染把整个可见窗 600 条全量重建(滚动中撞上=「鼠标失灵」式冻结);浅等复用旧 Map,
  // 配对真变(段收口/封条)才换身份
  const runFooterPrevRef = useRef<ReadonlyMap<string, ChatEntry>>(new Map());
  runFooterPrevRef.current = runFooterMapOfStable(runFooterPrevRef.current, chat.entries, chat.status);
  const runFooterByEntry = runFooterPrevRef.current;

  /** 回退/派生轮寻址簇(fork 序位/rewind 操作面/轮次 checkpoint 通道)收口 use-chat-undo(D62 批I) */
  const { onForkRun, rewindOps, onTurnOpen, onTurnRestore } = useChatUndo({ conn, sessionId, chatRef, entries: chat.entries, expandRefsRef, setChat, onFork, onRewind, onOpenTurnDiff });
  /** 编辑卡输入环境:@短写记账表共享——编辑卡选中的文件在发送期(resendFrom)照样展开 */
  const composerEnv = useMemo<ComposerEnv>(() => ({ sessionId, pickRelRef }), [sessionId]);

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
  const { titleEditing, setTitleEditing, titleDraft, setTitleDraft, commitTitle, displayTitle, kind, adoptTitle } = useChatTitle({
    conn,
    sessionId,
    fixedTitle,
    entries: chat.entries,
    onRenamed,
    ...(kindHint !== undefined ? { kindHint } : {}),
  });
  /** Sunx 显示名单点(2026-11-17):kind 已由打开链 hint 首帧定格;标题未载回落品牌名 'Sunx'
   *  (空名会让 hero/占位露「给  一个目标」) */
  const sunxLabel = kind === SESSION_KIND_SUNX ? (displayTitle.trim() !== '' ? displayTitle.trim() : 'Sunx') : undefined;
  const { modelInfo, setModelInfo, ctxInfo, refreshCtx, runCount } = useChatSessionInfo({ conn, sessionId, chat });

  /** 命令执行中(2026-10-31 用户裁定「命令运行态=可插入的运行态,可中断」):命令三态系统行未收终态
   *  (result 未到)即运行中——与 run 同权进 running(composer 显停止钮/插入占位,Enter 走 steer 排队;
   *  停止钮 → interrupt 端点 → daemon 中止命令) */
  const commandRunning = chat.entries.some((en) => en.kind === 'tool' && typeof en.name === 'string' && en.name.startsWith('/') && en.result === undefined);
  const running = chat.status === 'running' || commandRunning;
  /** run-live 行/顶部运行态只认真实 run(2026-10-31 用户裁定「步数 tokens 行是普通对话用的,命令期不显」)——命令期 composer 侧运行态走 commandRunning */
  const runLive = chat.status === 'running';
  /** 轮尾改动条动态渲染(2026-11-07):本会话当前 git 变动(审查页同源),各轮条取交集显示;
   *  有轮改动记录才拉,run 收尾/回焦/广播/10s 可见轮询刷新(use-live-changes) */
  const hasRunChanges = chat.entries.some((en) => en.changes !== undefined && en.changes.length > 0);
  const liveChanges = useLiveGitChanges(
    typeof conn.sessionChanges === 'function'
      ? // 非 git 目录(branch='' )→ null:live 缺场回落轮记录原样——轮次 checkpoint 面 git 无关,
        // 改动卡在非 git 目录同样可用(数据=轮末快照封存条目)
        () => conn.sessionChanges(sessionId).then((r) => (r.branch === '' ? null : { files: r.files }))
      : undefined,
    sessionId,
    running,
    hasRunChanges,
  );
  // 顶栏总改动(2026-11-10 用户裁定「主会话顶部实时展示 +A −D,点击开审查页」):独立于改动卡的
  // enabled 门(有 run 改动记录才拉)——主会话恒拉(辅助会话不拉,零 git 开销);live 缺场=null 不渲染
  const topbarLive = useLiveGitChanges(
    sideChat !== true && typeof conn.sessionChanges === 'function'
      ? () => conn.sessionChanges(sessionId).then((r) => (r.branch === '' ? null : { files: r.files }))
      : undefined,
    sessionId,
    running,
    sideChat !== true,
  );
  const changesTotal = useMemo(() => {
    const files = topbarLive;
    if (files === undefined || files === null || files.length === 0) return null;
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.added ?? f.newLines ?? 0;
      del += f.deleted ?? 0;
    }
    return add + del > 0 ? { add, del } : null;
  }, [topbarLive]);
  /** 浏览器导航跟随(2026-10-31 用户裁定「浏览器默认直接打开侧栏的浏览器」):browser_navigate
   *  工具条落条即上抛目标 url 开 web 页签;lastNavRef 免对同一条目逐帧重开 */
  const lastNavRef = useRef('');
  useEffect(() => {
    if (onOpenWeb === undefined) return;
    for (const e of chat.entries) {
      if (e.kind !== 'tool' || e.name !== 'browser_navigate') continue;
      const url = e.input?.url;
      if (typeof url === 'string' && url !== '' && url !== lastNavRef.current) {
        lastNavRef.current = url;
        onOpenWeb(url);
      }
    }
  }, [chat.entries, onOpenWeb]);
  /** 队列防竞态面(2026-10-31):当前会话用户条文本集(trim)——SteerQueue 立即/插入转圈直至
   *  文本命中正文;memo 随条目帧重算 */
  const entryTexts = useMemo(() => new Set(chat.entries.filter((e) => e.kind === 'user').map((e) => e.md.trim())), [chat.entries]);
  // Win 完成通知卡(完成沿+窗口失焦才弹,点击聚焦窗口)收口 use-chat-notify(D62 批I)
  useChatNotify({ running, displayTitle });
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
  /** 阶段三 plan-arm(spec §5.2):plan-approval 裁决卡——PlanCard(计划书 markdown+步骤+批准/重新计划,
   *  按钮集随 sessMode 自适应:只读域三键选落档/可写域两键维持当前档),dock 挂载与 approval 同形;
   *  回执经 sendPlanApproval(批准落所选档自动解除,重新计划保持) */
  const planCards = cards.filter((c) => c.kind === 'plan-approval');

  // 顶栏动态信息块+最近两轮快照+轮内步数 tokens 基线差收口 use-chat-dyn-blocks(D62 批I)
  const { dynBlocks, liveSteps, liveTokens } = useChatDynBlocks({ entries: chat.entries, board, todoTotal, todoActive, taskDone, taskRunning, planCardCount: planCards.length, bgRunning, agentTeamsOn, running, sessionId, chatSteps: chat.steps, chatTokens: chat.tokens });
  /** G14.74 回到底部钮:非贴底即显(滚动 handler 里置态,值不变时 React 自动跳过重渲染) */
  const [atBottom, setAtBottom] = useState(scrollRestoreRef.current === null); // G14.212 恢复中非贴底:跳底钮即显
  /** 等待模型待态(2026-10-27):idle 提交被接受→run-open 落地之间的空窗计时——上游首 token
   *  延迟实测 29-60s 且此间零反馈(用户「卡住 1 分钟不显示计时」)。run 条出现/error 条即收 */
  const [awaitModelSince, setAwaitModelSince] = useState<number | null>(null);
  useEffect(() => {
    setAwaitModelSince(null);
  }, [sessionId]);
  useEffect(() => {
    if (awaitModelSince === null) return;
    const last = chat.entries[chat.entries.length - 1];
    // tool 条亦收(命令三态行无 run-open;防御:任何非 user 新条即表示 daemon 已响应)
    if (last !== undefined && (last.kind === 'run' || last.kind === 'error' || last.kind === 'tool')) setAwaitModelSince(null);
  }, [chat.entries, awaitModelSince]);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /** 图片附件簇(待发列/草稿图持久化/灯箱源/提示条/承接单点)收口 use-chat-images(D62 批I) */
  const { pendingImages, setPendingImages, lightboxSrc, setLightboxSrc, imgHint, showImgHint, modelSupportsImages, addImageFiles } = useChatImages({ archiveKey, modelInfo });




  // pills/+ 面板外点收(面板内点与 + 钮自持)收口 usePopOutsideClose(D62 批J 共用件;D62 批I 接入)
  usePopOutsideClose(pillOpen !== null, pillOpen === 'plus' ? '.sx-plus-panel' : '.composer-pills', pillOpen === 'plus' ? '.composer-plus-btn' : '.composer-pills', () => setPillOpen(null));

  /** 归档/撤销归档+事件同步+运行收束/journalId 到位压已读簇收口 use-chat-seen-archive(D62 批I) */
  const { onArchive } = useChatSeenArchive({ conn, sessionId, journalId, running, setArchived, onOpError, onSessionsMutated });

  // 提交路径 §7(批F-7a):hook 返还三件;ref 赋值留此(声明在事件 hook 前,恒取最新)
  const { submitText, send: sendRaw, interrupt } = useChatSubmit({
    conn,
    sessionId,
    running,
    sessMode,
    root,
    resolveFileRef,
    refContents: refContentsRef.current,
    cmdData,
    setChat,
    onSideChat,
    refreshQueued,
    input,
    setInput,
    images: pendingImages,
    setImages: setPendingImages,
    onAccepted: () => { setAwaitModelSince(Date.now()); onRunStart?.(); },
    sendBlocked: awaitModelSince !== null,
    onPlanModeChanged: setSessMode,
  });
  /** G14.213 欢迎页接力取用(ref 跳板,声明前置于事件 hook):恒取最新 submitText */
  submitTextRef.current = submitText;
  expandRefsRef.current = (text) => expandRefContents(expandFileRefs(text, root, resolveFileRef), refContentsRef.current);
  /** 2026-10-26 用户裁定:发送即跳底——视口停在上文时发新消息,立即置回贴底跟随
   *  (stick 先置 true:发送回显帧与本轮流式内容随后由既有贴底 effect 接管不脱手) */
  const jumpToBottom = useCallback((): void => {
    chatStickRef.current = true;
    const el = chatScrollRef.current;
    if (el !== null) {
      syncOverflowAnchor(el, true);
      el.scrollTop = el.scrollHeight;
      markProgBottom(el);
    }
  }, [chatScrollRef]);
  const send = useCallback((): void => {
    // agents-teams P1 R5 未知引用提示(发送入口只读检查,use-chat-submit 零改动):entries 已
    // 拉过才对照(从未拉过=跳过,不为提示补拉);拉过但两组全空=拉取失败(或空目录)不提示
    // (评审 2026-11-04:失败静默空列若照检,每条含 $/# 消息都会吃到假「未匹配」提示)。
    // 未命中者聚合一条 transient 提示(imgHint 同款 role="status" 自隐行),原文照发——
    // 不拦截、不改写
    if (refEntriesLoadedRef.current && (refEntries.agents.length > 0 || refEntries.teams.length > 0)) {
      const unknown = unknownRefTokens(input, refEntries);
      if (unknown.length > 0) {
        const list = unknown.join(' ');
        showImgHint(t(`No registered match for ${list} — sent as-is`, `${list} 未匹配到在册条目——已按原文发送`));
      }
    }
    jumpToBottom();
    sendRaw();
  }, [jumpToBottom, sendRaw, input, refEntries, showImgHint]);
  const { onInputClick } = useChatComposerSide({
    pickRelRef,
    refContents: refContentsRef,
    inputRef,
    setInput,
    input,
    resolveFileRef,
    onOpenFile,
  target: sideChat === true ? 'side' : 'main',
  // side 广播作用域:本面会话 id(非本会话的 side composer 忽略)
  ownSessionId: sideChat === true ? sessionId : undefined,
  });

  // composer 输入面键分发与守卫（token 原子性三面/@ 面板//面板/Enter 分流）——分支本体收编
  // use-composer-keys（D32 批G 补批，行为零变化）；共享状态经参数传入，渲染面留宿主
  const composerKeys = useComposerKeys({
    input,
    setInput,
    inputRef,
    composingRef,
    filePal,
    setFilePal,
    filePalFiles,
    setFilePalFiles,
    filePalActive,
    setFilePalActive,
    loadWorkspaceFiles,
    pickRelRef,
    refPal,
    setRefPal,
    refEntries,
    refActive,
    setRefActive,
    loadRefEntries,
    cmdData,
    setCmdData,
    cmdActive,
    setCmdActive,
    skills,
    conn,
    sessionId,
    send,
    onOpenMemory,
  });



  /** G14.95 面板项(渲染期,光标位置):/ 令牌 → 面板项;空=面板不开(无匹配自动关) */
  const slashPanelItems: CmdItem[] | null = (() => {
    const caret = inputRef.current?.selectionStart ?? input.length;
    // 2026-11-05 用户裁定:技能回归 / 触发面板(插入引用行,kind='skill'——G14.213 纯文本语义,
    // Enter 有参=普通发送落软引用,不回命令通道;P0 命令派发退役口径不变)
    const items = slashItemsFor(cmdData, slashTokenAt(input, caret), skills ?? []);
    return items.length > 0 ? items : null;
  })();

  /** agents-teams P1 §3.2 $/# 引用面板项(渲染期):触发态在场 + 活性锚校验(G14.211 同款:
   *  锚位非 $/# 即不开)+ 过滤非空才开(全空=不开,与 @ 同门)。overlays 链首位=互斥收口:
   *  引用面板在场时 @/+/命令面板一律不渲染 */
  const refPanelItems: RefItem[] | null = (() => {
    if (refPal === null) return null;
    if (input[refPal.from] !== '$' && input[refPal.from] !== '#') return null;
    // 空命中也返回 [](面板照开 + 空态引导,不再静默隐藏——用户实测:零目录时 $/# 弹了等于没弹;
    // 池空指路设置面,有池无匹配报无匹配)。$/# 拆开各自单域(2026-11-05 用户裁定)
    return flatRefItems(refEntries, refPal.query, refPal.sym);
  })();

  /** G14.95 输入框高亮层:token 着色 spans(与 textarea 同排版);ref 芯片 hover 全文取账本;
   *  composer=true:ref 芯片 ⟦⟧ 定界符保字宽+图标绝对定位(显形宽度=原文宽度硬约束) */
  /** IME 组字段范围(compositionstart/update/end 三拍回抛,ComposerCard 上抛)——高亮层把与范围
   *  交叠的 token 压平为普通段,既有芯片全程保留(2026-11-05 用户实测「组字期芯片消失」根修) */
  const [compRange, setCompRange] = useState<{ start: number; end: number } | null>(null);
  const renderHighlightSpans = (text: string): ReactNode => renderMentionSpans(text, resolveFileRef, refContentsRef.current, undefined, true, compRange);

  /** 流区滚动:贴底跟随置态 + G14.213 容量守卫存档(短会话/mermaid 换渲等瞬时塌陷不记不删——
   *  防塌陷窗内杂散 scroll 把非贴底存档误清;贴底删档/非贴底记距底位)。
   *  跟随闩三修(2026-10-31,实机探针两轮复现定案):释放只认真用户输入,距离+位移都不可信——
   *  ①距离门会被同帧内容生长虚增(首版 <4 非对称闩之死:贴底写入被钳到旧 max,3ms 后流式再长
   *  一行,dist 过 4px 一次 scroll 事件误释放,整轮跟随死);②位移门会被 Chromium 事件合并骗过
   *  (二修之死:写入落点 scroll 与内容生长合并成一次派发,事件同时携带程序位移+dist 虚增)。
   *  定案:scrollTop 命中 markProgBottom 登记值(ε=1.5)=程序位移不释放;距底 <4 重贴不变;
   *  其余(用户滚轮——wheel 先行释放、拖条/刻度跳转/锚定回钉——真实位移且未登记)按距离放手。
   *  跳底钮仍用 80 显隐(近底不闪钮)。 */
  const handleChatScroll = (e: { currentTarget: HTMLElement }): void => {
    const el = e.currentTarget;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const prog = isProgBottom(el, el.scrollTop);
    const moved = Math.abs(el.scrollTop - chatLastTopRef.current) > 1;
    chatLastTopRef.current = el.scrollTop;
    const stick = dist < 4 ? true : prog ? chatStickRef.current : moved ? false : chatStickRef.current;
    if (stick !== chatStickRef.current) syncOverflowAnchor(el, stick);
    chatStickRef.current = stick;
    setAtBottom(dist < 80);
    if (el.scrollHeight - el.clientHeight > 80) {
      saveScrollPos(archiveKey, stick ? 0 : dist);
    }
  };
  /** 滚轮上翻立即脱离贴底:与 scroll 非对称闩互补(scroll 事件晚于 wheel 时也先放手);
   *  同时锚定模式交还阅读态(G14.211 auto) */
  const handleChatWheel = (e: { deltaY: number }): void => {
    if (e.deltaY < 0) {
      chatStickRef.current = false;
      const el = chatScrollRef.current;
      if (el !== null) syncOverflowAnchor(el, false);
    }
  };

  /** 正文 md 图片解析器(2026-10-26 正文支持显示图片):绑定会话的 readFile,md 图片语法的工作区
   *  路径经它读成 dataURL(MdImageContext 单向注入,MessageList/气泡/正文全子树可达) */
  const mdImageLoader = useCallback(
    (p: string) => conn.readFile(sessionId, p),
    [conn, sessionId],
  );

  /** 路径→最后改它的轮(2026-11-11 冻结快照面配套):全 entries 汇总,轮尾条据此判最新性——
   *  后续轮次覆盖过的文件,前面轮次只能看不能撤(用户裁定) */
  const turnLatestByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const en of chat.entries) {
      if (en.runSeq === undefined || en.turn === undefined) continue;
      for (const tc of en.turn) {
        const k = tc.path.replaceAll('\\', '/');
        const prev = m.get(k);
        if (prev === undefined || en.runSeq > prev) m.set(k, en.runSeq);
      }
    }
    return m;
  }, [chat.entries]);

  const turnUndoApi = useMemo(() => makeTurnUndoApi(journalId ?? ''), [journalId ?? '']);

  return (
    <DirResolverContext.Provider value={isDirRef}>
      <MdImageKeyContext.Provider value={archiveKey}>
      <MdImageContext.Provider value={mdImageLoader}>
      <LiveChangesContext.Provider value={liveChanges}>
      <TurnLatestContext.Provider value={turnLatestByPath}>
      <TurnUndoContext.Provider value={turnUndoApi}>

      {/* 2026-11-18 keep-alive:隐藏驻留座只保转录 DOM——顶栏/输入卡不渲染(免重复控件同时省白渲);
          条件位在静态子数组里占槽,转录区索引不变=DOM 原样保留 */}
      {active ? (
      <ChatTopbar
        fixedTitle={fixedTitle}
        titleEditing={titleEditing}
        titleDraft={titleDraft}
        setTitleDraft={setTitleDraft}
        commitTitle={commitTitle}
        setTitleEditing={setTitleEditing}
        displayTitle={displayTitle}
        sessionKind={kind}
        onAdoptTitle={adoptTitle}
        sessionId={sessionId}
        tokens={chat.tokens}
        steps={chat.steps}
        running={running}

        computerUseActive={computerUseActive}
        changesTotal={changesTotal}
        blocks={dynBlocks}
        conn={conn}
        onOpenTab={onOpenTab}
        onOpError={onOpError}
        archived={archived}
        onArchive={onArchive}
        journalId={journalId}
        root={root}
        onSessionsMutated={onSessionsMutated}
        pins={pins}
        persistPins={persistPins}
        menuClosed={menuClosed}
        onToggleMenu={onToggleMenu}
        nav={nav}
      />
      ) : null}

      <ChatTranscript
        history={chat.history}
        setChat={setChat}
        initialRenderWindow={renderWindowRef.current}
        onRenderWindowChange={onRenderWindowChange}
        chatStickRef={chatStickRef}
        onOpenMemory={onOpenMemory}
        onOpenLearned={onOpenLearned}
        onOpenTab={onOpenTab}
        onTodoLocate={onTodoLocate}
        onSideAsk={onSideAsk}
        entries={chat.entries}
        structureVersion={chat.structureVersion}
        seedGen={chat.seedGen}
        hiddenKeys={hiddenKeys}
        conn={conn}
        sessionId={sessionId}
        root={root}
        onOpError={onOpError}
        onOpenArtifacts={onOpenArtifacts}
        onOpenWeb={onOpenWeb}
        onRunInTerminal={onRunInTerminal}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
        onOpenAgent={onOpenAgent}
        onOpenTask={onOpenTask}
        taskNameOf={taskNameOf}
        taskAgentOf={taskAgentOf}
        teamNameOf={teamNameOf}
        teams={teams}
        collapsedRuns={collapsedRuns}
        toggleRun={toggleRun}
        submitText={submitText}
        rewindOps={rewindOps}
        composerEnv={composerEnv}
        runFooterByEntry={runFooterByEntry}
        onEntryOpenDiff={onEntryOpenDiff}
        onEntryRestore={onEntryRestore}
        onOpenTurn={onTurnOpen}
        onTurnRestore={onTurnRestore}
        onFork={onForkRun}
        onOpenSession={onOpenSession}
        onEntryToggleClick={onEntryToggleClick}
        sideChat={sideChat}
        sunxName={sunxLabel}
        chatScrollRef={chatScrollRef}
        onScroll={handleChatScroll}
        onWheel={handleChatWheel}
        running={runLive}
        liveSteps={liveSteps}
        liveTokens={liveTokens}
        onOpenImage={setLightboxSrc}
      />
            {/* 2026-10-27 固定长纵向滚动条(用户裁定「长度应该固定,不像现在抖动分段」):仅主对话挂载
       *  (overlay 定位于 .sx-main);侧栏 dock/其余滚动面保原生条 */}
      {sideChat !== true && <ChatScrollbar containerRef={chatScrollRef} bottomOffset={dockOpen ? dockHeight : undefined} />}
      {/* G12 统一输入卡:与欢迎页同一份 ComposerCard(唯一差异:无项目选择条,.composer 只提供
       *  会话语境限宽贴底)。textarea 自增高 rows 随换行 1-6 派生;Enter 提交 / Shift+Enter 换行;
       *  发送/停止共用 32px 圆形实心钮(↑/■,aria-label send/stop 保查询性) */}
      {active ? (
      <ChatComposerDock
        dockRef={dockRef}
        conn={conn}
        sessionId={sessionId}
        root={root}
        sideChat={sideChat}
        sunxName={sunxLabel}
        emptyChat={chat.entries.length === 0}
        connState={connState}
        queued={queued}
        setQueued={setQueued}
        queueFolded={queueFolded}
        setQueueFolded={setQueueFolded}
        refreshQueued={refreshQueued}
        pauseAndSend={pauseAndSend}
        entryTexts={entryTexts}
        atBottom={atBottom}
        chatScrollRef={chatScrollRef}
        askCards={askCards}
        approvalCards={approvalCards}
        planCards={planCards}
        askPicks={askPicks}
        setAskPicks={setAskPicks}
        sendAsk={sendAsk}
        sendApproval={sendApproval}
        sendPlanApproval={sendPlanApproval}
        onOpenAgent={onOpenAgent}
        onOpenFile={onOpenFile}
        sessMode={sessMode}
        setSessMode={setSessMode}
        sessEffort={sessEffort}
        setSessEffort={setSessEffort}
        refContentsRef={refContentsRef}
        pendingImages={pendingImages}
        setPendingImages={setPendingImages}
        setLightboxSrc={setLightboxSrc}
        addImageFiles={addImageFiles}
        imgHint={imgHint}
        modelSupportsImages={modelSupportsImages}
        input={input}
        setInput={setInput}
        inputRef={inputRef}
        running={running}
        seeding={seeding}
        composerKeys={composerKeys}
        setCompRange={setCompRange}
        refPal={refPal}
        setRefPal={setRefPal}
        refPanelItems={refPanelItems}
        refEntries={refEntries}
        refActive={refActive}
        setRefActive={setRefActive}
        filePal={filePal}
        setFilePal={setFilePal}
        filePalFiles={filePalFiles}
        setFilePalFiles={setFilePalFiles}
        filePalActive={filePalActive}
        setFilePalActive={setFilePalActive}
        loadWorkspaceFiles={loadWorkspaceFiles}
        loadRefEntries={loadRefEntries}
        pillOpen={pillOpen}
        setPillOpen={setPillOpen}
        pickRelRef={pickRelRef}
        slashPanelItems={slashPanelItems}
        cmdActive={cmdActive}
        setCmdActive={setCmdActive}
        renderHighlightSpans={renderHighlightSpans}
        onInputClick={onInputClick}
        terminalDockEnabled={terminalDockEnabled}
        dockOpen={dockOpen}
        setDockOpen={setDockOpen}
        ctxInfo={ctxInfo}
        refreshCtx={refreshCtx}
        runCount={runCount}
        steps={chat.steps}
        tokens={chat.tokens}
        cacheTokens={chat.cacheTokens}
        modelInfo={modelInfo}
        setModelInfo={setModelInfo}
        send={send}
        interrupt={interrupt}
        awaitModelSince={awaitModelSince}
      />
      ) : null}
      {/* 2026-11-10 终端下栏改版(用户六条):主对话对等区(.sx-main 直子,非 chat-dock 内——主对话滚条
         bottom 让位不再盖进下栏)——分割线+拖动条(侧栏分割条同款横置)+页签条(侧栏页签同形条形)。
         标签 × 走 App 既有 kill 链,面板 × 只收显不 kill——重开经 ptyIdFor 同 uid 重连 replay 还原 */}
      {active && terminalDockEnabled && dockOpen && ptyIdFor !== undefined && onPtyAllocated !== undefined && onCloseDockTab !== undefined && (
        <TerminalDock
          conn={conn}
          sessionId={sessionId}
          root={root}
          ptyIdFor={ptyIdFor}
          onPtyAllocated={onPtyAllocated}
          onCloseTab={onCloseDockTab}
          onHide={() => setDockOpen(false)}
          onHeightChange={setDockHeight}
        />
      )}
      {lightboxSrc !== undefined && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(undefined)} />}
      </TurnUndoContext.Provider>
      </TurnLatestContext.Provider>
      </LiveChangesContext.Provider>
    </MdImageContext.Provider>
    </MdImageKeyContext.Provider>
    </DirResolverContext.Provider>
  );
}
