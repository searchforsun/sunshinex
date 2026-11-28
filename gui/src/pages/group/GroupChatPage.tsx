/**
 * Sunx 群聊页（2026-11-26 群组规格 §7；2026-11-27 样式重做）：主区覆盖层、无右侧页签栏。
 * 消息面完全复用会话件——主人=UserEntryView 用户气泡右对齐，Sunx=同一件左对齐变体
 * （来源行/发送给/时间/复制/回复/送达动作全走会话样式）；输入面=chat-dock + ComposerCard；
 * 查询侧栏=sx-sidebar + sx-resizer + sx-search-*（可拖宽）。房间数据靠 seq 游标轮询。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, CompositionEvent, CSSProperties, FormEvent, MouseEvent as ReactMouseEvent, MutableRefObject, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ArrowUp, Check, ChevronDown, Copy, CornerUpLeft, KanbanSquare, MessagesSquare, MoreHorizontal, PanelLeft, Search, Users, X,
} from 'lucide-react';
import { NavButtons } from '../../NavButtons';
import type { NavControls } from '../../nav-history';
import type { Connection } from '../../connection';
import type {
  SunxGroupDetail, SunxGroupMemberRow, SunxGroupSearchHit, SunxRoomMessage, SunxRoomPeerRef, SunxRoomTarget,
} from '../../connection-types';
import type { GuiAskReq } from '../../connection-types';
import type { ChatEntry } from '../../chat-reducer';
import { AskCard, pickAnswered, type AskPick } from '../chat/PendingCards';
import { t, useLanguage } from '../../i18n';
import { SunxIcon } from '../../sunx-icon';
import { MarkdownCached, mdComponentsPlain, ModeIcon } from '../Chat';
import { UserEntryView, baseModelName } from '../chat/EntryViews';
import { ImageLightbox } from '../../ImageLightbox';
import { NewSunxDialog } from '../../welcome/NewSunxDialog';
import { SunxBoardTab } from '../../tabs/SunxBoardTab';
import { ComposerPlusPanel } from '../../composer/ComposerPlusPanel';
import { ComposerCard } from '../../composer/ComposerCard';
import { ModeMenu, sessionModeLabel } from '../../composer/mode-menu';
import { CommandPalette, type CmdItem } from '../../CommandPalette';
import { useCommandPalette, slashItemsFor } from '../chat/use-command-palette';
import {
  RefPalette, atomicRangeOver, expandRefContents, groupMentionTokenSpans, hasMentionTokens, renderMentionSpans,
  slashTokenAt, splitMentionTokenSpans, tokenDeleteRangeOver, tokenGuardVerdictOver, tokenSpanAtOver,
} from '../chat/mention';
import { refTokenAt, refPanelItems as buildRefPanelItems, refPickLabel, expandRefNames, unknownRefTokens } from '../chat/ref-palette';
import type { RefItem, RefPal } from '../chat/ref-palette';
import { useRefCatalog } from '../chat/use-chat-ref-entries';
import { SelActionsOverlay } from '../chat/SelActionsOverlay';
import { EffortChip, EffortSlider } from '../../effort-slider';
import { chaseScrollBottom, insertRefPick } from '../../ui-util';
import { PlusAddIcon } from '../../sidebar/project-menu-util';
import { MAX_IMAGES, loadImages } from '../../images';
import { MIN_TAB_WIDTH } from '../../tabs/tab-state';
import { MAIN_MIN_WIDTH, chatMaxFor } from '../../thread-width';
import { zoomScale } from '../../ui-zoom';

const GROUPS_CHANGED_EVENT = 'sunx-groups-changed';
/** 群草稿驻留（2026-11-28 五轮移植主对话「切会话草稿不丢」）：模块级按 groupId 存 input/images
 *  （App 生命周期内,驻留座同口径）；切群/关页再回不丢草稿，提交通后由保活 effect 落空值。 */
const groupDrafts = new Map<string, { input: string; images: string[] }>();
/** 群聊专用控制命令（2026-11-27）：/stop 暂停对应 Sunx、/clear 清其排队、/continue 恢复队列。
 *  不并进普通会话 supported；群页 supported 取 daemon 列表后再并这三条。 */
const SUNX_GROUP_COMMANDS = ['/stop', '/clear', '/continue'] as const;
const DESTRUCTIVE = new Set(['/delete', '/skills-rm', '/memory-rm', '/memory-gc']);
/** Sunx 无计划模式闭环（2026-11-27 用户裁定）：/plan 不进群命令/面板 */
const SUNX_EXCLUDED_COMMANDS = ['/plan'] as const;
type AskAnswer = Parameters<Connection['replyAsk']>[1];

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

interface GroupChatPageProps {
  conn: Connection;
  groupId: string;
  onClose: () => void;
  onOpenMember: (journalId: string) => void;
  onOpenSession: (sessionId: string, root: string) => void;
  onError: (message: string) => void;
  searchOpen: boolean;
  onSearchClose: () => void;
  /** 群聊顶栏查询入口（⋯ 右侧，避开顶栏覆盖窗控簇的点击区） */
  onToggleSearch?: () => void;
  /** 菜单关闭态呼出簇（2026-11-28 五轮裁定「群组[页开]左侧菜单关闭没有《》【|】」）：群页盖住
   *  会话顶栏的导航/菜单钮,页内自备同簇——nav=导航钮对,onToggleMenu=【|】重开菜单 */
  menuClosed?: boolean;
  onToggleMenu?: () => void;
  nav?: NavControls;
}

export function GroupChatPage(props: GroupChatPageProps): JSX.Element {
  useLanguage();
  const { conn, groupId, onClose, onOpenMember, onOpenSession, onError, searchOpen, onSearchClose, onToggleSearch, menuClosed, onToggleMenu, nav } = props;
  const [detail, setDetail] = useState<SunxGroupDetail | null>(null);
  const [messages, setMessages] = useState<SunxRoomMessage[]>([]);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 瞬态提示（2026-11-28 五轮移植主对话 showImgHint 同语义）：未知引用等非阻断信息,4s 自隐 */
  const [hint, setHint] = useState('');
  const [input, setInput] = useState('');
  const [mentions, setMentions] = useState<SunxRoomTarget[]>([]);
  const [mentionAll, setMentionAll] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: string; preview: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [supported, setSupported] = useState<string[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionFrom, setMentionFrom] = useState<number | null>(null);
  /** Sunx 面板（2026-11-27 用户裁定「群隔离，只保留群聊顶栏这一个入口」）：右侧栏复用
   *  SunxBoardTab（groupId 过滤=本群成员），与查询侧栏互斥。 */
  const [sunxPanelOpen, setSunxPanelOpen] = useState(false);
  const [newSunxOpen, setNewSunxOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  /** 复制群主 ID 原地回执（2026-11-28 四轮裁定）：Copy→Check 1.2s,替代底部 sx-toast */
  const [ownerCopied, setOwnerCopied] = useState(false);
  const [lightbox, setLightbox] = useState<string | undefined>(undefined);
  const [searchQ, setSearchQ] = useState('');
  const [searchHits, setSearchHits] = useState<SunxGroupSearchHit[]>([]);
  /** 查询侧栏宽度=项目右栏同款可拖宽件（2026-11-27 用户裁定「查询侧栏，动态调整宽度」） */
  const [searchWidth, setSearchWidth] = useState(420);
  /** SUNX 面板宽度（2026-11-28 三轮裁定「拖动侧栏宽度要加回来」）：与查询侧栏同一 .sx-resizer 件 */
  const [sunxPanelWidth, setSunxPanelWidth] = useState(360);
  const [activeSeq, setActiveSeq] = useState<number | null>(null);
  /** 回到底部钮显隐（2026-11-28 三轮裁定「发送按钮正上方要有回到底部按钮」）：非贴底(80px 同主对话)即显 */
  const [atBottom, setAtBottom] = useState(true);
  /** 「+」面板（2026-11-27 用户裁定「+ 中去掉文件，其他都可以」）：ComposerPlusPanel 无 session/root
   *  → 文件区天然不渲染；图片附件/命令/技能/子智能体/团队保留 */
  const [plusOpen, setPlusOpen] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  /** 模型/权限选择（2026-11-27 用户裁定）：空串=跟随成员；发送时随 body 透传，daemon 逐个 set */
  const [models, setModels] = useState<Array<{ id: string; model: string }>>([]);
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<'' | 'read-only' | 'acceptEdits' | 'full-access'>('');
  /** 模型/权限 pill 弹层（2026-11-27 二轮裁定：换主对话同件——ModeMenu 富行弹层） */
  const [settingsPop, setSettingsPop] = useState<'model' | 'mode' | null>(null);
  /** 思考强度（2026-11-28 三轮裁定「模型选择怎么没有强度选择条」）：''=跟随成员各档（不透传），
   *  具体档随发送 body 逐目标 setEffort；滑条共享主对话 EffortSlider。 */
  const [effort, setEffort] = useState('');
  /** 「/」面板外点收口闸（2026-11-28 三轮裁定「点击其他地方自动关闭，再次点击输入框再显示」）：
   *  面板项由输入内容派生，外点关闭后需隐蔽闸；输入框点击/继续输入即复位重开。 */
  const [slashHidden, setSlashHidden] = useState(false);
  /** $/# 引用面板（2026-11-28 三轮裁定「# $ 也要提示和 chip」）：目录=useRefCatalog(catalog-only)，
   *  触发/过滤/插入复用 ref-palette 单点；群 send 前按目录 expandRefNames 还原 id。 */
  const [refPal, setRefPal] = useState<RefPal | null>(null);
  const [refActive, setRefActive] = useState(0);
  const { refEntries, loadRefEntries, refEntriesLoadedRef } = useRefCatalog({ conn });
  const refItems = useMemo(
    () => (refPal === null ? null : buildRefPanelItems(refEntries, refPal.query, refPal.sym)),
    [refPal, refEntries],
  );
  /** 群内 ask 卡（2026-11-27）：与成员会话同一 pending；选择态按 pid 收 */
  const [askPicks, setAskPicks] = useState<Record<string, AskPick>>({});
  /** 「/」面板（2026-11-27 二轮裁定「换成主对话的，分命令/技能，命令带说明」）：复用
   *  useCommandPalette 数据面 + CommandPalette 渲染件；群控制命令并入、/plan 排除。 */
  const { cmdData, cmdActive, setCmdActive, skills, reloadSkills } = useCommandPalette(conn);
  /** 主对话同源动态限宽（2026-11-27 二轮裁定「输入框用主对话动态三级宽度」）：
   *  群主列不在 .sx-main 内，App 的 RO 写不到——本列自挂同一 chatMaxFor 阶梯 RO。 */
  const mainRef = useRef<HTMLDivElement | null>(null);

  const cursorRef = useRef(0);
  const messagesRef = useRef<SunxRoomMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLElement | null>(null);
  const nodeBySeq = useRef(new Map<number, HTMLDivElement>());
  const atBottomRef = useRef(true);
  const sunxPanelRef = useRef<HTMLElement | null>(null);

  useEffect(() => { cursorRef.current = cursor; }, [cursor]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // 瞬态提示自隐（4s）
  useEffect(() => {
    if (hint === '') return;
    const id = window.setTimeout(() => setHint(''), 4000);
    return () => window.clearTimeout(id);
  }, [hint]);

  const mergeMessages = useCallback((incoming: SunxRoomMessage[], reset: boolean): void => {    if (reset) {
      setMessages(incoming);
      return;
    }
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) map.set(m.id, m);
      return [...map.values()].sort((a, b) => a.seq - b.seq);
    });
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    try {
      const r = await conn.sunxGroupMessages(groupId, { after: cursorRef.current });
      if (r.reset === true) {
        mergeMessages(r.messages, true);
      } else if (r.messages.length > 0) {
        mergeMessages(r.messages, false);
      }
      setCursor(r.cursor);
      cursorRef.current = r.cursor;
      setHasMore((v) => (r.reset === true ? r.hasMore : v));
    } catch (e) {
      if (!searchOpen) setError(e instanceof Error ? e.message : String(e));
    }
  }, [conn, groupId, mergeMessages, searchOpen]);

  const loadInitial = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const [d, r] = await Promise.all([
        conn.sunxGroupDetail(groupId),
        conn.sunxGroupMessages(groupId, { limit: 200 }),
      ]);
      setDetail(d);
      setMessages(r.messages);
      setCursor(r.cursor);
      cursorRef.current = r.cursor;
      setHasMore(r.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [conn, groupId]);

  useEffect(() => {
    setDetail(null);
    setMessages([]);
    setCursor(0);
    cursorRef.current = 0;
    setHasMore(false);
    setActiveSeq(null);
    nodeBySeq.current.clear();
    setPlusOpen(false);
    setModel('');
    setMode('');
    // 草稿驻留（2026-11-28 五轮）：回群恢复上次的输入与图片（提交通后 effect 落空值）
    const draft = groupDrafts.get(groupId);
    setInput(draft?.input ?? '');
    setImages(draft?.images ?? []);
    void loadInitial();
    void conn.commands().then(
      (r) => setSupported([...new Set([...r.supported, ...SUNX_GROUP_COMMANDS])].filter((c) => c !== '/plan')),
      () => setSupported([...SUNX_GROUP_COMMANDS]),
    );
    void conn.models().then((r) => setModels(r.choices), () => setModels([]));
  }, [conn, groupId, loadInitial]);

  // 草稿保活（与上行恢复配对）：输入/图片变化即落驻留表（切群/关页再回不丢）
  useEffect(() => {
    groupDrafts.set(groupId, { input, images });
  }, [groupId, input, images]);

  // 成员状态（running/awaiting）刷新：ask_question 挂起在成员会话，群页据此弹同一张 ask 卡并跳转
  useEffect(() => {
    const id = window.setInterval(() => {
      void conn.sunxGroupDetail(groupId).then((d) => setDetail(d), () => undefined);
    }, 1500);
    return () => window.clearInterval(id);
  }, [conn, groupId]);

  const addImages = useCallback(async (files: File[]): Promise<void> => {
    const loaded = await loadImages(files);
    if (loaded.length === 0) return;
    // 超限提示（2026-11-28 五轮移植主对话）：静默截断改提示行（warn 槽,发信即清）
    if (images.length + loaded.length > MAX_IMAGES) {
      setError(t(`Up to ${MAX_IMAGES} images per message`, `每条消息最多 ${MAX_IMAGES} 张图片`));
    }
    setImages((prev) => [...prev, ...loaded].slice(0, MAX_IMAGES));
  }, [images]);

  useEffect(() => {
    const id = window.setInterval(() => { void poll(); }, 1500);
    const onFocus = (): void => { void poll(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [poll]);

  useEffect(() => {
    if (!searchOpen) return;
    setSunxPanelOpen(false); // 查询侧栏与 Sunx 面板共用右缘，查询打开即收面板
    window.setTimeout(() => searchInputRef.current?.focus(), 30);
  }, [searchOpen]);

  // 主对话同源动态限宽：群主列实时宽经 chatMaxFor 阶梯落 --chat-max（流区/输入卡同令）
  useEffect(() => {
    const el = mainRef.current;
    if (el === null) return;
    const apply = (w: number): void => { el.style.setProperty('--chat-max', `${Math.round(chatMaxFor(w))}px`); };
    apply(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) apply(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 「/」面板开合沿触发一次技能现拉（开→开不打扰；与 + 面板每次现拉同口径）
  const slashWasOpenRef = useRef(false);
  useEffect(() => {
    const open = slashTokenAt(input, inputRef.current?.selectionStart ?? input.length) !== null;
    if (open && !slashWasOpenRef.current) reloadSkills();
    slashWasOpenRef.current = open;
  }, [input, reloadSkills]);

  // 新消息在底部时跟随；否则保留位置（新消息胶囊由下方滚动条/轮询自然出现）
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
    setAtBottom(near);
  }, []);

  const loadOlder = useCallback(async (): Promise<void> => {
    const first = messagesRef.current[0];
    if (first === undefined || !hasMore) return;
    try {
      const r = await conn.sunxGroupMessages(groupId, { before: first.seq, limit: 200 });
      setMessages((prev) => [...r.messages, ...prev]);
      setHasMore(r.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [conn, groupId, hasMore]);

  /** 按 seq 定位；不在已加载窗口时先向前拉一页（搜索/引用跳转共用）。
   *  2026-11-28 四轮裁定：高亮只染气泡（CSS 作用域收窄）+ 3 秒自灭（timerRef 单点,连跳先清）。 */
  const jumpTimerRef = useRef<number | undefined>(undefined);
  const revealSeq = useCallback(async (seq: number): Promise<void> => {
    const go = (): void => {
      const node = nodeBySeq.current.get(seq);
      if (node === undefined) return;
      node.scrollIntoView({ block: 'center', behavior: 'auto' });
      setActiveSeq(seq);
      window.clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = window.setTimeout(() => setActiveSeq((cur) => (cur === seq ? null : cur)), 3000);
    };
    if (messagesRef.current.some((m) => m.seq === seq)) {
      go();
      return;
    }
    try {
      const r = await conn.sunxGroupMessages(groupId, { before: seq + 1, limit: 200 });
      if (r.messages.length > 0) {
        setMessages((prev) => {
          const map = new Map(prev.map((m) => [m.id, m]));
          for (const m of r.messages) map.set(m.id, m);
          return [...map.values()].sort((a, b) => a.seq - b.seq);
        });
        window.requestAnimationFrame(go);
      }
    } catch {
      // 定位失败不报错（旧消息已清理）
    }
  }, [conn, groupId]);

  const runSearch = useCallback(async (): Promise<void> => {
    const q = searchQ.trim();
    if (q === '') {
      setSearchHits([]);
      return;
    }
    try {
      const r = await conn.sunxGroupSearch(groupId, q, 50);
      setSearchHits(r.results);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [conn, groupId, onError, searchQ]);

  // 关键词活滤（2026-11-28 三轮裁定「还没有真正实现消息筛选，请排查」）：后端 /search 本就
  // 大小写不敏感子串匹配,GUI 此前仅 Enter 触发=看起来"不会筛"——改为输入即查（250ms 去抖），
  // Enter 仍立即；清词即清结果。
  useEffect(() => {
    if (!searchOpen) return;
    if (searchQ.trim() === '') {
      setSearchHits([]);
      return;
    }
    const id = window.setTimeout(() => { void runSearch(); }, 250);
    return () => window.clearTimeout(id);
  }, [searchQ, searchOpen, runSearch]);

  /** 侧栏拖宽（2026-11-28 三轮裁定「拖动侧栏宽度要加回来」）：SUNX 面板与查询侧栏共用——
   *  复用 .sx-resizer 命中件与会话右栏同款拖拽语义（向左拖变宽/直写 --sb-w/松手落 React 态） */
  const startPanelResize = useCallback((e: ReactMouseEvent<HTMLDivElement>, ref: MutableRefObject<HTMLElement | null>, width: number, setWidth: (v: number) => void): void => {
    e.preventDefault();
    const el = e.currentTarget;
    el.classList.add('active');
    const startX = e.clientX;
    const cap = (): number => window.innerWidth / zoomScale() - MAIN_MIN_WIDTH;
    let next = width;
    const onMove = (ev: MouseEvent): void => {
      next = Math.max(MIN_TAB_WIDTH, Math.min(cap(), width + (startX - ev.clientX) / zoomScale()));
      ref.current?.style.setProperty('--sb-w', `${next}px`);
    };
    const stop = (): void => {
      el.classList.remove('active');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      ref.current?.style.removeProperty('--sb-w');
      setWidth(next);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  }, []);

  const send = useCallback(async (): Promise<void> => {
    // 发送期展开链（2026-11-28 五轮移植主对话全链尾环）：$/# 名称→id（expandRefNames）+
    // ⟦片段⟧→正文/终端围栏（expandRefContents,注册表兜底）——圈选「添加到会话」的内容随
    // token 送达成员,不再以字面 ⟦文本片段N⟧ 占位符出站
    const text = expandRefContents(expandRefNames(input, refEntries), new Map());
    if ((text.trim() === '' && images.length === 0) || sending) return;
    // 未知引用提示（五轮移植主对话 R5,不拦截不改写原文照发）：目录已拉过且有候选才对照
    if (refEntriesLoadedRef.current && (refEntries.agents.length > 0 || refEntries.teams.length > 0)) {
      const unknown = unknownRefTokens(text, refEntries);
      if (unknown.length > 0) {
        setHint(t('No registered match for {tokens} — sent as-is', '{tokens} 未匹配到在册条目——已按原文发送').replace('{tokens}', unknown.join(' ')));
      }
    }
    const token = text.trim().split(/\s+/)[0] ?? '';
    const isCommand = supported.includes(token);
    if (isCommand && images.length > 0) {
      setError(t('Commands do not accept images', '命令不能附带图片'));
      return;
    }
    if (isCommand && DESTRUCTIVE.has(token) && (mentionAll || mentions.length !== 1)) {
      setError(t('Destructive commands require exactly one member (not @all)', '破坏性命令只允许单个成员执行（不能 @全体/多选）'));
      return;
    }
    if (isCommand && mentions.length === 0 && !mentionAll) {
      setError(t('Select at least one member to run a command', '选择至少一个成员执行命令'));
      return;
    }
    const liveMentions = mentions.filter((m) => text.includes(`@${m.name}`));
    const liveAll = mentionAll && text.includes('@全体成员');
    setSending(true);
    setError('');
    try {
      await conn.sunxGroupSend(groupId, {
        text,
        ...(images.length > 0 ? { images } : {}),
        ...(liveMentions.length > 0 ? { mentions: liveMentions.map((m) => m.id) } : {}),
        ...(liveAll ? { mentionAll: true } : {}),
        ...(replyTo !== null ? { replyTo: replyTo.id } : {}),
        ...(model !== '' ? { model } : {}),
        ...(effort !== '' ? { effort } : {}),
        ...(mode !== '' ? { mode } : {}),
        clientMsgId: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      });
      setInput('');
      setMentions([]);
      setMentionAll(false);
      setImages([]);
      setReplyTo(null);
      atBottomRef.current = true;
      window.setTimeout(() => { void poll(); }, 80);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onError(msg);
    } finally {
      setSending(false);
    }
  }, [conn, groupId, effort, images, input, mentionAll, mentions, mode, model, onError, poll, refEntries, replyTo, sending, supported]);

  const rename = useCallback(async (): Promise<void> => {
    const name = nameDraft.trim();
    if (name === '') return;
    try {
      const r = await conn.renameSunxGroup(groupId, name);
      setDetail((d) => (d === null ? d : { ...d, group: { ...d.group, name: r.group.name } }));
      setNameOpen(false);
      window.dispatchEvent(new CustomEvent(GROUPS_CHANGED_EVENT));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [conn, groupId, nameDraft, onError]);

  const members = detail?.members ?? [];
  const mentionCandidates = useMemo(() => {
    const q = mentionQuery.trim().toLowerCase();
    return members.filter((m) => q === '' || m.name.toLowerCase().includes(q));
  }, [members, mentionQuery]);
  /** 守卫区间双源（2026-11-28 五轮移植主对话 token 原子性/IME/归位链）：通用 token（/命令·$
   *  成员·#团队·⟦片段⟧）+ 群 @成员/@全体成员（CJK 名不在通用词法内），合并成一份有序区间。 */
  const guardSpans = useCallback((text: string): Array<{ s: number; e: number }> => [
    ...splitMentionTokenSpans(text),
    ...groupMentionTokenSpans(text, members.map((m) => m.name)),
  ], [members]);
  const composingRef = useRef(false);
  /** IME 组字范围（2026-11-28 五轮移植）：三拍回抛,高亮层把与范围交叠的 chip 压平为普通段 */
  const [compRange, setCompRange] = useState<{ start: number; end: number } | null>(null);
  const compRangeRef = useRef<{ start: number; end: number } | null>(null);
  const setCompRangeGuarded = useCallback((r: { start: number; end: number } | null): void => {
    const prev = compRangeRef.current;
    if (prev === null ? r === null : r !== null && prev.start === r.start && prev.end === r.end) return;
    compRangeRef.current = r;
    setCompRange(r);
  }, []);
  const onCompositionGuard = useCallback((e: CompositionEvent<HTMLTextAreaElement>): void => {
    composingRef.current = true;
    const ta = e.currentTarget;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    const [as, ae] = atomicRangeOver(s, en, guardSpans(input));
    if (as !== s || ae !== en) e.preventDefault();
  }, [guardSpans, input]);
  const onCompositionEndGuard = useCallback((): void => {
    composingRef.current = false;
  }, []);
  const onBeforeInputGuard = useCallback((e: FormEvent<HTMLTextAreaElement>): void => {
    const native = e.nativeEvent as InputEvent;
    const ta = e.currentTarget;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    const v = tokenGuardVerdictOver(s, en, native.inputType ?? '', guardSpans(input));
    if (v.action === 'redirectEnd') {
      e.preventDefault();
      ta.setSelectionRange(v.to, v.to);
    } else if (v.action === 'splice') {
      e.preventDefault();
      setInput((prev) => prev.slice(0, v.s) + prev.slice(v.e));
      requestAnimationFrame(() => ta.setSelectionRange(v.s, v.s));
    }
  }, [guardSpans, input]);
  const onPasteGuard = useCallback((e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const ta = e.currentTarget;
    const s = ta.selectionStart ?? 0;
    const en = ta.selectionEnd ?? 0;
    const [as, ae] = atomicRangeOver(s, en, guardSpans(input));
    if (as !== s || ae !== en) {
      e.preventDefault();
      ta.setSelectionRange(ae, ae);
    }
  }, [guardSpans, input]);
  const onSelectGuard = useCallback((): void => {
    // G14.213 光标不落 token 中间:原生移动后的兜底归位(←→ 在 keydown 已跨 token);IME 组合中跳过
    if (composingRef.current) return;
    const ta = inputRef.current;
    if (ta === null) return;
    const v = ta.value;
    if (!v.includes('@') && !v.includes('⟦') && !v.includes('/') && !v.includes('$') && !v.includes('#')) return;
    const s = ta.selectionStart ?? 0;
    if ((ta.selectionEnd ?? s) !== s) return;
    const span = tokenSpanAtOver(s, guardSpans(v));
    if (span !== null) ta.setSelectionRange(span[1], span[1]);
  }, [guardSpans]);
  /** 「/」面板项（主对话同件）：群支持集 = daemon supported ∪ 群控制命令 − /plan；
   *  2026-11-28 五轮移植 caret 级触发——slashTokenAt(input, caret)（行首=命令+技能,行中=技能池,
   *  主对话同式）；@ 令牌在场即收口（同一 caret 前缀互斥）。
   *  2026-11-28 三轮实机排查「/stop 不弹面板」：daemon /commands 清单（SLASH_COMMANDS）无群控制
   *  三条，仅并 supported 不够——commands 清单一并并入（jsdom 桩含清单曾遮住此洞）。 */
  const slashItems = useMemo<CmdItem[] | null>(() => {
    const caret = inputRef.current?.selectionStart ?? input.length;
    const atMatch = /(^|\s)@([^\s@]*)$/.exec(input.slice(0, caret));
    const token = atMatch === null ? slashTokenAt(input, caret) : null;
    if (token === null) return null;
    const excluded = SUNX_EXCLUDED_COMMANDS as readonly string[];
    const merged: typeof cmdData = cmdData === null ? null : {
      commands: [...new Set([...cmdData.commands, ...SUNX_GROUP_COMMANDS])].filter((c) => !excluded.includes(c)),
      // 说明不走此处——CommandPalette.cmdDescOf 对 stop/clear/continue 有权威双语条目(渲染期覆盖)
      descriptions: cmdData.descriptions,
      supported: [...new Set([...cmdData.supported, ...SUNX_GROUP_COMMANDS])].filter((c) => !excluded.includes(c)),
    };
    const items = slashItemsFor(merged, token, skills);
    return items.length > 0 ? items : null;
  }, [cmdData, input, skills]);
  const slashActive = Math.min(cmdActive, Math.max(0, (slashItems?.length ?? 1) - 1));
  const pickSlash = useCallback((item: CmdItem): void => {
    if (!item.ok) return;
    // caret 级插入（2026-11-28 五轮移植主对话同式）：token 起点替换+分隔符守卫+尾段保留
    const caret = inputRef.current?.selectionStart ?? input.length;
    const tok = slashTokenAt(input, caret);
    const from = tok !== null ? tok.from : input.length;
    const head = input.slice(0, from);
    const sep = head !== '' && /\S$/.test(head) ? ' ' : '';
    setInput(head + sep + item.cmd + ' ' + input.slice(caret));
    setMentions([]);
    setMentionAll(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [input]);
  const pickRef = useCallback((item: RefItem): void => {
    if (refPal === null) return;
    // 插名称而非 id（主对话同口径,用户不感知 id）；群 send 前 expandRefNames 按目录还原 id
    insertRefPick(setInput, {
      sym: item.sym,
      label: refPickLabel(item),
      atFrom: refPal.from,
      queryLen: refPal.query.length,
      close: () => setRefPal(null),
      pinTo: () => inputRef.current,
    });
  }, [refPal]);
  /** 输入框点击（2026-11-28 三轮裁定「再次点击输入框再显示」）：按点击落点 caret 重估三面板——
   *  行首 / 令牌=重开 / 面板,@ 令牌=重开 @ 面板,$/# 令牌=重开引用面板;均不命中=收口。 */
  const onInputClick = useCallback((): void => {
    const ta = inputRef.current;
    const caret = ta?.selectionStart ?? input.length;
    const v = input;
    if (slashTokenAt(v, caret) !== null) setSlashHidden(false);
    const m = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
    if (m !== null) {
      setMentionOpen(true);
      setMentionQuery(m[2] ?? '');
      setMentionFrom(caret - (m[2]?.length ?? 0) - 1);
      setRefPal(null);
      return;
    }
    const rt = refTokenAt(v, caret);
    if (rt !== null) {
      setMentionOpen(false);
      setMentionFrom(null);
      setRefPal(rt);
      setRefActive(0);
      loadRefEntries();
      return;
    }
    setMentionOpen(false);
    setMentionFrom(null);
    setRefPal(null);
  }, [input, loadRefEntries]);
  /** 弹层外点自关（2026-11-28 三轮裁定「点击其他地方应该自动关闭弹窗」）：+ / @ / / 命令 /
   *  模型 / 权限 / ⋯ 菜单,点页面其它处一律收口。弹层本体与开关锚（foot pills、⋯、输入框）
   *  内 mousedown 不接管——行点击与「再点开关收口」的原语义不受扰。 */
  const popsOpen = menuOpen || plusOpen || mentionOpen || settingsPop !== null
    || (slashItems !== null && !slashHidden)
    || refPal !== null;
  useEffect(() => {
    if (!popsOpen) return;
    const onDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el === null) return;
      if (el.closest('.sx-menu-pop, .mode-pop, .proj-pop, .cmd-palette, .ref-palette, .sx-plus-panel, .sx-composer-foot, .sx-composer-inputwrap, .sx-group-more-wrap') !== null) return;
      setMenuOpen(false);
      setPlusOpen(false);
      setMentionOpen(false);
      setSettingsPop(null);
      setSlashHidden(true);
      setRefPal(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popsOpen]);
  /** 输入框高亮层（2026-11-27 二轮 chip + 2026-11-28 三轮补全 + 五轮守卫适配）：群 @成员/
   *  @全体成员 令牌按主对话 file 芯片同手法（原文 @ 透明保字宽,图标绝对定位落 @ 位）；其余段交
   *  主对话 renderMentionSpans(composer 形态)。五轮两处升级——①IME 组字段交叠的 chip 压平为
   *  普通段（textarea 恒透明,组字串由叠层绘制,芯片不再随组字消失）；②成员 chip 可点击跳成员
   *  会话（@全体成员 无跳转面,点击无害）。纯文本段不包 span（层与 textarea 同为逐字排版）。 */
  const renderGroupHighlight = useCallback((text: string): ReactNode => {
    const rest = (seg: string, key: React.Key, overlap: boolean): ReactNode => (
      <Fragment key={key}>{!overlap && hasMentionTokens(seg) ? renderMentionSpans(seg, undefined, undefined, undefined, true, compRange) : seg}</Fragment>
    );
    const tokens = [...(text.includes('@全体成员') ? ['@全体成员'] : []), ...members.map((m) => `@${m.name}`)]
      .sort((a, b) => b.length - a.length);
    if (tokens.length === 0) {
      return hasMentionTokens(text) ? renderMentionSpans(text, undefined, undefined, undefined, true, compRange) : undefined;
    }
    const escaped = tokens.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'g'));
    if (!parts.some((p) => tokens.includes(p))) {
      return hasMentionTokens(text) ? renderMentionSpans(text, undefined, undefined, undefined, true, compRange) : undefined;
    }
    let off = 0;
    return parts.map((part, i) => {
      const start = off;
      off += part.length;
      const overlap = compRange !== null && start < compRange.end && off > compRange.start;
      if (tokens.includes(part) && !overlap) {
        const member = part === '@全体成员' ? undefined : members.find((m) => `@${m.name}` === part);
        return (
          <span
            key={i}
            className="hn hn-file sx-group-chip-link"
            onClick={(e) => {
              e.stopPropagation();
              if (member !== undefined) onOpenMember(member.id);
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <span className="hn-file-ico" aria-hidden="true">
              {part === '@全体成员' ? <Users size={14} strokeWidth={1.75} /> : <SunxIcon size={14} strokeWidth={1.75} />}
            </span>
            <span className="hn-file-at" aria-hidden="true">@</span>
            {part.slice(1)}
          </span>
        );
      }
      return rest(part, i, overlap);
    });
  }, [members, compRange, onOpenMember]);
  /** 底栏 pill 文案（空串=跟随成员；模型名按聊天同款短名收敛） */
  const modelLabel = model === ''
    ? t('Follow members', '跟随成员')
    : (models.find((m) => m.id === model)?.model || baseModelName(model));
  const modeLabel = mode === '' ? t('Follow members', '跟随成员') : sessionModeLabel(mode);
  /** 群消息 → 会话 ChatEntry（2026-11-27 样式重做）：主人/成员都走 UserEntryView 用户气泡；
   *  成员来源由 fromSunx 归因行承载（与跨 Sunx 消息同一件），正文/回执/回复走扩展槽。 */
  const entryOf = useCallback((m: SunxRoomMessage): ChatEntry => ({
    key: m.id,
    kind: 'user',
    md: m.text,
    ts: m.ts,
    ...(m.images !== undefined && m.images.length > 0 ? { images: m.images } : {}),
    ...(m.kind !== 'human' || m.from.kind === 'sunx'
      ? { fromSunx: { id: m.from.id, name: m.from.name } }
      : {}),
  }), []);
  const messageById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  /** 群页 ask 卡：来源成员 + 与成员会话同一 pid（回答走 /ask/:pid/reply，两边同步） */
  const askItems = useMemo<Array<{ pid: string; req: GuiAskReq; member: SunxGroupMemberRow }>>(
    () => members.flatMap((member) => (member.asks ?? []).map((a) => ({ pid: a.pid, req: a.req, member }))),
    [members],
  );
  const setAskPick = useCallback((pid: string, patch: Partial<AskPick>): void => {
    setAskPicks((prev) => ({ ...prev, [pid]: { ...(prev[pid] ?? { labels: [], custom: '' }), ...patch } }));
  }, []);
  const dropAsk = useCallback((pid: string): void => {
    setAskPicks((prev) => {
      const next = { ...prev };
      delete next[pid];
      return next;
    });
    setDetail((prev) => prev === null ? prev : {
      ...prev,
      members: prev.members.map((m) => (m.asks?.some((a) => a.pid === pid) === true
        ? { ...m, asks: m.asks!.filter((a) => a.pid !== pid) }
        : m)),
    });
  }, []);
  const answerAsk = useCallback(async (pid: string, answer: AskAnswer): Promise<void> => {
    try {
      await conn.replyAsk(pid, answer);
      dropAsk(pid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 404=已在成员会话里回答/已过期：撤卡即可；其余真错误保留卡并提示
      if (msg.includes('404')) dropAsk(pid);
      else onError(msg);
    }
  }, [conn, dropAsk, onError]);
  const submitAsk = useCallback((item: { pid: string }): void => {
    const pick = askPicks[item.pid] ?? { labels: [], custom: '' };
    const custom = pick.custom.trim();
    if (custom !== '') { void answerAsk(item.pid, { type: 'custom', text: custom }); return; }
    if (pick.labels.length > 0) void answerAsk(item.pid, { type: 'selected', labels: pick.labels });
  }, [answerAsk, askPicks]);

  const addMention = useCallback((m: SunxGroupMemberRow): void => {
    setMentions((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, { id: m.id, name: m.name }]));
    setMentionAll(false);
    const token = `@${m.name} `;
    setInput((v) => {
      if (mentionFrom !== null) return `${v.slice(0, mentionFrom)}${token}${v.slice(mentionFrom + 1 + mentionQuery.length)}`;
      return `${v}${v === '' || v.endsWith(' ') ? '' : ' '}${token}`;
    });
    setMentionOpen(false);
    setMentionFrom(null);
    setMentionQuery('');
  }, [mentionFrom, mentionQuery]);
  const addAll = useCallback((): void => {
    setMentions([]);
    setMentionAll(true);
    const token = '@全体成员 ';
    setInput((v) => {
      if (mentionFrom !== null) return `${v.slice(0, mentionFrom)}${token}${v.slice(mentionFrom + 1 + mentionQuery.length)}`;
      return `${v}${v === '' || v.endsWith(' ') ? '' : ' '}${token}`;
    });
    setMentionOpen(false);
    setMentionFrom(null);
    setMentionQuery('');
  }, [mentionFrom, mentionQuery]);

  return (
    <div className={`sx-group-page${searchOpen ? ' searching' : ''}${sunxPanelOpen ? ' paneled' : ''}`} aria-label={t('Group chat', '群聊')}>
      <div className="sx-group-main" ref={mainRef}>
        <header className="chat-topbar sx-group-topbar" data-drag-band>
          {/* 菜单关闭态呼出簇（2026-11-28 五轮裁定）：《》导航钮对+【|】重开菜单——群页盖住
              会话顶栏（menu-occ=0 时连呼出钮簇一并盖住）,页内自备同簇（欢迎页 sx-welcome-nav 同构） */}
          {menuClosed === true && onToggleMenu !== undefined && nav !== undefined && (
            <span className="sx-group-nav">
              <NavButtons nav={nav} />
              <button
                type="button"
                className="sx-winbtn sx-menu-reopen"
                aria-label="toggle menu"
                data-tip={t('Open menu', '打开菜单')}
                onClick={onToggleMenu}
              >
                <PanelLeft size={16} strokeWidth={1.75} />
              </button>
            </span>
          )}
          {/* 顶栏（2026-11-27 用户裁定）：群图标+群名，⋯ 紧贴群名右侧；Sunx 面板/查询两钮
              固定窗控「—」左侧（.sx-group-topbar-right fixed），不随主列宽流动。 */}
          <span className="chat-title">
            <span className="sx-ws-folder" aria-hidden="true">
              <MessagesSquare size={16} strokeWidth={1.75} />
            </span>
            <span className="chat-title-text">{detail?.group.name ?? t('Group', '群组')}</span>
          </span>
          <span className="pill-anchor sx-group-more-wrap">
            <button type="button" className="sx-iconbtn sx-group-more-btn" aria-label="group menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              <MoreHorizontal size={16} strokeWidth={1.75} />
            </button>
            {menuOpen && (
              <div className="sx-menu-pop sx-group-more-pop" role="menu">
                <button type="button" role="menuitem" className="sx-menuitem" onClick={() => { setMenuOpen(false); setNewSunxOpen(true); }}>
                  <SunxIcon size={14} /> {t('New Sunx', '新建 SUNX')}
                </button>
                <button type="button" role="menuitem" className="sx-menuitem" onClick={() => { setMenuOpen(false); setNameDraft(detail?.group.name ?? ''); setNameOpen(true); }}>
                  <MessagesSquare size={14} strokeWidth={1.75} /> {t('Rename group', '编辑群名')}
                </button>
                {/* 复制群主 ID（2026-11-28 四轮裁定「不要下方 toast,和项目风格一样,前缀图标原地显√」）：
                    点击复制,前缀图标 Copy→Check 原地回执 1.2s */}
                <button type="button" role="menuitem" className="sx-menuitem" onClick={() => {
                  setMenuOpen(false);
                  const p = navigator.clipboard?.writeText(groupId);
                  if (p !== undefined) p.then(() => {
                    setOwnerCopied(true);
                    window.setTimeout(() => setOwnerCopied(false), 1200);
                  }, () => undefined);
                }}>
                  {ownerCopied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} />} {t('Copy owner ID', '复制群主 ID')}
                </button>
              </div>
            )}
          </span>
          <div className="sx-group-topbar-right">
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="sunx panel"
              aria-expanded={sunxPanelOpen}
              data-tip={t('Sunx panel', 'SUNX 面板')}
              onClick={() => {
                if (!sunxPanelOpen && searchOpen) onSearchClose();
                setSunxPanelOpen((v) => !v);
              }}
            >
              <KanbanSquare size={16} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="search group messages"
              aria-expanded={searchOpen}
              data-tip={t('Search group messages', '查询群消息')}
              onClick={onToggleSearch}
            >
              <Search size={16} strokeWidth={1.75} />
            </button>
          </div>
        </header>

        <div className="chat sx-group-chat" ref={scrollRef} onScroll={onScroll}>
          {loading && (
            <div className="chat-empty">
              <div className="chat-empty-hint">{t('Loading…', '加载中…')}</div>
            </div>
          )}
          {!loading && messages.length === 0 && (
            <div className="chat-empty">
              {/* 空态（2026-11-28 四轮裁定「第一行群聊图标,第二行 给 {群名} 群成员分派任务,其他都去掉」）：
                  两行构图,@ 用法与群命令说明移居输入框占位 */}
              <MessagesSquare size={44} strokeWidth={1.5} aria-hidden="true" className="sx-group-empty-ico" />
              <div className="chat-empty-title">
                {t('Assign tasks to members of {group}', '给 {group} 群成员分派任务').replace('{group}', detail?.group.name ?? t('Group', '群组'))}
              </div>
            </div>
          )}
          {hasMore && (
            <button type="button" className="chat-earlier" onClick={() => { void loadOlder(); }}>
              {t('Load earlier', '加载更早')}
            </button>
          )}
          {messages.map((m) => {
            const quoted = m.replyTo !== undefined ? messageById.get(m.replyTo) : undefined;
            const quote = m.replyPreview;
            /** 命令回执也来自成员（kind='command'），不能按 human/peer 二分——来源为 sunx 即左侧。 */
            const fromMember = m.kind !== 'human' || m.from.kind === 'sunx';
            const quoteNode = quote !== undefined ? (
              <GroupQuoteLine
                text={quote.text}
                mentions={quoted?.mentions}
                mentionAll={quoted?.mentionAll === true}
                onOpen={quoted?.seq !== undefined ? () => { void revealSeq(quoted.seq); } : undefined}
              />
            ) : null;
            const body = fromMember
              ? (md: string) => (
                <>
                  {quoteNode}
                  <div className="entry-md">
                    <div className="entry-md-body">
                      <MarkdownCached md={md} components={mdComponentsPlain} />
                    </div>
                  </div>
                </>
              )
              : (md: string) => (
                <div className="user-md-plain">
                  {quoteNode}
                  <GroupMentions text={md} mentions={m.mentions} mentionAll={m.mentionAll === true} />
                </div>
              );
            return (
              <div
                key={m.id}
                className={`chat-unit sx-group-msg${activeSeq === m.seq ? ' jump-hl' : ''}`}
                data-seq={m.seq}
                ref={(el) => { if (el !== null) nodeBySeq.current.set(m.seq, el); else nodeBySeq.current.delete(m.seq); }}
              >
                <UserEntryView
                  entry={entryOf(m)}
                  conn={conn}
                  alignLeft={fromMember}
                  {...(fromMember ? { bubbleMaxHeight: 480 } : {})}
                  onOpenImage={setLightbox}
                  onOpenSunx={(journalId) => onOpenMember(journalId)}
                  renderBody={body}
                  sourceSuffix={fromMember && m.to !== undefined ? (
                    <GroupTarget target={m.to} onOpenMember={onOpenMember} />
                  ) : undefined}
                />
              </div>
            );
          })}
        </div>

        {/* 群聊输入区 = 会话 chat-dock 同款（2026-11-27 用户裁定「输入框样式和动态宽度」):
            卡面/浮层/脚底 pills/发送钮全走会话件，宽度随主列与查询侧栏动态收放。 */}
        <div className="chat-dock sx-group-dock">
          <div className="chat-dock-fade" aria-hidden="true" />
          {/* 回到底部钮（2026-11-28 三轮裁定）：发送钮正上方、输入框上侧，非贴底即显（主对话同件） */}
          {!atBottom && (
            <button
              type="button"
              className="jump-down"
              aria-label="scroll to bottom"
              data-tip={t('Scroll to bottom', '回到底部')}
              onClick={() => { const el = scrollRef.current; if (el !== null) chaseScrollBottom(el); }}
            >
              <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          {askItems.length > 0 && (
            <div className="ask-dock">
              <div className="ask-scroll">
                {askItems.map((item) => {
                  const pick = askPicks[item.pid] ?? { labels: [], custom: '' };
                  return (
                    <div className="sx-group-ask" key={item.pid}>
                      <div className="sx-group-ask-source">
                        <span>{t('From', '来自')}</span>
                        <SunxIcon size={14} strokeWidth={1.75} />
                        <span>{item.member.name}</span>
                      </div>
                      <AskCard req={item.req} pick={pick} onPick={(patch) => setAskPick(item.pid, patch)} />
                      <div className="ask-actions">
                        <button type="button" onClick={() => { void answerAsk(item.pid, { type: 'dismissed' }); }}>{t('Skip', '跳过')}</button>
                        <button type="button" className="primary" disabled={!pickAnswered(pick)} onClick={() => submitAsk(item)}>{t('Submit', '提交')}</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <ComposerCard
            className="chat-composer"
            label={t('Use @ to pick members; @all dispatches to everyone.', '使用 @ 选择成员，@全体成员 进行分派')}
            inputRef={inputRef}
            value={input}
            placeholder={t('Use @ to pick members; @all dispatches to everyone.', '使用 @ 选择成员，@全体成员 进行分派')}
            rows={1}
            images={images}
            onRemoveImage={(i) => setImages((prev) => prev.filter((_, j) => j !== i))}
            onPasteFiles={(files) => { void addImages(files); }}
            highlight={renderGroupHighlight(input)}
            onChange={(v) => {
              setInput(v);
              const caret = inputRef.current?.selectionStart ?? v.length;
              const match = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
              const rt = refTokenAt(v, caret);
              if (match !== null) {
                setMentionOpen(true);
                setMentionQuery(match[2] ?? '');
                setMentionFrom(caret - (match[2]?.length ?? 0) - 1);
                setRefPal(null);
              } else if (rt !== null) {
                // $/# 引用面板（2026-11-28 三轮裁定）：与 @ 互斥（同一 caret 前缀不可能同时命中）
                setMentionOpen(false);
                setMentionFrom(null);
                setRefPal(rt);
                setRefActive(0);
                loadRefEntries();
              } else {
                setMentionOpen(false);
                setMentionFrom(null);
                if (refPal !== null) setRefPal(null);
              }
              // 「/」面板：继续输入即复位外点收口闸（再显示）
              // 「/」面板：继续输入即复位外点收口闸（再显示）
              if (slashTokenAt(v, inputRef.current?.selectionStart ?? v.length) !== null) setSlashHidden(false);
            }}
            onBeforeInput={onBeforeInputGuard}
            onPasteGuard={onPasteGuard}
            onCompositionGuard={onCompositionGuard}
            onCompositionRange={setCompRangeGuarded}
            onCompositionEndGuard={onCompositionEndGuard}
            onSelectGuard={onSelectGuard}
            onKeyDown={(e) => {
              // token 原子性 keydown 面（2026-11-28 五轮移植主对话 G14.212/213）：字符键/IME 不可
              // 落 token 中间（阻止+钉尾）；←→ 单击跨整个 token；退格/删除在 token 内整删
              if ((e.key.length === 1 || e.key === 'Process') && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const taA = e.currentTarget as HTMLTextAreaElement;
                const cs = taA.selectionStart ?? input.length;
                const ce = taA.selectionEnd ?? cs;
                const [as, ae] = atomicRangeOver(cs, ce, guardSpans(input));
                if (as !== cs || ae !== ce) {
                  e.preventDefault();
                  taA.setSelectionRange(ae, ae);
                  return;
                }
              }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const taA = e.currentTarget as HTMLTextAreaElement;
                const c = taA.selectionStart ?? 0;
                const ce = taA.selectionEnd ?? c;
                if (c === ce) {
                  const dir = e.key === 'ArrowLeft' ? -1 : 1;
                  const nc = c + dir;
                  if (nc >= 0 && nc <= taA.value.length) {
                    const span = tokenSpanAtOver(nc, guardSpans(taA.value));
                    if (span !== null) {
                      e.preventDefault();
                      const to = dir < 0 ? span[0] : span[1];
                      taA.setSelectionRange(to, to);
                    }
                  }
                }
              }
              if (e.key !== 'Process' && e.nativeEvent.isComposing !== true) composingRef.current = false;
              if (e.key === 'Backspace' || e.key === 'Delete') {
                const ta = e.currentTarget as HTMLTextAreaElement;
                const caret = ta.selectionStart ?? input.length;
                if (ta.selectionStart === ta.selectionEnd) {
                  const range = tokenDeleteRangeOver(caret, e.key, guardSpans(input));
                  if (range !== null) {
                    e.preventDefault();
                    const [s, e2] = range;
                    setInput((prev) => prev.slice(0, s) + prev.slice(e2));
                    requestAnimationFrame(() => { inputRef.current?.setSelectionRange(s, s); });
                    return;
                  }
                }
              }
              // $/# 引用面板键盘链（主对话同款）：↑↓ 选行 / Tab·Enter 选中 / Esc 收口
              if (refPal !== null && refItems !== null && refItems.length > 0) {
                const rActive = Math.max(0, Math.min(refActive, refItems.length - 1));
                if (e.key === 'ArrowDown') { e.preventDefault(); setRefActive(Math.min(rActive + 1, refItems.length - 1)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setRefActive(Math.max(rActive - 1, 0)); return; }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
                  e.preventDefault();
                  pickRef(refItems[rActive]!);
                  return;
                }
                if (e.key === 'Escape') { e.preventDefault(); setRefPal(null); return; }
              }
              // 「/」面板键盘链（主对话同款）：↑↓ 选行 / Tab 补全 / Enter 补全(查询=完整命令名时
              // 落发送,主对话同款) / Esc 收口
              if (slashItems !== null && slashItems.length > 0) {
                const active = Math.min(cmdActive, slashItems.length - 1);
                if (e.key === 'ArrowDown') { e.preventDefault(); setCmdActive(Math.min(active + 1, slashItems.length - 1)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setCmdActive(Math.max(active - 1, 0)); return; }
                const caret = (e.currentTarget as HTMLTextAreaElement).selectionStart ?? input.length;
                const tok = slashTokenAt(input, caret);
                const queryFull = tok !== null ? input.slice(tok.from + 1, caret) : '';
                const item = slashItems[active]!;
                if (e.key === 'Tab') {
                  e.preventDefault();
                  if (tok !== null) setInput((prev) => prev.slice(0, tok.from) + item.cmd + ' ' + prev.slice(caret));
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  if (tok !== null && item.cmd !== `/${queryFull}`) {
                    e.preventDefault();
                    setInput((prev) => prev.slice(0, tok.from) + item.cmd + ' ' + prev.slice(Math.max(caret, tok.from)));
                    requestAnimationFrame(() => {
                      const ta = inputRef.current;
                      if (ta !== null) {
                        const to = Math.min(tok.from + item.cmd.length + 1, ta.value.length);
                        ta.setSelectionRange(to, to);
                      }
                    });
                    return;
                  }
                }
                if (e.key === 'Escape') { e.preventDefault(); setSlashHidden(true); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            belowInput={
              <>
                {replyTo !== null && (
                  <div className="sx-group-reply">
                    <span className="composer-pill">
                      <CornerUpLeft size={14} strokeWidth={1.75} aria-hidden="true" />
                      <span className="pill-label">{replyTo.preview}</span>
                    </span>
                    <button type="button" className="sx-iconbtn" aria-label="cancel reply" onClick={() => setReplyTo(null)}><X size={14} /></button>
                  </div>
                )}
                {error !== '' && <div className="sx-img-hint warn" role="alert">{error}</div>}
                {hint !== '' && <div className="sx-img-hint" role="status">{hint}</div>}
                {/* @ 用法说明改由占位常驻（2026-11-28 四轮裁定「占位常驻为 使用 @ 选择成员…」）,
                    卡内提示行退役 */}
              </>
            }
            footLeft={
              <div className="composer-pills">
                <button
                  type="button"
                  className="composer-pill composer-plus-btn"
                  aria-label="add attachment"
                  data-tip={t('Add', '添加')}
                  onClick={() => { setMentionOpen(false); setSettingsPop(null); setPlusOpen((v) => !v); }}
                >
                  <PlusAddIcon size={16} />
                </button>
                <span className="pill-anchor">
                  <button
                    type="button"
                    className={`composer-pill${mode === 'full-access' ? ' mode-pill-warn' : ''}`}
                    aria-label={t('Permission', '权限')}
                    aria-expanded={settingsPop === 'mode'}
                    data-tip={modeLabel}
                    onClick={() => { setPlusOpen(false); setMentionOpen(false); setSettingsPop((v) => (v === 'mode' ? null : 'mode')); }}
                  >
                    {mode === '' ? <Users size={14} strokeWidth={1.75} aria-hidden="true" /> : <ModeIcon mode={mode} />}
                    <span className="pill-label">{modeLabel}</span>
                    <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="pill-chevron" />
                  </button>
                  {/* 权限弹层（2026-11-27 二轮裁定「把主对话的搬过来」）：ModeMenu 同件——
                      图标+双行富行；置顶「跟随成员」=群聊专属档（leading 注入）。 */}
                  {settingsPop === 'mode' && (
                    <ModeMenu
                      mode={mode === '' ? null : mode} // null=无权限行高亮（跟随成员行亮）
                      ariaLabel={t('Permission', '权限')}
                      allowPlan={false}
                      leading={{
                        label: t('Follow members', '跟随成员'),
                        desc: t('Each member runs with its own permission', '各成员按自己的权限档执行'),
                        icon: <Users size={15} strokeWidth={1.75} aria-hidden="true" />,
                        active: mode === '',
                        onPick: () => { setMode(''); setSettingsPop(null); },
                      }}
                      onPick={(m) => { setMode(m as 'read-only' | 'acceptEdits' | 'full-access'); setSettingsPop(null); }} // allowPlan=false:plan 不可达
                    />
                  )}
                </span>
              </div>
            }
            footRight={
              <div className="composer-pills composer-pills-right">
                <span className="pill-anchor">
                  <button
                    type="button"
                    className="composer-pill model-pill"
                    aria-label={t('Model', '模型')}
                    aria-expanded={settingsPop === 'model'}
                    onClick={() => { setPlusOpen(false); setMentionOpen(false); setSettingsPop((v) => (v === 'model' ? null : 'model')); }}
                  >
                    <span className="pill-label">{modelLabel}</span>
                    {/* 思考强度随名（主对话 G13 同形）：''=跟随成员不显档,选档后 `模型 · effort` 同 pill */}
                    {effort !== '' && <EffortChip effort={effort} />}
                    <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="pill-chevron" />
                  </button>
                  {settingsPop === 'model' && (
                    <div className="sx-menu-pop pill-pop pill-pop-right pill-pop-tall" role="menu" aria-label={t('Model', '模型')}>
                      <button type="button" role="menuitem" className={`sx-menuitem${model === '' ? ' current' : ''}`} onClick={() => { setModel(''); }}>
                        {t('Follow members', '跟随成员')}
                      </button>
                      {models.map((m) => (
                        <button key={m.id} type="button" role="menuitem" className={`sx-menuitem${model === m.id ? ' current' : ''}`} data-tip={m.id} onClick={() => { setModel(m.id); }}>
                          {m.model !== '' ? m.model : baseModelName(m.id)}
                        </button>
                      ))}
                      {/* 强度滑条（2026-11-28 三轮裁定「模型选择怎么没有强度选择条」）：主对话
                          EffortSlider 同件；''=跟随成员（滑条示中档,拨动才透传）。选中不收口——
                          一连选模型+强度,外点/再点收（主对话同语义） */}
                      <EffortSlider
                        value={effort === '' ? 'medium' : effort}
                        onChange={(ev) => { setEffort(ev); }}
                      />
                    </div>
                  )}
                </span>
                <button type="button" className={`send tip-right${sending ? ' loading' : ''}`} aria-label="send" data-tip={`${t('Send', '发送')} · Enter`} disabled={sending || (input.trim() === '' && images.length === 0)} onClick={() => { void send(); }}>
                  {/* 投递在途转圈（2026-11-28 五轮移植主对话 send-loading 同语言） */}
                  {sending ? <span className="run-spinner" aria-hidden="true" /> : <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />}
                </button>
              </div>
            }
            overlays={
              <>
                {plusOpen && (
                  <ComposerPlusPanel
                    conn={conn}
                    excludeCommands={SUNX_EXCLUDED_COMMANDS}
                    extraCommands={SUNX_GROUP_COMMANDS}
                    atHint={t('Group members', '群成员')}
                    onInsert={(text) => {
                      setInput((v) => `${v}${v === '' || v.endsWith(' ') ? '' : ' '}${text}`);
                      setPlusOpen(false);
                    }}
                    onAttachImages={(files) => { void addImages(files); setPlusOpen(false); }}
                  />
                )}
                {mentionOpen && (
                  <div className="proj-pop sx-group-palette" role="menu">
                    {/* 筛选行退役（2026-11-28 三轮裁定「去掉筛选成员行,有下侧通过 @ 后自动筛选」）：
                        mentionQuery 已由输入框 @ 令牌派生,行内输入即活滤 */}
                    <div className="proj-rows-scroll">
                      <button type="button" role="menuitem" className="sx-menuitem" onClick={addAll}>
                        <Users size={14} strokeWidth={1.75} aria-hidden="true" /> {t('All members', '全体成员')}
                      </button>
                      {mentionCandidates.map((member) => (
                        <button key={member.id} type="button" role="menuitem" className="sx-menuitem" onClick={() => addMention(member)}>
                          <SunxIcon size={14} /> {member.name}
                          <span className="sx-group-muted">
                            {member.awaiting === true ? t('awaiting input', '等待回答') : member.running ? t('running', '运行中') : member.live ? t('idle', '空闲') : t('not open', '未打开')}
                          </span>
                        </button>
                      ))}
                    </div>
                    {mentionCandidates.length === 0 && <div className="proj-empty">{t('No members', '暂无成员')}</div>}
                  </div>
                )}
                {/* $/# 引用面板（2026-11-28 三轮裁定「# $ 也要提示和 chip」）：主对话 RefPalette
                    同件——$ 成员/# 团队,选中插名称 token,输入框 chip 高亮+发送期还原 id */}
                {refPal !== null && refItems !== null && (
                  <RefPalette
                    items={refItems}
                    emptyHint={refEntries.agents.length === 0 && refEntries.teams.length === 0
                      ? t('No registered sub-agents or teams yet — reference here with $ or #', '尚无在册子智能体/团队 — 可在此 $ 引用 / # 拉队')
                      : t('No matching entry', '无匹配条目')}
                    active={Math.max(0, Math.min(refActive, refItems.length - 1))}
                    onHover={setRefActive}
                    onPick={pickRef}
                  />
                )}
                {/* 「/」面板（2026-11-27 二轮裁定）：主对话 CommandPalette 同件——命令/技能
                    分组+双语说明+↑↓/Tab 键链；群控制命令并入、/plan 排除；外点收口闸 slashHidden */}
                {slashItems !== null && !slashHidden && (
                  <CommandPalette items={slashItems} active={slashActive} onHover={setCmdActive} onPick={pickSlash} />
                )}
              </>
            }
            onInputClick={onInputClick}
          />
        </div>
      </div>

      {/* Sunx 面板（2026-11-27 用户裁定）：右侧栏复用 SUNX 总览页（SunxBoardTab），按本群
          过滤=群隔离；全应用唯一入口就是群聊顶栏面板钮。与查询侧栏互斥。
          2026-11-28 三轮裁定：头行顶置（SUNX+X 紧随+分割线,旧 sx-side-head 行退役）,
          侧栏拖宽加回（.sx-resizer 同查询侧栏）。 */}
      {sunxPanelOpen && (
        <aside
          ref={sunxPanelRef}
          className="sx-sidebar sx-group-sunx-panel"
          style={{ '--sb-w': `${sunxPanelWidth}px` } as CSSProperties}
          aria-label={t('Sunx panel', 'SUNX 面板')}
        >
          <div
            className="sx-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('Resize panel', '调整侧栏宽度')}
            data-tip={t('Drag to resize', '拖动调整宽度')}
            onMouseDown={(e) => startPanelResize(e, sunxPanelRef, sunxPanelWidth, setSunxPanelWidth)}
          />
          <div className="sx-panel-head">
            <span className="sx-panel-head-title">{t('Sunx', 'SUNX')}</span>
            <button type="button" className="sx-iconbtn" aria-label="close sunx panel" onClick={() => setSunxPanelOpen(false)}><X size={14} /></button>
          </div>
          <SunxBoardTab
            conn={conn}
            groupId={groupId}
            onOpenInstance={(target) => {
              if (target.journalId !== undefined) onOpenMember(target.journalId);
              else if (target.sessionId !== undefined) onOpenSession(target.sessionId, target.root);
            }}
          />
        </aside>
      )}

      {searchOpen && (
        <aside
          ref={searchRef}
          className="sx-sidebar sx-group-search"
          style={{ '--sb-w': `${searchWidth}px` } as CSSProperties}
          aria-label={t('Search group messages', '查询群消息')}
        >
          <div
            className="sx-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('Resize search panel', '调整查询侧栏宽度')}
            data-tip={t('Drag to resize', '拖动调整宽度')}
            onMouseDown={(e) => startPanelResize(e, searchRef, searchWidth, setSearchWidth)}
          />
          {/* 头行顶置（2026-11-28 三轮裁定「顶部同样位置显示 查询群消息 X 分割线」）：与 SUNX
              面板同款 .sx-panel-head,占 toolbar 条高,X 紧跟标题,分割线在行下 */}
          <div className="sx-panel-head">
            <span className="sx-panel-head-title">{t('Search group messages', '查询群消息')}</span>
            <button type="button" className="sx-iconbtn" aria-label="close search" onClick={onSearchClose}><X size={14} /></button>
          </div>
          {/* 关键词活滤（2026-11-28 三轮裁定「筛选框 输入关键词查询,去掉后面查询按钮」）：
              输入即查（250ms 去抖,见上方 effect）,Enter 立即 */}
          <div className="sx-group-search-bar">
            <input
              ref={searchInputRef}
              className="sx-setting-input"
              value={searchQ}
              aria-label={t('Type to search', '输入关键词查询')}
              placeholder={t('Type to search', '输入关键词查询')}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
            />
          </div>
          <div className="sx-search-modal-list">
            {searchHits.length === 0 && (
              <div className="sx-search-empty">
                {searchQ.trim() === '' ? t('Type to search', '输入关键词查询') : t('No matches', '无匹配消息')}
              </div>
            )}
            {searchHits.map((h) => (
              <button
                key={h.id}
                type="button"
                className={`sx-search-row${activeSeq === h.seq ? ' sx-kbd-active' : ''}`}
                onClick={() => { void revealSeq(h.seq); }}
              >
                {h.from.kind === 'group' ? <MessagesSquare size={14} strokeWidth={1.75} /> : <SunxIcon size={14} />}
                <span className="sx-search-label">{h.text}</span>
                <span className="sx-search-meta">{h.from.kind === 'group' ? t('Owner', '群主') : h.from.name} · {fmtTime(h.ts)}</span>
              </button>
            ))}
          </div>
        </aside>
      )}

      {nameOpen && createPortal(
        <div className="modal-overlay" onClick={() => setNameOpen(false)}>
          <div className="modal-body rename-dialog" role="dialog" aria-label={t('Rename group', '编辑群名')} onClick={(e) => e.stopPropagation()}>
            <div className="dirpicker-head">{t('Rename group', '编辑群名')}</div>
            {/* 编辑群名（2026-11-28 四轮裁定「和编辑会话名一致,不要前缀图标」）：裸输入框,
                2026-11-27 的群图标前缀随裁定退役 */}
            <input className="chat-title-input" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void rename(); }} autoFocus />
            <div className="dirpicker-foot">
              <button type="button" onClick={() => setNameOpen(false)}>{t('Cancel', '取消')}</button>
              <button type="button" className="primary" onClick={() => { void rename(); }}>{t('Save', '保存')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {newSunxOpen && (
        <NewSunxDialog
          open
          onClose={() => setNewSunxOpen(false)}
          conn={conn}
          defaultGroupId={groupId}
          onOpenSession={(sessionId, root) => {
            setNewSunxOpen(false);
            onClose();
            onOpenSession(sessionId, root);
          }}
        />
      )}

      {lightbox !== undefined && <ImageLightbox src={lightbox} onClose={() => setLightbox(undefined)} />}
      {/* 群气泡圈选操作条（2026-11-28 三轮裁定「气泡中也要支持选中文本后显示 添加到会话+复制」）：
          主对话 SelActionsOverlay 同件——选区非空浮出,token 铸 ⟦文本片段⟧ 落群 composer 折芯片 */}
      <SelActionsOverlay
        containerRef={scrollRef}
        insertLabel={t('Add to chat', '添加到会话')}
        onInsert={(token) => {
          // token 落群 composer 折芯片（注册表已由 overlay 记账,chip hover 预览可取）
          setInput((v) => (v.trim() === '' ? token : `${v.replace(/\s+$/, '')} ${token}`));
          window.setTimeout(() => inputRef.current?.focus(), 0);
        }}
      />
    </div>
  );
}

/** 群消息 @ 成员/全体 chip（2026-11-28 三轮裁定「全体成员也显示成蓝色,chip 与消息上下居中对齐,
 *  左右留缝不挤」）：成员/全体同一件——图标+accent 名（.sx-group-mention inline-flex 中线对齐）；
 *  不再走 .hn-ref pill/.hn-team warn 分色。其余段交 renderMentionSpans——/命令·$成员·#团队
 *  蓝分色、⟦文本片段⟧ 芯片（hover 预览+复制）与主对话气泡同口径。 */
function GroupMentions({ text, mentions = [], mentionAll = false }: {
  text: string;
  mentions?: SunxRoomTarget[];
  mentionAll?: boolean;
}): JSX.Element {
  const memberTokens = new Set(mentions.map((m) => `@${m.name}`));
  const tokens = [...(mentionAll ? ['@全体成员'] : []), ...memberTokens].sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return <>{renderMentionSpans(text)}</>;
  const escaped = tokens.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'g');
  return (
    <>
      {text.split(re).filter((part) => part !== '').map((part, i) => (
        tokens.includes(part) ? (
          <span key={i} className="sx-group-mention">
            <span className="sx-group-mention-ico" aria-hidden="true">
              {part === '@全体成员' ? <Users size={14} strokeWidth={1.75} /> : <SunxIcon size={14} strokeWidth={1.75} />}
            </span>
            {part.slice(1)}
          </span>
        ) : (
          // 纯文本段保持原文字面（不包 span）——气泡文字节点语义不变（选择/复制/测试锚同旧）
          <Fragment key={i}>{hasMentionTokens(part) ? renderMentionSpans(part) : part}</Fragment>
        )
      ))}
    </>
  );
}

/** 引用行：复用用户气泡的既有次级文字/项目图标件；可点则跳到原气泡。
 *  2026-11-28 四轮裁定：常驻 1 行 sticky 钉气泡顶（不随限高滚动区滚走,灰标样式）,
 *  「跳到引用气泡」data-tip 去除。 */
function GroupQuoteLine({ text, mentions, mentionAll, onOpen }: {
  text: string;
  mentions?: SunxRoomTarget[];
  mentionAll?: boolean;
  onOpen?: () => void;
}): JSX.Element {
  return (
    <div
      className={`sx-group-quote-line${onOpen !== undefined ? ' clickable' : ''}`}
      role={onOpen !== undefined ? 'button' : undefined}
      tabIndex={onOpen !== undefined ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (onOpen === undefined) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
    >
      <CornerUpLeft size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="sx-group-quote-text">
        <GroupMentions text={text} mentions={mentions} mentionAll={mentionAll} />
      </span>
    </div>
  );
}

/** 成员消息来源行的「发送给」后缀：目标=群主用既有 SUNX badge，目标=成员用既有 Sunx 名称件。 */
function GroupTarget({ target, onOpenMember }: {
  target: SunxRoomPeerRef;
  onOpenMember: (journalId: string) => void;
}): JSX.Element {
  const isGroup = target.kind === 'group' || target.id.startsWith('grp_');
  return (
    <>
      <span>{t('to', '发送给')}</span>
      {isGroup ? (
        <span className="sx-sunx-badge">{t('Owner', '群主')}</span>
      ) : (
        <button type="button" className="user-from-sunx-btn" onClick={() => onOpenMember(target.id)}>
          <SunxIcon size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{target.name}</span>
        </button>
      )}
    </>
  );
}
