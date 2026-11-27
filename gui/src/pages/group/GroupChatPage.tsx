/**
 * Sunx 群聊页（2026-11-26 群组规格 §7）：主区覆盖层、无右侧页签栏、顶栏群名+⋯、环形饼图回执、
 * 左侧气泡（上方发送行/单卡片 480px/首行引用/展开全部）、右侧群主气泡、@/命令/引用 composer、
 * 查询侧栏与群成员弹窗。房间数据靠 seq 游标轮询；发送后立即拉一次。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Copy, MessagesSquare, MoreHorizontal, Plus, Search, Send, Users, X } from 'lucide-react';
import type { Connection } from '../../connection';
import type {
  SunxGroupDetail, SunxGroupMemberRow, SunxGroupSearchHit, SunxRoomDelivery, SunxRoomMessage, SunxRoomTarget,
} from '../../connection-types';
import type { GuiAskReq } from '../../connection-types';
import { AskCard, pickAnswered, type AskPick } from '../chat/PendingCards';
import { t, useLanguage } from '../../i18n';
import { SunxIcon } from '../../sunx-icon';
import { MarkdownCached, mdComponentsPlain } from '../Chat';
import { baseModelName } from '../chat/EntryViews';
import { NewSunxDialog } from '../../welcome/NewSunxDialog';
import { ComposerPlusPanel } from '../../composer/ComposerPlusPanel';
import { ComposerCard } from '../../composer/ComposerCard';
import { MAX_IMAGES, loadImages } from '../../images';
import { sessionModeLabel } from '../../composer/mode-menu';

const GROUPS_CHANGED_EVENT = 'sunx-groups-changed';
const DESTRUCTIVE = new Set(['/delete', '/skills-rm', '/memory-rm', '/memory-gc']);
/** Sunx 无计划模式闭环（2026-11-27 用户裁定）：/plan 不进群命令/面板 */
const SUNX_EXCLUDED_COMMANDS = ['/plan'] as const;
type AskAnswer = Parameters<Connection['replyAsk']>[1];

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function highlight(text: string, q: string): Array<{ text: string; hit: boolean }> {
  const needle = q.trim();
  if (needle === '') return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const out: Array<{ text: string; hit: boolean }> = [];
  let i = 0;
  for (;;) {
    const at = lower.indexOf(n, i);
    if (at < 0) break;
    if (at > i) out.push({ text: text.slice(i, at), hit: false });
    out.push({ text: text.slice(at, at + needle.length), hit: true });
    i = at + needle.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
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
}

export function GroupChatPage(props: GroupChatPageProps): JSX.Element {
  useLanguage();
  const { conn, groupId, onClose, onOpenMember, onOpenSession, onError, searchOpen, onSearchClose } = props;
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
  const [receipt, setReceipt] = useState<SunxRoomMessage | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [newSunxOpen, setNewSunxOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searchQ, setSearchQ] = useState('');
  const [searchHits, setSearchHits] = useState<SunxGroupSearchHit[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [activeSeq, setActiveSeq] = useState<number | null>(null);
  /** 「+」面板（2026-11-27 用户裁定「+ 中去掉文件，其他都可以」）：ComposerPlusPanel 无 session/root
   *  → 文件区天然不渲染；图片附件/命令/技能/子智能体/团队保留 */
  const [plusOpen, setPlusOpen] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  /** 模型/权限选择（2026-11-27 用户裁定）：空串=跟随成员；发送时随 body 透传，daemon 逐个 set */
  const [models, setModels] = useState<Array<{ id: string; model: string }>>([]);
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<'' | 'read-only' | 'acceptEdits' | 'full-access'>('');
  /** 模型/权限 pill 弹层（2026-11-26 样式重做：复用 composer-pill + pill-pop，不再自绘 select） */
  const [settingsPop, setSettingsPop] = useState<'model' | 'mode' | null>(null);
  /** 群内 ask 卡（2026-11-27）：与成员会话同一 pending；选择态按 pid 收 */
  const [askPicks, setAskPicks] = useState<Record<string, AskPick>>({});

  const cursorRef = useRef(0);
  const messagesRef = useRef<SunxRoomMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
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
    void conn.commands().then((r) => setSupported(r.supported.filter((c) => c !== '/plan')), () => setSupported([]));
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
    window.setTimeout(() => searchInputRef.current?.focus(), 30);
  }, [searchOpen]);

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
  const commandCandidates = useMemo(() => {
    const q = input.trim().toLowerCase();
    const list = supported.filter((c) => q === '' || c.startsWith(q) || q.startsWith('/'));
    return list.slice(0, 24);
  }, [input, supported]);
  const showCommandPalette = input.trim().startsWith('/') && !input.includes(' ');
  /** 底栏 pill 文案（空串=跟随成员；模型名按聊天同款短名收敛） */
  const modelLabel = model === ''
    ? t('Follow members', '跟随成员')
    : (models.find((m) => m.id === model)?.model || baseModelName(model));
  const modeLabel = mode === '' ? t('Follow members', '跟随成员') : sessionModeLabel(mode);

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
  const addCommand = useCallback((cmd: string): void => {
    setInput(`${cmd} `);
  }, []);

  const openReceipt = useCallback((m: SunxRoomMessage): void => {
    setReceipt((v) => (v?.id === m.id ? null : m));
  }, []);

  return (
    <div className={`sx-group-page${searchOpen ? ' searching' : ''}`} aria-label={t('Group chat', '群聊')}>
      <div className="sx-group-main">
        <header className="chat-topbar sx-group-topbar" data-drag-band>
          {/* 群名行复用会话顶栏（2026-11-26 用户裁定）：群图标占会话文件夹位、群名走 .chat-title、
              ⋯ 走 chat-more 右贴（不再自绘 170px 让位顶栏） */}
          <span className="chat-title">
            <span className="sx-ws-folder" aria-hidden="true">
              <MessagesSquare size={16} strokeWidth={1.75} />
            </span>
            <span className="chat-title-text">{detail?.group.name ?? t('Group', '群组')}</span>
          </span>
          <button type="button" className="sx-iconbtn chat-more" aria-label="group menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            <MoreHorizontal size={16} strokeWidth={1.75} />
          </button>
          {menuOpen && (
            <div className="sx-menu-pop chat-more-pop" role="menu">
              <button type="button" role="menuitem" className="sx-menuitem" onClick={() => { setMenuOpen(false); setNewSunxOpen(true); }}>
                <SunxIcon size={14} /> {t('New Sunx', '新建 SUNX')}
              </button>
              <button type="button" role="menuitem" className="sx-menuitem" onClick={() => { setMenuOpen(false); setNameDraft(detail?.group.name ?? ''); setNameOpen(true); }}>
                {t('Rename group', '编辑群名')}
              </button>
              <button type="button" role="menuitem" className="sx-menuitem" onClick={() => { setMenuOpen(false); copy(groupId); }}>
                <Copy size={14} /> {t('Copy owner ID', '复制群主 ID')}
              </button>
              <button type="button" role="menuitem" className="sx-menuitem" onClick={() => { setMenuOpen(false); setMembersOpen(true); }}>
                <Users size={14} /> {t('Members', '群成员')}
              </button>
            </div>
          )}
        </header>

        <div className="sx-group-scroll" ref={scrollRef} onScroll={onScroll}>
          {loading && <div className="sx-group-empty">{t('Loading…', '加载中…')}</div>}
          {!loading && messages.length === 0 && (
            <div className="sx-group-empty">
              <div className="sx-group-empty-title">{detail?.group.name ?? t('Group', '群组')}</div>
              <div>{t('Type @ to pick members; @all dispatches to everyone.', '输入 @ 选择成员，@全体成员 分发给全员')}</div>
            </div>
          )}
          {hasMore && <button type="button" className="sx-group-older" onClick={() => { void loadOlder(); }}>{t('Load earlier', '加载更早')}</button>}
          {messages.map((m) => m.kind === 'human' ? (
            <RightBubble
              key={m.id}
              message={m}
              quoteSeq={m.replyTo !== undefined ? messages.find((x) => x.id === m.replyTo)?.seq : undefined}
              expanded={expanded}
              onToggleExpand={(id) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
              onReceipt={() => openReceipt(m)}
              receiptOpen={receipt?.id === m.id}
              onCloseReceipt={() => setReceipt(null)}
              onOpenMember={onOpenMember}
              onReply={(x) => setReplyTo({ id: x.id, preview: firstLine(x.replyPreview?.text ?? x.text) })}
              onReveal={(seq) => { void revealSeq(seq); }}
              activeSeq={activeSeq}
              nodeRef={(el) => { if (el !== null) nodeBySeq.current.set(m.seq, el); else nodeBySeq.current.delete(m.seq); }}
            />
          ) : (
            <LeftBubble
              key={m.id}
              message={m}
              quoteSeq={m.replyTo !== undefined ? messages.find((x) => x.id === m.replyTo)?.seq : undefined}
              expanded={expanded.has(m.id)}
              onToggleExpand={() => setExpanded((prev) => { const next = new Set(prev); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next; })}
              onOpenMember={onOpenMember}
              onReveal={(seq) => { void revealSeq(seq); }}
              onReply={() => setReplyTo({ id: m.id, preview: firstLine(m.text) })}
              active={activeSeq === m.seq}
              nodeRef={(el) => { if (el !== null) nodeBySeq.current.set(m.seq, el); else nodeBySeq.current.delete(m.seq); }}
            />
          ))}
        </div>

        <div className="sx-group-composer">
          {askItems.length > 0 && (
            <div className="ask-dock sx-group-asks">
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
          )}
          {/* 输入卡复用会话/欢迎页同一份 ComposerCard（2026-11-26 用户裁定「群组输入框样式不使用
              项目已有的输入框样式？」）：卡面/图片条/自增高/脚底 pills 全走 .sx-composer；群组只
              提供 @/命令/图片/模型/权限这些数据与动作。引用条与错误条走卡内 belowInput。 */}
          <ComposerCard
            className="composer"
            label={t('Message the group…', '发消息到群聊…')}
            inputRef={inputRef}
            value={input}
            placeholder={t('Message the group…', '发消息到群聊…')}
            rows={1}
            images={images}
            onRemoveImage={(i) => setImages((prev) => prev.filter((_, j) => j !== i))}
            onPasteFiles={(files) => { void addImages(files); }}
            onChange={(v) => {
              setInput(v);
              const caret = inputRef.current?.selectionStart ?? v.length;
              const m = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
              if (m !== null) {
                setMentionOpen(true);
                setMentionQuery(m[2] ?? '');
                setMentionFrom(caret - (m[2]?.length ?? 0) - 1);
              } else {
                setMentionOpen(false);
                setMentionFrom(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            belowInput={
              <>
                {replyTo !== null && (
                  <div className="sx-group-reply">
                    <span className="sx-group-reply-label">{t('Replying', '回复')}: {replyTo.preview}</span>
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
                  <Plus size={16} strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  className="composer-pill"
                  aria-label="mention member"
                  data-tip={t('Mention member', '提及成员')}
                  onClick={() => { setPlusOpen(false); setSettingsPop(null); setMentionFrom(null); setMentionQuery(''); setMentionOpen((v) => !v); }}
                >
                  <span className="sx-group-at">@</span>
                </button>
                <span className="pill-anchor">
                  <button
                    type="button"
                    className="composer-pill mode-pill"
                    aria-label={t('Model', '模型')}
                    aria-expanded={settingsPop === 'model'}
                    onClick={() => { setPlusOpen(false); setMentionOpen(false); setSettingsPop((v) => (v === 'model' ? null : 'model')); }}
                  >
                    <span className="sx-group-muted">{t('Model', '模型')}</span>
                    <span className="pill-label">{modelLabel}</span>
                    <ChevronDown size={12} strokeWidth={2} className="pill-chevron" />
                  </button>
                  {settingsPop === 'model' && (
                    <div className="sx-menu-pop pill-pop" role="menu">
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
                <span className="pill-anchor">
                  <button
                    type="button"
                    className="composer-pill mode-pill"
                    aria-label={t('Permission', '权限')}
                    aria-expanded={settingsPop === 'mode'}
                    onClick={() => { setPlusOpen(false); setMentionOpen(false); setSettingsPop((v) => (v === 'mode' ? null : 'mode')); }}
                  >
                    <span className="sx-group-muted">{t('Permission', '权限')}</span>
                    <span className="pill-label">{modeLabel}</span>
                    <ChevronDown size={12} strokeWidth={2} className="pill-chevron" />
                  </button>
                  {settingsPop === 'mode' && (
                    <div className="sx-menu-pop pill-pop" role="menu">
                      <button type="button" role="menuitem" className={`sx-menuitem${mode === '' ? ' current' : ''}`} onClick={() => { setMode(''); setSettingsPop(null); }}>
                        {t('Follow members', '跟随成员')}
                      </button>
                      {(['read-only', 'acceptEdits', 'full-access'] as const).map((m) => (
                        <button key={m} type="button" role="menuitem" className={`sx-menuitem${mode === m ? ' current' : ''}`} onClick={() => { setMode(m); setSettingsPop(null); }}>
                          {sessionModeLabel(m)}
                        </button>
                      ))}
                    </div>
                  )}
                </span>
              </div>
            }
            footRight={
              <button type="button" className="send" aria-label="send" disabled={sending || (input.trim() === '' && images.length === 0)} onClick={() => { void send(); }}>
                <Send size={16} strokeWidth={2} />
              </button>
            }
            overlays={
              <>
                {plusOpen && (
                  <ComposerPlusPanel
                    conn={conn}
                    excludeCommands={SUNX_EXCLUDED_COMMANDS}
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
                        <span className="sx-group-at">@</span>{t('All members', '全体成员')}
                      </button>
                      {mentionCandidates.map((m) => (
                        <button key={m.id} type="button" role="menuitem" className="sx-menuitem" onClick={() => addMention(m)}>
                          <SunxIcon size={14} /> {m.name}
                          <span className="sx-group-muted">
                            {m.awaiting === true ? t('awaiting input', '等待回答') : m.running ? t('running', '运行中') : m.live ? t('idle', '空闲') : t('not open', '未打开')}
                          </span>
                        </button>
                      ))}
                    </div>
                    {mentionCandidates.length === 0 && <div className="proj-empty">{t('No members', '暂无成员')}</div>}
                  </div>
                )}
                {showCommandPalette && commandCandidates.length > 0 && (
                  <div className="proj-pop sx-group-palette" role="menu">
                    <div className="proj-rows-scroll">
                      {commandCandidates.map((cmd) => (
                        <button key={cmd} type="button" role="menuitem" className="sx-menuitem" onClick={() => addCommand(cmd)}>
                          <span>{cmd}</span>
                          {DESTRUCTIVE.has(cmd) && <span className="sx-group-badge">{t('single', '仅单个')}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            }
          />
        </div>
      </div>

      {searchOpen && (
        <aside className="sx-group-search" aria-label={t('Search group messages', '查询群消息')}>
          <div className="sx-group-search-head">
            <Search size={16} strokeWidth={1.75} />
            <span>{t('Search', '查询')}</span>
            <button type="button" className="sx-iconbtn" aria-label="close search" onClick={onSearchClose}><X size={14} /></button>
          </div>
          <div className="sx-group-search-bar">
            <input ref={searchInputRef} value={searchQ} placeholder={t('Search messages', '查询群消息')} onChange={(e) => setSearchQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} />
            <button type="button" disabled={searchBusy} onClick={() => { void runSearch(); }}>{t('Search', '查询')}</button>
          </div>
          <div className="sx-group-search-results">
            {searchHits.length === 0 && <div className="proj-empty">{searchQ.trim() === '' ? t('Type to search', '输入关键词查询') : t('No matches', '无匹配消息')}</div>}
            {searchHits.map((h) => (
              <button
                key={h.id}
                type="button"
                className={`sx-group-search-hit${activeSeq === h.seq ? ' active' : ''}`}
                onClick={() => { void revealSeq(h.seq); }}
              >
                <span className="sx-group-search-meta">{h.from.kind === 'group' ? t('Owner', '群主') : h.from.name} · {fmtTime(h.ts)}</span>
                <span className="sx-group-search-text">
                  {highlight(h.text, searchQ).map((part, i) => part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>)}
                </span>
              </button>
            ))}
          </div>
        </aside>
      )}

      {membersOpen && createPortal(
        <div className="modal-overlay" onClick={() => setMembersOpen(false)}>
          <div className="modal-body sx-group-members" role="dialog" aria-label={t('Members', '群成员')} onClick={(e) => e.stopPropagation()}>
            <div className="sx-group-members-head">
              <span>{t('Members', '群成员')} · {members.length}</span>
              <button type="button" className="sx-iconbtn" aria-label="close" onClick={() => setMembersOpen(false)}><X size={14} /></button>
            </div>
            <div className="sx-group-members-list">
              {members.map((m) => (
                <button key={m.id} type="button" className="sx-group-member-row" onClick={() => onOpenMember(m.id)}>
                  <SunxIcon size={16} />
                  <span className="sx-group-member-name">{m.name}</span>
                  <span className="sx-group-muted">{m.awaiting === true ? t('awaiting input', '等待回答') : m.running ? t('running', '运行中') : m.live ? t('idle', '空闲') : t('not open', '未打开')}</span>
                  <span className="sx-group-member-root">{m.root}</span>
                  <span className="sx-group-muted">{m.runs !== undefined ? `runs ${m.runs}` : ''}{m.steps !== undefined ? ` · steps ${m.steps}` : ''}</span>
                </button>
              ))}
              {members.length === 0 && <div className="proj-empty">{t('No Sunx yet', '暂无 Sunx')}</div>}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {nameOpen && createPortal(
        <div className="modal-overlay" onClick={() => setNameOpen(false)}>
          <div className="modal-body rename-dialog" role="dialog" aria-label={t('Rename group', '编辑群名')} onClick={(e) => e.stopPropagation()}>
            <div className="dirpicker-head">{t('Rename group', '编辑群名')}</div>
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

      {copied && <div className="sx-group-toast">{t('Copied', '已复制')}</div>}
    </div>
  );
}

function renderMentionText(text: string, all: boolean, mentions: SunxRoomTarget[]): JSX.Element[] {
  const memberTokens = new Set(mentions.map((x) => `@${x.name}`));
  const tokens = [...(all ? ['@全体成员'] : []), ...memberTokens].sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return [<span key="all">{text}</span>];
  const esc = tokens.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${esc.join('|')})`, 'g');
  return text
    .split(re)
    .filter((part) => part !== '')
    .map((part, i) => (tokens.includes(part)
      ? (
        <span key={i} className="sx-group-chip">
          {memberTokens.has(part) && <SunxIcon size={14} strokeWidth={1.75} />}
          {part}
        </span>
      )
      : <span key={i}>{part}</span>));
}

/** 右侧群主气泡：@ 内联 chips + 环形饼图回执（全部完成圆内 √）+ 两栏弹窗。 */
function RightBubble(props: {
  message: SunxRoomMessage;
  quoteSeq?: number;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  onReceipt: () => void;
  receiptOpen: boolean;
  onCloseReceipt: () => void;
  onOpenMember: (jid: string) => void;
  onReply: (m: SunxRoomMessage) => void;
  onReveal: (seq: number) => void;
  activeSeq: number | null;
  nodeRef: (el: HTMLDivElement | null) => void;
}): JSX.Element {
  const { message: m, quoteSeq, receiptOpen, onCloseReceipt, onOpenMember, onReply, onReveal, activeSeq, nodeRef } = props;
  const targets = m.targets ?? [];
  const deliveries = m.deliveries ?? [];
  const okCount = deliveries.filter((d) => d.ok).length;
  const pending = targets.length - deliveries.length;
  return (
    <div className={`sx-group-row right${activeSeq === m.seq ? ' active' : ''}`} ref={nodeRef}>
      <div className="sx-group-right-wrap">
        <div className="sx-group-human" onDoubleClick={() => onReply(m)}>
          {m.replyPreview !== undefined && (
            <button
              type="button"
              className="sx-group-quote"
              onClick={() => { if (quoteSeq !== undefined) onReveal(quoteSeq); }}
              data-tip={t('Jump to quoted message', '跳到引用气泡')}
            >
              {m.replyPreview.text}
            </button>
          )}
          <div className="sx-group-human-text">{renderMentionText(m.text, m.mentionAll === true, m.mentions ?? [])}</div>
          {(m.images ?? []).length > 0 && (
            <div className="sx-group-human-images">
              {(m.images ?? []).map((src, i) => (
                <img key={`${i}-${src.slice(0, 24)}`} src={src} alt={`${t('Attached image', '附件图片')} ${i + 1}`} />
              ))}
            </div>
          )}
          <div className="sx-group-human-foot">
            <span>{fmtTime(m.ts)}</span>
            {targets.length > 0 && (
              <button type="button" className="sx-group-receipt-btn" aria-label="delivery receipt" data-tip={`${okCount}/${targets.length} ${t('delivered', '已送达')}`} onClick={(e) => { e.stopPropagation(); props.onReceipt(); }}>
                <ReceiptRing ok={okCount} total={targets.length} pending={pending} />
              </button>
            )}
          </div>
          {receiptOpen && (
            <DeliveryPop
              message={m}
              onClose={onCloseReceipt}
              onOpenMember={onOpenMember}
              onReveal={onReveal}
            />
          )}
        </div>
        <div className="sx-group-row-actions">
          <button type="button" aria-label="reply" onClick={() => onReply(m)}>{t('Reply', '回复')}</button>
        </div>
      </div>
    </div>
  );
}

/** 环形饼图：成功占比；全成=实心圆+√。 */
function ReceiptRing({ ok, total, pending }: { ok: number; total: number; pending: number }): JSX.Element {
  const r = 7;
  const c = 2 * Math.PI * r;
  const pct = total === 0 ? 0 : Math.min(1, ok / total);
  if (total > 0 && ok === total) {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="sx-group-ring done">
        <circle cx="9" cy="9" r="8" fill="currentColor" />
        <path d="M5.2 9.2l2.4 2.4 5-5.2" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className={`sx-group-ring${pending > 0 ? ' pending' : ''}${ok === 0 && total > 0 ? ' failed' : ''}`}>
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 9 9)" strokeLinecap="round" />
    </svg>
  );
}

/** 两栏回执：左已接收/右未接收，各自固定高度滚动；点成员名开对应 Sunx。 */
function DeliveryPop(props: { message: SunxRoomMessage; onClose: () => void; onOpenMember: (jid: string) => void; onReveal: (seq: number) => void }): JSX.Element {
  const { message: m, onClose, onOpenMember } = props;
  const targets = m.targets ?? [];
  const deliveries = m.deliveries ?? [];
  const byTo = new Map(deliveries.map((d) => [d.to, d]));
  const received: Array<{ t: SunxRoomTarget; d: SunxRoomDelivery }> = [];
  const pending: SunxRoomTarget[] = [];
  const failed: Array<{ t: SunxRoomTarget; d: SunxRoomDelivery }> = [];
  for (const t of targets) {
    const d = byTo.get(t.id);
    if (d === undefined) pending.push(t);
    else if (d.ok) received.push({ t, d });
    else failed.push({ t, d });
  }
  const not = [...pending, ...failed];
  return (
    <div className="sx-group-delivery" role="dialog" aria-label="delivery receipt" onClick={(e) => e.stopPropagation()}>
      <div className="sx-group-delivery-head">
        <span>{received.length}/{targets.length} {t('delivered', '已送达')}</span>
        <button type="button" aria-label="close" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="sx-group-delivery-cols">
        <div className="sx-group-delivery-col">
          <div className="sx-group-delivery-title">{t('Received', '已接收')} · {received.length}</div>
          <div className="sx-group-delivery-scroll">
            {received.map(({ t: target, d }) => (
              <button key={target.id} type="button" className="sx-group-delivery-row" onClick={() => onOpenMember(target.id)}>
                <span className="sx-group-dot ok" /> {target.name}
                {d.queued === true && <span className="sx-group-muted">{t('queued', '已排队')}</span>}
              </button>
            ))}
            {received.length === 0 && <div className="proj-empty">—</div>}
          </div>
        </div>
        <div className="sx-group-delivery-col">
          <div className="sx-group-delivery-title">{t('Not received', '未接收')} · {not.length}</div>
          <div className="sx-group-delivery-scroll">
            {pending.map((target) => (
              <div key={target.id} className="sx-group-delivery-row">
                <span className="sx-group-dot pending" /> {target.name}
                <span className="sx-group-muted">{t('sending', '发送中')}</span>
              </div>
            ))}
            {failed.map(({ t: target, d }) => (
              <div key={target.id} className="sx-group-delivery-row">
                <span className="sx-group-dot failed" /> {target.name}
                <span className="sx-group-muted" data-tip={d.error ?? ''}>{d.error ?? t('failed', '失败')}</span>
              </div>
            ))}
            {not.length === 0 && <div className="proj-empty">—</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 左侧成员气泡：发送行在气泡上方；单卡片 480px；第一行引用（单行、无发送者）点击滚到目标。 */
function LeftBubble(props: {
  message: SunxRoomMessage;
  quoteSeq?: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onOpenMember: (jid: string) => void;
  onReveal: (seq: number) => void;
  onReply: () => void;
  active: boolean;
  nodeRef: (el: HTMLDivElement | null) => void;
}): JSX.Element {
  const { message: m, quoteSeq, expanded, onToggleExpand, onOpenMember, onReveal, onReply, active, nodeRef } = props;
  const quote = m.replyPreview;
  const isCommand = m.kind === 'command';
  const long = m.text.length > 600 || m.text.split('\n').length > 8;
  return (
    <div className={`sx-group-row left${active ? ' active' : ''}`} ref={nodeRef}>
      <div className="sx-group-sender">
        <button type="button" className="sx-group-name-btn" onClick={() => onOpenMember(m.from.id)}>
          <SunxIcon size={14} /> {m.from.name}
        </button>
        {m.to !== undefined && (
          <>
            <span className="sx-group-muted">{t('to', '发送给')}</span>
            {m.to.kind === 'group' ? (
              <span className="sx-group-name-btn static"><SunxIcon size={14} /> {t('Owner', '群主')}<span className="sx-group-badge">{t('owner', '群主')}</span></span>
            ) : (
              <button type="button" className="sx-group-name-btn" onClick={() => onOpenMember(m.to!.id)}>
                <SunxIcon size={14} /> {m.to.name}
              </button>
            )}
          </>
        )}
      </div>
      <div className={`sx-group-bubble${expanded ? ' expanded' : ''}`}>
        {quote !== undefined && (
          <button
            type="button"
            className="sx-group-quote"
            onClick={() => { if (quoteSeq !== undefined) onReveal(quoteSeq); }}
            data-tip={t('Jump to quoted message', '跳到引用气泡')}
          >
            {quote.text}
          </button>
        )}
        {isCommand && <div className="sx-group-cmd-badge">{m.command}</div>}
        {isCommand ? (
          <pre className="sx-group-command-text">{m.text}</pre>
        ) : (
          <div className="sx-group-md"><MarkdownCached md={m.text} components={mdComponentsPlain} /></div>
        )}
        {long && !expanded && (
          <button type="button" className="sx-group-expand" onClick={onToggleExpand}>
            <ChevronDown size={14} /> {t('Expand all', '展开全部')}
          </button>
        )}
        {long && expanded && (
          <button type="button" className="sx-group-expand" onClick={onToggleExpand}>
            {t('Collapse', '收起')}
          </button>
        )}
      </div>
      <div className="sx-group-foot">
        <span>{fmtTime(m.ts)}</span>
        <button type="button" aria-label="copy" onClick={() => { void navigator.clipboard?.writeText(m.text); }}><Copy size={14} /></button>
        <button type="button" aria-label="reply" onClick={onReply}>{t('Reply', '回复')}</button>
      </div>
    </div>
  );
}
