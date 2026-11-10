import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, Eye, NotebookPen, ShieldCheck, Unlock } from 'lucide-react';
import { ImageLightbox } from '../ImageLightbox';
import { MAX_IMAGES, appendImages, loadImages } from '../images';
import { loadDraftImages, saveDraftImages } from '../draft-images';
import { applyChatEvent, initialChatState } from '../chat-reducer';
import type { ChatEntry, ChatState } from '../chat-reducer';
import { ComposerCard } from '../composer/ComposerCard';
import { ComposerPlusPanel } from '../composer/ComposerPlusPanel';
import { CommandPalette } from '../CommandPalette';
import { chaseScrollBottom, pathBasename } from '../ui-util';
import { autoSeenSuppressed, stampSeen } from '../sidebar/project-menu-util';
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
import { TerminalDock, loadDockSession } from '../tabs/terminal-dock';
import { useConfigChanged } from '../settings/use-config-changed';
import { SteerQueue } from './chat/SteerQueue';
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
import { MessageList } from './chat/MessageList';
import { ChatScrollbar } from './chat/ChatScrollbar';
import { AskDock } from './chat/AskDock';
import { useSessionEvents } from './chat/use-session-events';
import { SESSION_ARCHIVE_CHANGED_EVENT, type SessionArchiveChange } from '../session-events';
import { ApprovalCard } from './chat/PendingCards';
import { PlanCard } from './chat/PlanCard';
import { expandFileRefs, expandRefContents, fileHit, FilePalette, rankFileHits, refContentConsume, RefPalette, renderMentionSpans, slashTokenAt } from './chat/mention';
import { SelActionsOverlay } from './chat/SelActionsOverlay';
export { atomicRange, expandFileRefs, fileHit, FilePalette, rankFileHits, rebuildPickTokens, RefTokenChip, renderMentionSpans, renderUserMd, slashTokenAt, splitBrowserFences, splitMentionTokens, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './chat/mention';
export type { MentionToken, TokenGuardVerdict } from './chat/mention';
export { buildMdComponents, buildUserMdComponents, keepUrl, mdComponentsPlain, MermaidBlock, MD_REMARK_PLUGINS, MD_REHYPE_PLUGINS } from './chat/md-render';
import { DirResolverContext, MdImageContext } from './chat/md-render';
export { useDirResolver } from './chat/md-render';
export { baseModelName, ChatEntryView, CollapsibleBubble, ThinkingEntryView } from './chat/EntryViews';
import type { AskPick } from './chat/PendingCards';
import { useWorkspaceFiles } from './chat/use-workspace-files';
import type { RefEntries, RefItem, RefPal } from './chat/ref-palette';
import { flatRefItems, refTokenAt, unknownRefTokens } from './chat/ref-palette';
import { useQueue } from './chat/use-queue';
import { useComposerKeys } from './chat/use-composer-keys';
import { LiveChangesContext, useLiveGitChanges, notifyGitChanged } from './chat/use-live-changes';
import { useChatLocate } from './chat/use-chat-locate';
export { ToolEntryView } from './chat/ToolEntry';
export type { TodoBatch } from './chat/ToolEntry';
export type { ChatSink, ChatProps } from './chat/chat-types';
import type { ChatProps, RewindOps, RewindRequest } from './chat/chat-types';
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

export function Chat({ conn, sessionId, connState, sinkRef, onSeeded, onOpenFile, onOpenDiff, onOpenTurnDiff, onOpenAgent, onOpenWeb, onOpenMemory, onOpenLearned, onOpenTask, board, teams, onFork, onOpError, pendingGoal, onPendingGoalDone, root, onRenamed, onSideChat, fixedTitle, sideChat, journalId, onTodos, initialInsert, initialInsertContent, onInsertConsumed, onTodoBatches, onOpenTab, agentTeamsOn = true, bgRunning = 0, chatMem, onSessionsMutated, pins, persistPins, menuClosed, onToggleMenu, nav, onRunStart, todoFocus, leaderFocus, onSideAsk, onTodoLocate, onOpenSession, onRewind, ptyIdFor, onPtyAllocated, onCloseDockTab }: ChatProps): JSX.Element {
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

  /** 2026-11-10 终端下栏:显能读 settings·terminalDock(on/off,缺省 on;use-chat-session-info
   *  同款挂载拉取+config-changed 重拉),面板显隐本地态(入口钮切;设置翻 off 即卸载 dock) */
  /** 终端下栏开态与会话绑定(localStorage 会话键,重启/切会话各回各档);高度全局档经 dock 上报 */
  const [dockOpen, setDockOpen] = useState(() => loadDockSession(sessionId).open);
  const [dockHeight, setDockHeight] = useState(260);
  useEffect(() => { setDockOpen(loadDockSession(sessionId).open); }, [sessionId]);
  const [dockEnabled, setDockEnabled] = useState(true);
  const dockCfgTicks = useConfigChanged(conn);
  useEffect(() => {
    if (typeof conn.settings !== 'function') return; // 测试桩/旁路面:无设置面即保缺省开
    conn.settings(root).then(
      (view) => setDockEnabled(view.keys.find((k) => k.key === 'terminalDock')?.value !== 'off'),
      () => undefined,
    );
  }, [conn, root, dockCfgTicks.settings]);
  const terminalDockEnabled = dockEnabled && sideChat !== true;

  useEffect(() => {
    try {
      localStorage.setItem(`sx-draft:${archiveKey}`, input);
      // 芯片内容账本随草稿同键持久化(2026-11-07 用户裁定「重启后草稿片段也要加载出来」):
      // 文本恢复了、账本(内存态)不恢复=芯片空壳 hover/发送皆失。键变更(切会话)即换档
      localStorage.setItem(`sx-draft-refs:${archiveKey}`, JSON.stringify([...refContentsRef.current]));
    } catch {
      // 隐私模式等写失败静默:草稿是尽力而为的会话便利,不入错误面
    }
  }, [input, archiveKey]);
  // 草稿键迁移(2026-11-07 用户实测「欢迎页升级后点会话行,草稿被清」根修):升级链 journalId
  // 晚到,archiveKey 由临时 sessionId 切到 journalId——新档键下草稿为空,恢复面读到空串=清稿。
  // 键切换时把旧键草稿/芯片账本整体迁到新键(新键已有非空草稿=真换会话,不迁)
  const draftKeyRef = useRef(archiveKey);
  useEffect(() => {
    if (draftKeyRef.current === archiveKey) return;
    const oldKey = draftKeyRef.current;
    draftKeyRef.current = archiveKey;
    try {
      const carried = localStorage.getItem(`sx-draft:${oldKey}`);
      if (carried !== null && carried !== '' && (localStorage.getItem(`sx-draft:${archiveKey}`) ?? '') === '') {
        localStorage.setItem(`sx-draft:${archiveKey}`, carried);
        localStorage.setItem(`sx-draft-refs:${archiveKey}`, localStorage.getItem(`sx-draft-refs:${oldKey}`) ?? '[]');
        localStorage.removeItem(`sx-draft:${oldKey}`);
        localStorage.removeItem(`sx-draft-refs:${oldKey}`);
        setInput(carried);
        const refs = JSON.parse(localStorage.getItem(`sx-draft-refs:${archiveKey}`) ?? '[]') as Array<[string, string]>;
        for (const [k, v] of refs) refContentsRef.current.set(k, v);
      }
    } catch {
      // 档损坏静默:草稿尽力而为
    }
  }, [archiveKey]);
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
  /** 元素/终端片段引用账本(2026-11-04):⟦token⟧→全量内容,发送/排队期 expandRefContents 展开 */
  const refContentsRef = useRef(new Map<string, string>());
  // 芯片账本回灌(2026-11-07 落地即清配套:草稿文本有 sx-draft 持久化,账本不持久则恢复的芯片
  // 全空壳)。只补缺不清现有——insertContent 渲染期种子/事件入账不受影响。每档键只回灌一次:
  // 渲染期同步读盘+JSON 解析,逐渲染执行=流式每帧付一次 localStorage 往返
  const refsHydratedKeyRef = useRef<string | null>(null);
  if (refsHydratedKeyRef.current !== archiveKey) {
    refsHydratedKeyRef.current = archiveKey;
    try {
      const rawRefs = localStorage.getItem(`sx-draft-refs:${archiveKey}`);
      if (rawRefs !== null) {
        for (const [tk, c] of JSON.parse(rawRefs) as Array<[string, string]>) refContentsRef.current.set(tk, c);
      }
    } catch {
      // 档损坏即弃:芯片失去内容是尽力而为面的失败,不入错误面
    }
  }
  // 首问 token 内容入私有账本——渲染期直写(2026-11-07 实测时序根修:子组件 ComposerCard 的
  // 规范化 effect 先于本组件 effect 执行,种子晚于改名=键对不上=回落全局注册表取到别会话内容)
  if (initialInsert !== undefined && initialInsert !== '' && initialInsertContent !== undefined && initialInsertContent !== '') {
    refContentsRef.current.set(initialInsert, initialInsertContent);
    refContentConsume(initialInsert); // 落地即清共享层
  }
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
  const { taskNameOf, taskAgentOf, teamNameOf, todoActive, taskActive, computerUseActive } = useChatDerived({
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

  /** run 条目键→轮次序位(2026-11-04 逐轮 fork):run 在转录中的 1-based 序=daemon 轮锚点序
   *  (每轮一 task 行),宿主按此分档——点哪轮,fork 其上全部记录。ref 镜像保引用恒稳(MessageList
   *  组级 memo 判等不破) */
  const chatEntriesRef = useRef(chat.entries);
  chatEntriesRef.current = chat.entries;
  const onForkRef = useRef(onFork);
  onForkRef.current = onFork;
  const onForkRun = useCallback((runKey: string): void => {
    let n = 0;
    for (const e of chatEntriesRef.current) {
      if (e.kind !== 'run') continue;
      n += 1;
      if (e.key === runKey) {
        onForkRef.current?.(n);
        return;
      }
    }
  }, []);

  /** 编辑卡输入环境:@短写记账表共享——编辑卡选中的文件在发送期(resendFrom)照样展开 */
  const composerEnv = useMemo<ComposerEnv>(() => ({ sessionId, pickRelRef }), [sessionId]);
  /** 气泡回退操作面:用户消息按倒序寻址(转录可能只播种了尾窗,且轮内插入让 run 序≠锚点序) */
  const onRewindRef = useRef(onRewind);
  onRewindRef.current = onRewind;
  const hasRewind = onRewind !== undefined;
  const rewindOps = useMemo<RewindOps | undefined>(() => {
    if (!hasRewind) return undefined;
    const fromEnd = (entry: ChatEntry): { userFromEnd: number } => {
      const users = chatEntriesRef.current.filter((e) => e.kind === 'user');
      return { userFromEnd: users.length - 1 - users.findIndex((e) => e.key === entry.key) };
    };
    const rewind = (req: RewindRequest): Promise<void> => onRewindRef.current?.(req) ?? Promise.resolve();
    return {
      busy: () => {
        const st = chatRef.current;
        return st.status === 'running' || st.entries.some((en) => en.kind === 'tool' && typeof en.name === 'string' && en.name.startsWith('/') && en.result === undefined);
      },
      planForEntry: (entry) => conn.restorePlan(sessionId, fromEnd(entry)),
      // 文本在此展开:引用账本属当前 Chat,回退换座后新 Chat 查不到本卡新加的 @文件/片段
      resendFrom: (entry, text, images, restoreFiles) => rewind({
        target: fromEnd(entry),
        restoreFiles,
        resend: { text: expandRefsRef.current(text), ...(images !== undefined ? { images } : {}) },
      }),
    };
  }, [hasRewind, conn, sessionId]);

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
  /** 轮次 checkpoint 通道(2026-11-10 用户裁定「每轮精确看到自己的改动、能撤销」):
   *  文件名点击 → turndiff 页签(run+path 寻址,冻结轮 diff);撤销 → turn-restore(前像回写,
   *  staleness 逐路径回传;成功广播 git 变点同步审查页)。App 未接通道/旧档缺 runSeq 时
   *  RunChangesBar 内部自回退审查页/git restore 语义 */
  const onTurnOpen = useCallback((run: number, path: string) => { onOpenTurnDiff?.(run, path); }, [onOpenTurnDiff]);
  const onTurnRestore = useCallback((run: number, paths: string[]) =>
    conn.turnRestore(sessionId, run, paths).then(
      (r) => {
        if (r.results.some((x) => x.ok)) notifyGitChanged();
        return r.results;
      },
      (err: unknown) => {
        setChat((c) => applyChatEvent(c, { type: 'error', text: `${t('Revert failed', '撤销失败')}: ${err instanceof Error ? err.message : String(err)}`, ts: Date.now() }));
        return [];
      },
    ), [conn, sessionId]);

  // 标题子系统 + 模型/圆环数据面(批F-6)
  const { titleEditing, setTitleEditing, titleDraft, setTitleDraft, commitTitle, displayTitle } = useChatTitle({
    conn,
    sessionId,
    fixedTitle,
    entries: chat.entries,
    onRenamed,
  });
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
  /** Win 完成通知卡(2026-10-31 用户裁定「桌面端支持 win 的完成右下角卡片提示」):运行→收束
   *  沿且窗口失焦/后台时弹系统通知(前台在看不弹不打扰);点击通知聚焦窗口。Notification 不
   *  可用的环境(旧壳/权限拒绝)静默降级 */
  const prevRunNotifRef = useRef(false);
  useEffect(() => {
    const prev = prevRunNotifRef.current;
    prevRunNotifRef.current = running;
    if (prev === running || running) return; // 只报完成沿
    if (document.hasFocus()) return; // 前台在看=无需提醒
    // 文案定版(2026-11-01 用户裁定):标题「运行完成」,正文「任务:{会话名称}」;点击经壳桥唤起——
    // hide-on-close/最小化窗 window.focus() 无效,preload focusMain → 主进程 show+focus(还原最小化)
    const name = displayTitle.trim();
    try {
      const n = new Notification(t('Run finished', '运行完成'), {
        body: name !== '' ? `${t('Task', '任务')}：${name}` : t('The session task has completed.', '会话任务已完成。'),
        silent: false,
      });
      n.onclick = (): void => {
        const bridge = window.sunshinexWindow;
        if (bridge?.focusMain !== undefined) bridge.focusMain();
        else window.focus(); // 旧壳无桥:退化为尽力 focus
        n.close();
      };
    } catch {
      /* 无通知能力:静默 */
    }
  }, [running, displayTitle]);
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
  const lastLiveRun = running
    ? [...chat.entries].reverse().find((e) => e.kind === 'run' && e.streaming === true)
    : undefined;
  const liveSteps = lastLiveRun?.stepsBase !== undefined ? Math.max(0, chat.steps - lastLiveRun.stepsBase) : chat.steps;
  const liveTokens = lastLiveRun?.tokensBase !== undefined ? Math.max(0, chat.tokens - lastLiveRun.tokensBase) : chat.tokens;
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
  // 他处入口(侧栏行/归档层撤销钮等)改归档态:顶栏徽标随事件同步。寻址 id 可能是运行时 id 或 journalId
  useEffect(() => {
    const onChanged = (e: Event): void => {
      const { id, archived: v } = (e as CustomEvent<SessionArchiveChange>).detail;
      if (id === sessionId || (journalId !== undefined && journalId !== '' && id === journalId)) setArchived(v);
    };
    window.addEventListener(SESSION_ARCHIVE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SESSION_ARCHIVE_CHANGED_EVENT, onChanged);
  }, [sessionId, journalId]);

  /** 运行收束即压已读(2026-10-23 用户裁定):打开中的会话跑完,流式内容已尽收眼底,不再重亮未读;
   *  后台会话完成仍按 journal 更新时刻亮真未读(语义保留)。落库后再联动,侧栏重拉读到的才是新档 */
  // 回调经 ref 读取、不入 effect 依赖:压读成功即上抛 → 宿主 bump → 重渲染,宿主回调身份若随渲染
  // 变化,入依赖即「压读→重渲染→再压读」死循环(2026-11-07 实测 8.6 次/秒,主线程与连接池双占满)
  const onSessionsMutatedRef = useRef(onSessionsMutated);
  onSessionsMutatedRef.current = onSessionsMutated;
  const prevRunningRef = useRef(running);
  useEffect(() => {
    const was = prevRunningRef.current;
    prevRunningRef.current = running;
    if (!was || running || journalId === undefined || journalId === '') return;
    if (autoSeenSuppressed(journalId)) return; // 显式标记未读压制旗:蓝点亮到再次进入为止
    const done = (): void => onSessionsMutatedRef.current?.();
    void stampSeen(conn, journalId, Date.now()).then(done, done);
  }, [running, journalId, conn]);
  // journalId 到位即压已读(2026-11-07 用户实测「欢迎页升级首条完成仍亮未读」根修):升级链
  // journalId 晚到(晚于首轮收束)——上一 effect 因 journalId 空恒跳过。本会话在座(本组件即打开面),
  // journal 一旦寻得即刻压已读,与运行收束压读同语义。每个 journalId 只压一次
  useEffect(() => {
    if (journalId === undefined || journalId === '') return;
    if (autoSeenSuppressed(journalId)) return; // 显式标记未读压制旗:蓝点亮到再次进入为止
    const done = (): void => onSessionsMutatedRef.current?.();
    void stampSeen(conn, journalId, Date.now()).then(done, done);
  }, [journalId, conn]);

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

  return (
    <DirResolverContext.Provider value={isDirRef}>
      <MdImageContext.Provider value={mdImageLoader}>
      <LiveChangesContext.Provider value={liveChanges}>

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
        taskActive={agentTeamsOn ? taskActive : 0}
        bgRunning={bgRunning}
        computerUseActive={computerUseActive}
        changesTotal={changesTotal}
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

      {/* 记忆/学习技能回显点击委托(2026-10-31 用户裁定「点击打开侧栏对应页签」):notice 行
          data-notice-tag/ref 由 EntryViews 落 DOM,此处统一接管开页签+定位 */}
      <div
        style={{ display: 'contents' }}
        onClick={(e) => {
          const el = (e.target as HTMLElement).closest('[data-notice-tag]');
          if (el === null) return;
          const tag = el.getAttribute('data-notice-tag');
          const ref = el.getAttribute('data-notice-ref') ?? '';
          if (tag === 'memory') onOpenMemory?.(ref);
          if (tag === 'skills') onOpenLearned?.(ref !== '' ? ref : undefined);
        }}
      >
      <SelActionsOverlay
        containerRef={chatScrollRef}
        onInsert={(text, content) =>
          // 2026-11-07 串扰根修:kind:'ref' 通道(token+content 同投)——主对话私有账本收,
          // 规范化改名后 hover/展开不落全局注册表兜底(键跨会话共享会取到别会话同键内容)
          window.dispatchEvent(new CustomEvent('sunshinex:insert-ref', { detail: { kind: 'ref', token: text, content, target: 'main' } }))
        }
        onSideAsk={(text, content) => {
          // 2026-11-06 用户裁定 P5:辅助会话内圈选「辅助会话提问」=插入当前侧 composer(不另开新辅助);
          // 主对话语境=走 onSideAsk 开辅助草稿(App 路由)。
          // 2026-11-07 串扰根修:辅助语境广播改 kind:'ref' 通道(token+content 同投,接收面写私有
          // 账本);纯 text 广播只落文字不落账=规范化改名后 hover 落全局兜底取到别会话同键内容
          if (sideChat === true) {
            // sideId 作用域(2026-11-07 用户实测「A 会话截取,B 会话也多一枚」):广播只投本会话
            window.dispatchEvent(new CustomEvent('sunshinex:insert-ref', { detail: { kind: 'ref', token: text, content, target: 'side', sideId: sessionId } }));
            return;
          }
          onSideAsk?.(text, content);
        }}
      />
      <MessageList
        entries={chat.entries}
        structureVersion={chat.structureVersion}
        seedGen={chat.seedGen}
        hiddenKeys={hiddenKeys}
        callIdOf={callIdOf}
        conn={conn}
        sessionId={sessionId}
        root={root}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
        onOpenAgent={onOpenAgent}
        onOpenTask={onOpenTask}
        onOpenTodos={(todos) => {
          onOpenTab?.('tasks');
          onTodoLocate?.(todos);
        }}
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
        chatScrollRef={chatScrollRef}
        onScroll={handleChatScroll}
        onWheel={handleChatWheel}
        running={runLive}
        liveSteps={liveSteps}
        liveTokens={liveTokens}
        onOpenImage={setLightboxSrc}
      />
      </div>
      {/* 2026-10-27 固定长纵向滚动条(用户裁定「长度应该固定,不像现在抖动分段」):仅主对话挂载
       *  (overlay 定位于 .sx-main);侧栏 dock/其余滚动面保原生条 */}
      {sideChat !== true && <ChatScrollbar containerRef={chatScrollRef} bottomOffset={dockOpen ? dockHeight : undefined} />}
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
          entryTexts={entryTexts}
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
              // G14.74 跳底 + 迭代校正(2026-10-27):CV 估算高一次 scrollTo 落点偏短要连点多次,追平收口
              if (el !== null) chaseScrollBottom(el);
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
              <PlanCard key={c.pid} doc={c.req.doc} items={c.req.items} name={c.req.name} path={c.req.path} mode={sessMode} onOpenFile={onOpenFile} onDecide={(d) => sendPlanApproval(c.pid, d)} />
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
          refLedger={refContentsRef}
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
        placeholder={running ? t('Insert into the running session…', '插入运行中会话…') : sideChat === true ? t('Ask something…', '问点什么…') : t('Give Sunshinex a task…', '给 Sunshinex 一个任务…')}
        disabled={connState !== 'open' || seeding}
        onChange={(v) => {
          setInput(v);
          // G14.124 面板跟随输入(光标前 @token 即开,裸 @ 也开);无匹配=渲染面自然关闭
          const caret = inputRef.current?.selectionStart ?? v.length;
          const m = /@([\w./:\\-]*)$/.exec(v.slice(0, caret));
          // agents-teams P1 §3.2 $/# 引用面板同款跟随(与 @ 互斥:同一 caret 前缀不可能同时
          // 以 @词与 $/#词 收尾;@ 命中即收引用面板,反之亦然)
          const rt = refTokenAt(v, caret);
          if (m !== null) {
            setFilePal({ query: m[1] ?? '', from: caret - (m[1]?.length ?? 0) - 1 });
            // G14.2xx 查询变更即重置 active:残留箭头位在新命中集上会指向邻项(回车选中非目标)
            setFilePalActive(0);
            void loadWorkspaceFiles().then((files) => setFilePalFiles(files));
            setRefPal(null);
          } else if (rt !== null) {
            setRefPal(rt);
            setRefActive(0);
            loadRefEntries();
          } else {
            if (filePal !== null) setFilePal(null);
            if (refPal !== null) setRefPal(null);
          }
        }}
        onKeyDown={composerKeys.onKeyDown}
        onBeforeInput={composerKeys.onBeforeInput}
        onPasteGuard={composerKeys.onPasteGuard}
        onCompositionGuard={composerKeys.onCompositionGuard}
        onCompositionRange={setCompRange}
        onCompositionEndGuard={composerKeys.onCompositionEndGuard}
        onSelectGuard={composerKeys.onSelectGuard}
        overlays={
          // agents-teams P1 §3.2 $/# 引用面板(链首=与 @/+/命令面板互斥;R4 插入 `$id `/`#id `
          // 尾随空格即终态,无记账;光标钉插入 token 后沿——G14.211 同款)
          refPal !== null && refPanelItems !== null ? (
            <RefPalette
              items={refPanelItems}
              emptyHint={
                refEntries.agents.length === 0 && refEntries.teams.length === 0
                  ? t(
                      'No registered sub-agents or teams yet — create them in Settings → Agents / Agent Teams, then reference here with $ or #',
                      '尚无在册子智能体/团队 — 在 设置 → 智能体 / 智能体团队 创建后，即可在此 $ 引用 / # 拉队',
                    )
                  : t('No matching entry', '无匹配条目')
              }
              active={Math.max(0, Math.min(refActive, refPanelItems.length - 1))}
              onHover={setRefActive}
              onPick={(item) => {
                const from = refPal.from;
                const end = from + 1 + refPal.query.length;
                // 分隔符守卫(2026-11-05):锚位前贴着 ⟧(芯片尾沿,无空白)时补半角空格——
                // 否则 $id/#id 直接粘在芯片后,tokenizer (^|\s) 不识别=引用渲染成白文
                setInput((prev) => {
                  const head = prev.slice(0, from);
                  const sep = head !== '' && /\S$/.test(head) ? ' ' : '';
                  return head + sep + `${item.sym}${item.id} ` + prev.slice(Math.max(end, from));
                });
                setRefPal(null);
                inputRef.current?.focus();
                requestAnimationFrame(() => {
                  const ta = inputRef.current;
                  if (ta === null) return;
                  const to = Math.min(from + item.id.length + 2, ta.value.length);
                  ta.setSelectionRange(to, to);
                });
              }}
            />
          ) : // G14.121 @ 文件面板(此前数据链在而渲染面缺失——@ 弹窗从未出现的根因):命中才渲染;
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
                // 2026-11-05 用户裁定:+面板智能体/团队区插整 token(`$id `/`#id `)——与命令/技能
                // 行同款落文本即收,不再有裸符号触发行(引用面板交给输入触发)
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
                // 分隔符守卫(2026-11-05):落点前贴着 ⟧(芯片尾沿,透明不显)时补半角空格——
                // 芯片后落选 /cmd 即粘成 ⟧/cmd,tokenizer (^|\s) 不识别=「文本后面的技能
                // 无法识别成命令蓝色」根因之二
                const head = input.slice(0, from);
                const sep = head !== '' && /\S$/.test(head) ? ' ' : '';
                setInput(head + sep + item.cmd + ' ' + input.slice(caret));
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
            sendLoading={awaitModelSince !== null}
            terminalDockEnabled={terminalDockEnabled}
            onToggleDock={() => setDockOpen((v) => !v)}
          />
        }
        />
        )
        }
      </div>
      {/* 2026-11-10 终端下栏改版(用户六条):主对话对等区(.sx-main 直子,非 chat-dock 内——主对话滚条
         bottom 让位不再盖进下栏)——分割线+拖动条(侧栏分割条同款横置)+页签条(侧栏页签同形条形)。
         标签 × 走 App 既有 kill 链,面板 × 只收显不 kill——重开经 ptyIdFor 同 uid 重连 replay 还原 */}
      {terminalDockEnabled && dockOpen && ptyIdFor !== undefined && onPtyAllocated !== undefined && onCloseDockTab !== undefined && (
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
      </LiveChangesContext.Provider>
    </MdImageContext.Provider>
    </DirResolverContext.Provider>
  );
}
