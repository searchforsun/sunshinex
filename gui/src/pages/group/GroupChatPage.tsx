/**
 * Sunx 群聊页（2026-11-26 群组规格 §7；2026-11-27 样式重做）：主区覆盖层、无右侧页签栏。
 * 消息面完全复用会话件——主人=UserEntryView 用户气泡右对齐，Sunx=同一件左对齐变体
 * （来源行/发送给/时间/复制/回复/送达动作全走会话样式）；输入面=chat-dock + ComposerCard；
 * 查询侧栏=sx-sidebar + sx-resizer + sx-search-*（可拖宽）。房间数据靠 seq 游标轮询。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp, ChevronDown, Copy, CornerUpLeft, KanbanSquare, MessagesSquare, MoreHorizontal, Search, Users, X,
} from 'lucide-react';
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
import { PlusAddIcon } from '../../sidebar/project-menu-util';
import { MAX_IMAGES, loadImages } from '../../images';
import { MIN_TAB_WIDTH } from '../../tabs/tab-state';
import { MAIN_MIN_WIDTH, chatMaxFor } from '../../thread-width';
import { zoomScale } from '../../ui-zoom';

const GROUPS_CHANGED_EVENT = 'sunx-groups-changed';
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
}

export function GroupChatPage(props: GroupChatPageProps): JSX.Element {
  useLanguage();
  const { conn, groupId, onClose, onOpenMember, onOpenSession, onError, searchOpen, onSearchClose, onToggleSearch } = props;
  const [detail, setDetail] = useState<SunxGroupDetail | null>(null);
  const [messages, setMessages] = useState<SunxRoomMessage[]>([]);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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
  const [copied, setCopied] = useState(false);
  const [lightbox, setLightbox] = useState<string | undefined>(undefined);
  const [searchQ, setSearchQ] = useState('');
  const [searchHits, setSearchHits] = useState<SunxGroupSearchHit[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  /** 查询侧栏宽度=项目右栏同款可拖宽件（2026-11-27 用户裁定「查询侧栏，动态调整宽度」） */
  const [searchWidth, setSearchWidth] = useState(420);
  const [activeSeq, setActiveSeq] = useState<number | null>(null);
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

  useEffect(() => { cursorRef.current = cursor; }, [cursor]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

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
    setImages([]);
    setPlusOpen(false);
    setModel('');
    setMode('');
    void loadInitial();
    void conn.commands().then(
      (r) => setSupported([...new Set([...r.supported, ...SUNX_GROUP_COMMANDS])].filter((c) => c !== '/plan')),
      () => setSupported([...SUNX_GROUP_COMMANDS]),
    );
    void conn.models().then((r) => setModels(r.choices), () => setModels([]));
  }, [conn, groupId, loadInitial]);

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
    setImages((prev) => [...prev, ...loaded].slice(0, MAX_IMAGES));
  }, []);

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
    const open = input.trim().startsWith('/') && !input.includes(' ');
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
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
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

  /** 按 seq 定位；不在已加载窗口时先向前拉一页（搜索/引用跳转共用） */
  const revealSeq = useCallback(async (seq: number): Promise<void> => {
    const go = (): void => {
      const node = nodeBySeq.current.get(seq);
      if (node === undefined) return;
      node.scrollIntoView({ block: 'center', behavior: 'auto' });
      setActiveSeq(seq);
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
    setSearchBusy(true);
    try {
      const r = await conn.sunxGroupSearch(groupId, q, 50);
      setSearchHits(r.results);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearchBusy(false);
    }
  }, [conn, groupId, onError, searchQ]);

  /** 查询侧栏拖宽（2026-11-27 用户裁定「查询侧栏，动态调整宽度」）：复用 .sx-resizer 命中件与
   *  会话右栏同款拖拽语义（向左拖变宽/直写 --sb-w/松手落 React 态，最小 296、预留主栏最小宽） */
  const startSearchResize = useCallback((e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const el = e.currentTarget;
    el.classList.add('active');
    const startX = e.clientX;
    const startWidth = searchWidth;
    const cap = (): number => window.innerWidth / zoomScale() - MAIN_MIN_WIDTH;
    let next = startWidth;
    const onMove = (ev: MouseEvent): void => {
      next = Math.max(MIN_TAB_WIDTH, Math.min(cap(), startWidth + (startX - ev.clientX) / zoomScale()));
      searchRef.current?.style.setProperty('--sb-w', `${next}px`);
    };
    const stop = (): void => {
      el.classList.remove('active');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      searchRef.current?.style.removeProperty('--sb-w');
      setSearchWidth(next);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  }, [searchWidth]);

  const send = useCallback(async (): Promise<void> => {
    const text = input;
    if ((text.trim() === '' && images.length === 0) || sending) return;
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
  }, [conn, groupId, images, input, mentionAll, mentions, mode, model, onError, poll, replyTo, sending, supported]);

  const copy = useCallback((text: string): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }, () => undefined);
  }, []);

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
  /** 「/」面板项（主对话同件）：群支持集 = daemon supported ∪ 群控制命令 − /plan；
   *  行首 / 令牌 → 命令+技能，命令行带双语说明（CommandPalette 渲染件）。 */
  const slashItems = useMemo<CmdItem[] | null>(() => {
    const q = input.trim();
    if (!q.startsWith('/') || q.includes(' ')) return null;
    const excluded = SUNX_EXCLUDED_COMMANDS as readonly string[];
    const merged: typeof cmdData = cmdData === null ? null : {
      commands: cmdData.commands.filter((c) => !excluded.includes(c)),
      descriptions: cmdData.descriptions,
      supported: [...new Set([...cmdData.supported, ...SUNX_GROUP_COMMANDS])].filter((c) => !excluded.includes(c)),
    };
    const items = slashItemsFor(merged, { query: input.slice(1), atStart: true }, skills);
    return items.length > 0 ? items : null;
  }, [cmdData, input, skills]);
  const slashActive = Math.min(cmdActive, Math.max(0, (slashItems?.length ?? 1) - 1));
  const pickSlash = useCallback((item: CmdItem): void => {
    if (!item.ok) return;
    setInput(`${item.cmd} `);
    setMentions([]);
    setMentionAll(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);
  /** 输入框 @ chip 高亮层（2026-11-27 二轮裁定「输入框渲染成 chip 图标+名字」）：完整
   *  @成员名/@全体成员 令牌按主对话 file 芯片同手法渲染——原文 @ 透明保字宽，图标绝对定位，
   *  层与 textarea 零漂移；无完整令牌=不挂层（textarea 原生显字）。 */
  const renderGroupHighlight = useCallback((text: string): ReactNode => {
    const tokens = [...(text.includes('@全体成员') ? ['@全体成员'] : []), ...members.map((m) => `@${m.name}`)]
      .sort((a, b) => b.length - a.length);
    if (tokens.length === 0) return undefined;
    const escaped = tokens.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'g'));
    if (!parts.some((p) => tokens.includes(p))) return undefined;
    return parts.map((part, i) => (
      tokens.includes(part) ? (
        <span key={i} className={`hn hn-file${part === '@全体成员' ? ' sx-group-token-all' : ''}`}>
          <span className="hn-file-ico" aria-hidden="true">
            {part === '@全体成员' ? <Users size={14} strokeWidth={1.75} /> : <SunxIcon size={14} strokeWidth={1.75} />}
          </span>
          <span className="hn-file-at" aria-hidden="true">@</span>
          {part.slice(1)}
        </span>
      ) : <span key={i}>{part}</span>
    ));
  }, [members]);
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
                <button type="button" role="menuitem" className="sx-menuitem" onClick={() => { setMenuOpen(false); copy(groupId); }}>
                  <Copy size={14} /> {t('Copy owner ID', '复制群主 ID')}
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
              {/* 空态（2026-11-27 用户裁定「群聊图标 + 第二行群名 + 群命令」）：主对话 Sunx
                  欢迎面同构图——大图标/群名/说明行，第三行带群控制命令。 */}
              <MessagesSquare size={44} strokeWidth={1.5} aria-hidden="true" className="sx-group-empty-ico" />
              <div className="chat-empty-title">{detail?.group.name ?? t('Group', '群组')}</div>
              <div className="chat-empty-hint">{t('Type @ to pick members; @all dispatches to everyone.', '输入 @ 选择成员，@全体成员 分发给全员')}</div>
              <div className="chat-empty-hint sx-group-empty-cmds">
                <span className="sx-group-hint-tok">/stop</span> {t('pause', '暂停')} · <span className="sx-group-hint-tok">/clear</span> {t('clear queue', '清排队')} · <span className="sx-group-hint-tok">/continue</span> {t('resume', '继续')}
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
            label={t('Assign tasks to members…', '给全体成员派任务…')}
            inputRef={inputRef}
            value={input}
            placeholder={t('Assign tasks to members…', '给全体成员派任务…')}
            rows={1}
            images={images}
            onRemoveImage={(i) => setImages((prev) => prev.filter((_, j) => j !== i))}
            onPasteFiles={(files) => { void addImages(files); }}
            highlight={renderGroupHighlight(input)}
            onChange={(v) => {
              setInput(v);
              const caret = inputRef.current?.selectionStart ?? v.length;
              const match = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
              if (match !== null) {
                setMentionOpen(true);
                setMentionQuery(match[2] ?? '');
                setMentionFrom(caret - (match[2]?.length ?? 0) - 1);
              } else {
                setMentionOpen(false);
                setMentionFrom(null);
              }
            }}
            onKeyDown={(e) => {
              // 「/」面板键盘链（主对话同款）：↑↓ 选行 / Tab 补全 / Enter 选中 / Esc 清令牌
              if (slashItems !== null && slashItems.length > 0) {
                const active = Math.min(cmdActive, slashItems.length - 1);
                if (e.key === 'ArrowDown') { e.preventDefault(); setCmdActive(Math.min(active + 1, slashItems.length - 1)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setCmdActive(Math.max(active - 1, 0)); return; }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
                  e.preventDefault();
                  pickSlash(slashItems[active]!);
                  return;
                }
                if (e.key === 'Escape') { e.preventDefault(); setInput(''); return; }
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
                    <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="pill-chevron" />
                  </button>
                  {settingsPop === 'model' && (
                    <div className="sx-menu-pop pill-pop pill-pop-right pill-pop-tall" role="menu">
                      <button type="button" role="menuitem" className={`sx-menuitem${model === '' ? ' current' : ''}`} onClick={() => { setModel(''); setSettingsPop(null); }}>
                        {t('Follow members', '跟随成员')}
                      </button>
                      {models.map((m) => (
                        <button key={m.id} type="button" role="menuitem" className={`sx-menuitem${model === m.id ? ' current' : ''}`} onClick={() => { setModel(m.id); setSettingsPop(null); }}>
                          {m.model !== '' ? m.model : baseModelName(m.id)}
                        </button>
                      ))}
                    </div>
                  )}
                </span>
                <button type="button" className="send tip-right" aria-label="send" data-tip={`${t('Send', '发送')} · Enter`} disabled={sending || (input.trim() === '' && images.length === 0)} onClick={() => { void send(); }}>
                  <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
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
                    onInsert={(text) => {
                      setInput((v) => `${v}${v === '' || v.endsWith(' ') ? '' : ' '}${text}`);
                      setPlusOpen(false);
                    }}
                    onAttachImages={(files) => { void addImages(files); setPlusOpen(false); }}
                  />
                )}
                {mentionOpen && (
                  <div className="proj-pop sx-group-palette" role="menu">
                    <div className="branch-pop-filter">
                      <input
                        autoFocus
                        value={mentionQuery}
                        aria-label={t('Filter members', '筛选成员')}
                        placeholder={t('Filter members…', '筛选成员…')}
                        onChange={(e) => setMentionQuery(e.target.value)}
                      />
                    </div>
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
                {/* 「/」面板（2026-11-27 二轮裁定）：主对话 CommandPalette 同件——命令/技能
                    分组+双语说明+↑↓/Tab 键链；群控制命令并入、/plan 排除。 */}
                {slashItems !== null && (
                  <CommandPalette items={slashItems} active={slashActive} onHover={setCmdActive} onPick={pickSlash} />
                )}
              </>
            }
          />
          {/* 输入区提示行（2026-11-27 二轮裁定）：@ 用法说明，主对话灰色提示同语言 */}
          <div className="sx-group-hint">
            <span>输入 </span><span className="sx-group-hint-tok">@</span><span> 选择成员，</span><span className="sx-group-hint-tok">@全体成员</span><span> 分发给全员</span>
          </div>
        </div>
      </div>

      {/* Sunx 面板（2026-11-27 用户裁定）：右侧栏复用 SUNX 总览页（SunxBoardTab），按本群
          过滤=群隔离；全应用唯一入口就是群聊顶栏面板钮。与查询侧栏互斥。 */}
      {sunxPanelOpen && (
        <aside className="sx-sidebar sx-group-sunx-panel" aria-label={t('Sunx panel', 'SUNX 面板')}>
          <div className="sx-side-head sx-side-head-row">
            <span>{t('Sunx', 'SUNX')}</span>
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
            onMouseDown={startSearchResize}
          />
          <div className="sx-side-head sx-side-head-row">
            <span>{t('Search', '查询')}</span>
            <button type="button" className="sx-iconbtn" aria-label="close search" onClick={onSearchClose}><X size={14} /></button>
          </div>
          <div className="sx-group-search-bar">
            <input
              ref={searchInputRef}
              className="sx-setting-input"
              value={searchQ}
              aria-label={t('Search messages', '查询群消息')}
              placeholder={t('Search messages', '查询群消息')}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
            />
            <button type="button" className="sx-iconbtn" aria-label="run search" disabled={searchBusy} onClick={() => { void runSearch(); }}>
              <Search size={14} strokeWidth={1.75} />
            </button>
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
            {/* 编辑群名（2026-11-27 用户裁定「左侧增加群图标」）：群图标与侧栏群行同件同尺寸 */}
            <div className="sx-group-rename-row">
              <span className="sx-ws-folder" aria-hidden="true">
                <MessagesSquare size={16} strokeWidth={1.75} />
              </span>
              <input className="chat-title-input" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void rename(); }} autoFocus />
            </div>
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
      {copied && <div className="sx-toast" role="status">{t('Copied', '已复制')}</div>}
    </div>
  );
}

/** 群消息 @ 成员/全体 chip（2026-11-27 样式重做）：复用项目既有 .hn/.hn-ref 芯片，
 *  不再自绘飞书蓝色 chip；成员=SunxIcon+accent，全体=Users+warn（.hn-team 既有分色）。 */
function GroupMentions({ text, mentions = [], mentionAll = false }: {
  text: string;
  mentions?: SunxRoomTarget[];
  mentionAll?: boolean;
}): JSX.Element {
  const memberTokens = new Set(mentions.map((m) => `@${m.name}`));
  const tokens = [...(mentionAll ? ['@全体成员'] : []), ...memberTokens].sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return <>{text}</>;
  const escaped = tokens.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'g');
  return (
    <>
      {text.split(re).filter((part) => part !== '').map((part, i) => (
        tokens.includes(part) ? (
          <span key={i} className={`hn hn-ref ${part === '@全体成员' ? 'hn-team' : 'hn-agent'}`}>
            <span className="hn-ref-ico" aria-hidden="true">
              {part === '@全体成员' ? <Users size={14} strokeWidth={1.75} /> : <SunxIcon size={14} strokeWidth={1.75} />}
            </span>
            {part.slice(1)}
          </span>
        ) : <Fragment key={i}>{part}</Fragment>
      ))}
    </>
  );
}

/** 引用行：复用用户气泡的既有次级文字/项目图标件；可点则跳到原气泡。 */
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
      data-tip={onOpen !== undefined ? t('Jump to quoted message', '跳到引用气泡') : undefined}
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
