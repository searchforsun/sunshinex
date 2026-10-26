import { useEffect, useRef, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, Eye, ListTodo, ShieldCheck, Unlock } from 'lucide-react';
import { ImageLightbox } from '../ImageLightbox';
import { MAX_IMAGES, appendImages, loadImages } from '../images';
import { loadDraftImages, saveDraftImages } from '../draft-images';
import { initialChatState } from '../chat-reducer';
import type { ChatEntry, ChatState } from '../chat-reducer';
import { ComposerCard } from '../composer/ComposerCard';
import { ComposerPlusPanel } from '../composer/ComposerPlusPanel';
import { CommandPalette } from '../CommandPalette';
import { loadStoredMap, pathBasename, persistCappedMap } from '../ui-util';
import { stampSeen } from '../sidebar/project-menu-util';
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
import { useChatDerived, runFooterMapOfStable } from './chat/use-chat-derived';
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
import { PlanCard } from './chat/PlanCard';
import { expandFileRefs, fileHit, FilePalette, rankFileHits, renderMentionSpans, slashTokenAt } from './chat/mention';
export { atomicRange, expandFileRefs, fileHit, FilePalette, rankFileHits, renderMentionSpans, renderUserMd, slashTokenAt, splitMentionTokens, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './chat/mention';
export type { MentionToken, TokenGuardVerdict } from './chat/mention';
export { buildMdComponents, buildUserMdComponents, keepUrl, mdComponentsPlain, MermaidBlock, MD_REMARK_PLUGINS, MD_REHYPE_PLUGINS } from './chat/md-render';
import { DirResolverContext, MdImageContext } from './chat/md-render';
export { useDirResolver } from './chat/md-render';
export { baseModelName, ChatEntryView, CollapsibleBubble, ThinkingEntryView } from './chat/EntryViews';
import type { AskPick } from './chat/PendingCards';
import { useWorkspaceFiles } from './chat/use-workspace-files';
import { useQueue } from './chat/use-queue';
import { useComposerKeys } from './chat/use-composer-keys';
export { ToolEntryView } from './chat/ToolEntry';
export type { TodoBatch } from './chat/ToolEntry';
export type { ChatSink, ChatProps } from './chat/chat-types';
import type { ChatProps } from './chat/chat-types';





/** G14.133 权限档统一图标(pill 与菜单同源——静态 Hand 两套渲染退役;权限档改名对齐后端):
 *  plan=ListTodo / read-only=Eye / acceptEdits=ShieldCheck / full-access=Unlock(plan 阶段一置灰流程标记) */
export function ModeIcon({ mode, size = 13 }: { mode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan'; size?: number }): JSX.Element {
  const Icon = mode === 'plan' ? ListTodo : mode === 'read-only' ? Eye : mode === 'acceptEdits' ? ShieldCheck : Unlock;
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
  scrollMem = loadStoredMap<{ d: number; t: number }>(SCROLL_KEY);
  return scrollMem;
}
function flushScrollMem(): void {
  if (scrollFlushTimer !== null) {
    clearTimeout(scrollFlushTimer);
    scrollFlushTimer = null;
  }
  scrollFlushAt = Date.now();
  if (scrollMem === null) return;
  persistCappedMap(SCROLL_KEY, scrollMem, 100, (v) => v.t);
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

/** G14.95 slash 面板令牌解析:原语下沉 mention.ts(与 atomicRange 同族单点),原路径再导出保消费方 */

export function Chat({ conn, sessionId, connState, sinkRef, onSeeded, onOpenFile, onOpenDiff, onOpenAgent, onOpenTask, board, onFork, onOpError, pendingGoal, onPendingGoalDone, root, onRenamed, onSideChat, freshView, fixedTitle, sideChat, journalId, onTodos, onOpenMemory, initialInsert, onTodoBatches, onTurnGoal, onOpenTab, chatMem, onSessionsMutated, menuClosed, onToggleMenu, nav }: ChatProps): JSX.Element {
  /** G14.213 滚动位存档键:journal 档案 id(稳定)优先,缺省回落 sessionId(测试桩/旁路面) */
  const archiveKey = journalId !== undefined && journalId !== '' ? journalId : sessionId;
  // G14.2xx b 转录内存缓存:挂载命中即直渲缓存态(快照播种落定无缝整替校准),卸载写回最新投影
  const [chat, setChat] = useState<ChatState>(() => chatMem?.get(archiveKey) ?? initialChatState());
  const chatRef = useRef<ChatState>(chat);
  chatRef.current = chat;
  useEffect(() => {
    return () => {
      if (chatMem !== undefined) chatMem.put(archiveKey, chatRef.current);
    };
  }, [archiveKey, chatMem]);


  /** 2026-10-26 用户裁定:输入草稿按会话持久化(localStorage 键=journalId 优先同滚动存档口径)——
   *  切会话/重启回来都能恢复未发送文本;发送置空即清档。Chat 以 key={sessionId} 挂载,会话隔离=键隔离 */
  const [input, setInput] = useState<string>(() => {
    try {
      return localStorage.getItem(`sx-draft:${archiveKey}`) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`sx-draft:${archiveKey}`, input);
    } catch {
      // 隐私模式等写失败静默:草稿是尽力而为的会话便利,不入错误面
    }
  }, [input, archiveKey]);
  /** G10-C4 composer pills:会话权限态 + 模型信息(snapshot 回显,切换即乐观更新);缺省 full-access(serve 缺省档) */
  const [sessMode, setSessMode] = useState<'read-only' | 'acceptEdits' | 'full-access' | 'plan'>('full-access');
  const [sessEffort, setSessEffort] = useState<string | undefined>(undefined);
  /** 归档态(2026-10-21):快照播种对齐(sessMode 同链,use-session-events reseed 回填)——顶栏归档钮/徽标三态 */
  const [archived, setArchived] = useState(false);
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
  const { resolveFileRef, loadWorkspaceFiles, filesVer } = useWorkspaceFiles(conn, sessionId, root, pickRelRef);
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
    expandFileRefs,
    setChat,
  );
  const { cmdData, setCmdData, cmdActive, setCmdActive, skillCmds } = useCommandPalette(conn, sessionId);
  /** G14.213 欢迎页接力取用(ref 跳板):事件 hook 的 reseed 闭包经此恒取最新 submitText。
   *  声明前置于事件 hook(deps 求值早于 submitText 定义);赋值仍在其定义处,首帧空档无消费路径 */
  const submitTextRef = useRef<(text: string, images?: string[]) => Promise<void>>(() => Promise.resolve());
  /** 会话事件 hook(D32 批C):播种门/种子窗缓冲/挂起卡/事件分流 sink 装配 + G5 idle 清卡——
   *  投影态与队列/pill 设定器注入(G6 工具 input 旁路暂存 P11 T7 退役);行为零变化(Chat.test 为锚) */
  const { cards, seeding, sendApproval, sendAsk, sendPlanApproval } = useSessionEvents({
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
    setSessMode,
    setSessEffort,
    setArchived,
    submitTextRef,
    flushScrollMem,
  });

  /** 派生投影面(批F-4):任务名/待办批次/关联轮次/动态计数——纯投影收敛 use-chat-derived
   *  (P11 T7 起字段单源:工具 input 暂存注入随旁路退役) */
  const { taskNameOf, todoActive, taskActive } = useChatDerived({
    chat,
    board,
    onTodoBatches,
    onTurnGoal,
  });
  // 2026-10-26 滚动卡点修复:runFooter 投影引用稳定化——此前逐渲染 new Map,组级 memo 比较器恒失配,
  // 轮询/流式重渲染把整个可见窗 600 条全量重建(滚动中撞上=「鼠标失灵」式冻结);浅等复用旧 Map,
  // 配对真变(段收口/封条)才换身份
  const runFooterPrevRef = useRef<ReadonlyMap<string, ChatEntry>>(new Map());
  runFooterPrevRef.current = runFooterMapOfStable(runFooterPrevRef.current, chat.entries, chat.status);
  const runFooterByEntry = runFooterPrevRef.current;

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
  /** 阶段三 plan-arm(spec §5.2):plan-approval 裁决卡——PlanCard(计划书 markdown+步骤+批准/反馈),
   *  dock 挂载与 approval 同形;回执经 sendPlanApproval(批准落工作区编辑自动解除,拒绝保持) */
  const planCards = cards.filter((c) => c.kind === 'plan-approval');
  const lastLiveRun = running
    ? [...chat.entries].reverse().find((e) => e.kind === 'run' && e.streaming === true)
    : undefined;
  const liveSteps = lastLiveRun?.stepsBase !== undefined ? Math.max(0, chat.steps - lastLiveRun.stepsBase) : chat.steps;
  const liveTokens = lastLiveRun?.tokensBase !== undefined ? Math.max(0, chat.tokens - lastLiveRun.tokensBase) : chat.tokens;
  /** G14.74 回到底部钮:非贴底即显(滚动 handler 里置态,值不变时 React 自动跳过重渲染) */
  const [atBottom, setAtBottom] = useState(scrollRestoreRef.current === null); // G14.212 恢复中非贴底:跳底钮即显
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /** 图片附件(2026-10-26):composer 待发 dataURL 列(≤8 张)——粘贴/附件选择装载,send 发送即清;
   *  查看浮层(lightbox)与提示条(超限/模型不支持)同挂本页 */
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  // 草稿图持久化（用户裁定「发送前放到草稿中,和队列一样」）：按 journalId 稳定身份落 IndexedDB——
  // 切换会话/重启回来不丢;发送即清。载入完成前跳过回写（防空初值覆盖已存档）。
  const draftLoadedRef = useRef(false);
  useEffect(() => {
    draftLoadedRef.current = false;
    let alive = true;
    void loadDraftImages(archiveKey).then((imgs) => {
      if (!alive) return;
      setPendingImages(imgs);
      draftLoadedRef.current = true;
    });
    return () => { alive = false; };
  }, [archiveKey]);
  useEffect(() => {
    if (draftLoadedRef.current) void saveDraftImages(archiveKey, pendingImages);
  }, [archiveKey, pendingImages]);
  const [lightboxSrc, setLightboxSrc] = useState<string | undefined>(undefined);
  const [imgHint, setImgHint] = useState<string | undefined>(undefined);
  const imgHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (imgHintTimer.current !== null) clearTimeout(imgHintTimer.current);
  }, []);
  const showImgHint = useCallback((text: string): void => {
    setImgHint(text);
    if (imgHintTimer.current !== null) clearTimeout(imgHintTimer.current);
    imgHintTimer.current = setTimeout(() => setImgHint(undefined), 2600);
  }, []);
  /** 当前模型图片能力(乐观缺省=支持):sessionModel choices supportsImages 显式 false 才拦 */
  const modelSupportsImages = (() => {
    const cur = modelInfo?.current;
    if (cur === undefined || cur === '') return true;
    return modelInfo?.choices.find((c) => c.id === cur)?.supportsImages !== false;
  })();
  /** 附件承接单点(粘贴/文件选择共用):不支持模型先拦;装载(转码)→ ≤8 张钳制→溢出提示 */
  const addImageFiles = useCallback(
    (files: File[]): void => {
      if (!modelSupportsImages) {
        showImgHint(t('Current model does not support image input', '当前模型不支持图片输入'));
        return;
      }
      void loadImages(files).then((imgs) => {
        if (imgs.length === 0) return;
        setPendingImages((cur) => {
          const { images, overflow } = appendImages(cur, imgs);
          if (overflow > 0) showImgHint(t(`Up to ${MAX_IMAGES} images per message`, `每条消息最多 ${MAX_IMAGES} 张图片`));
          return images;
        });
      });
    },
    [modelSupportsImages, showImgHint],
  );

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

  /** 归档/撤销归档(2026-10-21 T5):conn.archiveSession 落 daemon + 本地 archived 即时换面;
   *  失败回摆(409 running 等不静默驻留假态),下次 reseed 快照再权威对齐;错误经 onOpError
   *  (App showOpError 通道,与 fork/rewind 同一错误条)上屏——静默失败病根修复(终审 F4) */
  const onArchive = useCallback((v: boolean): void => {
    setArchived(v);
    conn.archiveSession(sessionId, v).then(
      () => onSessionsMutated?.(), // 落库后再上抛联动——落库前上抛,侧栏归档聚合读到旧档
      (err: unknown) => {
        setArchived(!v);
        onOpError?.(err);
      },
    );
  }, [conn, sessionId, onOpError, onSessionsMutated]);

  /** 运行收束即压已读(2026-10-23 用户裁定):打开中的会话跑完,流式内容已尽收眼底,不再重亮未读;
   *  后台会话完成仍按 journal 更新时刻亮真未读(语义保留)。落库后再联动,侧栏重拉读到的才是新档 */
  const prevRunningRef = useRef(running);
  useEffect(() => {
    const was = prevRunningRef.current;
    prevRunningRef.current = running;
    if (!was || running || journalId === undefined || journalId === '') return;
    void stampSeen(conn, journalId, Date.now()).then(onSessionsMutated, onSessionsMutated);
  }, [running, journalId, conn, onSessionsMutated]);

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
    images: pendingImages,
    setImages: setPendingImages,
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
    cmdData,
    setCmdData,
    skillCmds,
    cmdActive,
    setCmdActive,
    conn,
    sessionId,
    send,
    onOpenMemory,
  });



  /** G14.95 面板项(渲染期,光标位置):/ 令牌 → 面板项;空=面板不开(无匹配自动关) */
  const slashPanelItems: CmdItem[] | null = (() => {
    const caret = inputRef.current?.selectionStart ?? input.length;
    const items = slashItemsFor(cmdData, skillCmds, slashTokenAt(input, caret));
    return items.length > 0 ? items : null;
  })();

  /** G14.95 输入框高亮层:token 着色 spans(与 textarea 同排版) */
  const renderHighlightSpans = (text: string): ReactNode => renderMentionSpans(text, resolveFileRef);

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
  /** G14.2xx 滚轮上翻立即脱离贴底跟随:80px 判定窗内流式重渲的归底赋值会逐帧抵消用户滚动
   *  (滚轮失效感),wheel 是明确的用户意图信号——deltaY<0 直接放手,不等距离窗;
   *  只写 ref 零重渲,回触底恢复仍走 handleChatScroll 的距离判定 */
  const handleChatWheel = (e: { deltaY: number }): void => {
    if (e.deltaY < 0) chatStickRef.current = false;
  };

  /** 正文 md 图片解析器(2026-10-26 正文支持显示图片):绑定会话的 readFile,md 图片语法的工作区
   *  路径经它读成 dataURL(MdImageContext 单向注入,MessageList/气泡/正文全子树可达) */
  const mdImageLoader = useCallback(
    (p: string) => conn.readFile(sessionId, p),
    [conn, sessionId],
  );

  return (
    <DirResolverContext.Provider value={isDirRef}>
      <MdImageContext.Provider value={mdImageLoader}>

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
        archived={archived}
        onArchive={onArchive}
        journalId={journalId}
        root={root}
        onSessionsMutated={onSessionsMutated}
        menuClosed={menuClosed}
        onToggleMenu={onToggleMenu}
        nav={nav}
      />

      {chat.history !== undefined && !chat.history.complete && (

        <div className="chat-history-tip" role="status">

          {chat.history.failed === true ? (

            <button

              type="button"

              className="chat-history-retry"

              onClick={() => setChat((c) => (c.history ? { ...c, history: { ...c.history, failed: false } } : c))}

            >

              {t('Older history failed to load — click to retry', '更早的会话加载失败——点击重试')}

            </button>

          ) : (

            t('Loading earlier history…', '正在加载更早的会话…')

          )}

        </div>

      )}

      <MessageList
        entries={chat.entries}
        structureVersion={chat.structureVersion}
        seedGen={chat.seedGen}
        hiddenKeys={hiddenKeys}
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
        sideChat={sideChat}
        chatScrollRef={chatScrollRef}
        onScroll={handleChatScroll}
        onWheel={handleChatWheel}
        running={running}
        liveSteps={liveSteps}
        liveTokens={liveTokens}
        onOpenImage={setLightboxSrc}
      />
      {/* G12 统一输入卡:与欢迎页同一份 ComposerCard(唯一差异:无项目选择条,.composer 只提供
       *  会话语境限宽贴底)。textarea 自增高 rows 随换行 1-6 派生;Enter 提交 / Shift+Enter 换行;
       *  发送/停止共用 32px 圆形实心钮(↑/■,aria-label send/stop 保查询性) */}
      <div className="chat-dock" ref={dockRef}>
        <div className="chat-dock-fade" aria-hidden="true" />
      {/* G14.88 审批挂起时队列条隐藏(dock 整体让位确认框),确认/拒绝后恢复 */}
      {queued.length > 0 && approvalCards.length === 0 && planCards.length === 0 && (
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
          setImages={setPendingImages}
        />
      )}
        {!atBottom && (
          <button
            type="button"
            className="jump-down"
            aria-label="scroll to bottom"
            data-tip={t('Scroll to bottom', '回到底部')}
            onClick={() => {
              const el = chatScrollRef.current;
              if (el !== null) el.scrollTo({ top: el.scrollHeight }); // G14.74:直接跳底(用户裁定)
            }}
          >
            <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        {planCards.length > 0 ? (
          /* 阶段三 plan-arm(spec §5.2):计划确认卡 dock(与 approval/ask 同容器形态)——批准/
            反馈回执后移卡恢复输入框;裁决期间 composer 由 dock 顶替(同 G14.88 审批挂起口径) */
          <div className="ask-dock">
            {planCards.map((c) => (
              <PlanCard key={c.pid} doc={c.req.doc} items={c.req.items} onDecide={(d) => sendPlanApproval(c.pid, d)} />
            ))}
          </div>
        ) : approvalCards.length > 0 ? (
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
        images={pendingImages}
        onRemoveImage={(i) => setPendingImages((cur) => cur.filter((_, idx) => idx !== i))}
        onImageOpen={setLightboxSrc}
        onPasteFiles={addImageFiles}
        belowInput={
          imgHint !== undefined ? (
            <div className="sx-img-hint" role="status">{imgHint}</div>
          ) : pendingImages.length > 0 && !modelSupportsImages ? (
            <div className="sx-img-hint warn" role="status">{t('Current model does not support image input', '当前模型不支持图片输入')}</div>
          ) : undefined
        }
        value={input}
        rows={Math.min(6, Math.max(1, (input.match(/\n/g) ?? []).length + 1))}
        placeholder={running ? t('Insert into the running session…', '插入运行中会话…') : sideChat === true ? t('Ask something…', '问点什么…') : t('Give sunshinex a task…', '给 sunshinex 一个任务…')}
        disabled={connState !== 'open' || seeding}
        onChange={(v) => {
          setInput(v);
          // G14.124 面板跟随输入(光标前 @token 即开,裸 @ 也开);无匹配=渲染面自然关闭
          const caret = inputRef.current?.selectionStart ?? v.length;
          const m = /@([\w./:\\-]*)$/.exec(v.slice(0, caret));
          if (m !== null) {
            setFilePal({ query: m[1] ?? '', from: caret - (m[1]?.length ?? 0) - 1 });
            // G14.2xx 查询变更即重置 active:残留箭头位在新命中集上会指向邻项(回车选中非目标)
            setFilePalActive(0);
            void loadWorkspaceFiles().then((files) => setFilePalFiles(files));
          } else if (filePal !== null) {
            setFilePal(null);
          }
        }}
        onKeyDown={composerKeys.onKeyDown}
        onBeforeInput={composerKeys.onBeforeInput}
        onPasteGuard={composerKeys.onPasteGuard}
        onCompositionGuard={composerKeys.onCompositionGuard}
        onCompositionEndGuard={composerKeys.onCompositionEndGuard}
        onSelectGuard={composerKeys.onSelectGuard}
        overlays={
          // G14.121 @ 文件面板(此前数据链在而渲染面缺失——@ 弹窗从未出现的根因):命中才渲染;
          // G14.211 锚点校验:@ 已被整删/程序化改写后 filePal 残留,锚位不再是 '@' 即不渲染
          filePal !== null && input[filePal.from] === '@' && filePalFiles.some((f) => fileHit(f, filePal.query)) ? (
            <FilePalette
              items={rankFileHits(filePalFiles, filePal.query)}
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
              onAttachImages={addImageFiles}
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
          // G14.144 拖入文件 → caret 处插 @文件名(短写,账本解析;G14.211 原 @全相对路径过长)。
          // 目录载荷(尾斜杠=内部标记):插入文本不带斜杠(用户裁定),记账存标记值供芯片/展开判目录
          const bare = rel.replace(/[\\/]+$/, '');
          const isDir = bare !== rel;
          const ta = inputRef.current;
          const pos = ta?.selectionStart ?? input.length;
          const base = bare.split(/[\\/]/).filter(Boolean).pop() ?? bare;
          pickRelRef.current.set(base, isDir ? `${bare}/` : bare);
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
      {lightboxSrc !== undefined && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(undefined)} />}
    </MdImageContext.Provider>
    </DirResolverContext.Provider>
  );
}
