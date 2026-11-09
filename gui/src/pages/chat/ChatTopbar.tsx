import { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Check, ChevronDown, Code2, Copy, MailOpen, MoreHorizontal, PanelLeft, PenLine, Pin, PinOff } from 'lucide-react';
import { icons as vscodeIcons } from '@iconify-json/vscode-icons';
import { t } from '../../i18n';
import { editorIconCached, editorIconPut, OPEN_DEFAULT_KEY } from '../../ui-util';
import type { Connection } from '../../connection';
import type { NavControls } from '../../nav-history';
import { NavButtons } from '../../NavButtons';
import { SessionRowMenu } from '../../sidebar/session-row-menu';
import { loadSeenMap, persistSeenMap, stampSeen, suppressAutoSeen } from '../../sidebar/project-menu-util';
import type { PinEntry } from '../../sidebar/pin-store';
import { COPY_RESET_MS } from '../../use-copy-feedback';

/** 会话顶栏(D32 第六批批F-3 自 Chat.tsx 平移,行为零变化):标题(空/改/显三态,点击重命名)
 *  + 动态计数钮(待办/任务板)+ 侧栏展开钮。标题编辑态与草稿留宿主。
 *  批F-7d:ChatDynButtons 自宿主整迁本文件(唯一消费方,值回引环消解)。 */

/** G14.177 顶栏动态计数按钮(待办/任务/后台任务):转圈图标+数量;点击开对应页签。
 *  G14.213 原子化三改:①仅运行中显示(轮次收束即隐,待办是否完结无关);②侧栏展开不再隐藏
 *  (挂载点去掉 collapsed 门);③幽灵钮化——无底色。
 *  G14.2xx 用户裁定:常显(旧「顶栏 hover 浮现」退役);三钮图标统一灰色转圈(待办钮的绿对号
 *  退役——对号读作「已完成数」与计数语义相反;todoActive 本就是 in_progress+pending 之和) */
export function ChatDynButtons({ todoActive, taskActive, bgRunning, running, onOpenTab }: {
  todoActive: number;
  taskActive: number;
  /** 后台 running 数(App 经 bg-task 直播维护,撤 5s GET 轮询) */
  bgRunning: number;
  running: boolean;
  onOpenTab?: (type: 'tasks' | 'agents' | 'bgtasks') => void;
}): JSX.Element | null {
  // G14.213 轮次收束即隐:running 熄灭按钮组整体不显(待办/任务是否完结无关)
  // 过多隐现(2026-10-29 用户裁定「只有真的显示才占会话名位置;过多隐现」):容器被压缩时挂
  // tight 右缘渐隐 mask(与标题 clipped 同款 RO 判定);压缩优先级由 flex 收缩权重承担
  // (.chat-dyn-buttons shrink 999——空间不足几乎全由本组吸收,标题不因让位被裁到看不全)
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tight, setTight] = useState(false);
  // 待办/团队任务随轮次收束即隐;后台任务不受轮次门控——进程独立于轮次存活(含应用重启后仍在跑
  // 的任务,会话此时空闲),只要还有 running 就显示
  const todoShown = running && todoActive > 0;
  const taskShown = running && taskActive > 0;
  const bgShown = bgRunning > 0;
  const shown = todoShown || taskShown || bgShown;
  useEffect(() => {
    const el = wrapRef.current;
    if (!shown || el === null) return;
    const judge = (): void => setTight(el.scrollWidth > el.clientWidth + 1);
    judge();
    const ro = new ResizeObserver(judge);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown, todoActive, taskActive, bgRunning]);
  if (!shown) return null;

  return (
    <div className={`chat-dyn-buttons${tight ? ' tight' : ''}`} ref={wrapRef} role="group" aria-label="live counters">
      {todoShown && (
        <button type="button" className="chat-dyn-btn todo" data-tip={t('Open todos', '打开待办')} onClick={() => onOpenTab?.('tasks')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${todoActive} todos`, `${todoActive} 待办`)}
        </button>
      )}
      {taskShown && (
        <button type="button" className="chat-dyn-btn" data-tip={t('Open agent teams', '打开智能体团队')} onClick={() => onOpenTab?.('agents')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${taskActive} team tasks`, `${taskActive} 团队任务`)}
        </button>
      )}
      {bgShown && (
        <button type="button" className="chat-dyn-btn" data-tip={t('Open background tasks', '打开后台任务')} onClick={() => onOpenTab?.('bgtasks')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${bgRunning} background`, `${bgRunning} 后台任务`)}
        </button>
      )}
    </div>
  );
}
export interface ChatTopbarProps {
  readonly fixedTitle: string | undefined;
  readonly titleEditing: boolean;
  readonly titleDraft: string;
  readonly setTitleDraft: (v: string) => void;
  readonly commitTitle: () => void;
  readonly setTitleEditing: (v: boolean) => void;
  readonly displayTitle: string;
  readonly sessionId: string;
  readonly tokens: number;
  readonly steps: number;
  readonly running: boolean;
  readonly todoActive: number;
  readonly taskActive: number;
  /** 后台 running 数(App bg-task 直播) */
  readonly bgRunning?: number;
  readonly conn: Connection;
  readonly onOpenTab?: ((type: 'tasks' | 'agents' | 'bgtasks') => void);
  /** 「打开」分体钮失败可见化面(D57④:App showOpError 经 Chat 透传,探测/打开失败 sx-toast) */
  readonly onOpError?: (err: unknown) => void;
  /** 归档态(2026-10-21):快照播种对齐——true 显徽标+撤销钮,false 显归档钮(确认 morph) */
  readonly archived: boolean;
  /** 归档/撤销归档上抛(落 conn.archiveSession;本地 archived 同步归宿主 Chat) */
  readonly onArchive: (archived: boolean) => void;
  /** 会话档身份(置顶档寻址——journalId 跨重启稳定) */
  readonly journalId?: string;
  /** 会话工作区根(置顶条目快照字段) */
  readonly root?: string;
  /** 会话数据变更上抛(置顶/归档/标记未读后,宿主 bump 侧栏联动刷新) */
  readonly onSessionsMutated?: () => void;
  /** 置顶档单源(2026-11-07 置顶卡顿根修):App 乐观态直读,点击零往返(原 GET→取反→PUT 双往返=卡一下) */
  readonly pins?: PinEntry[];
  readonly persistPins?: (next: PinEntry[]) => void;
  /** 2026-10-24 用户裁定:[|] 切换钮=菜单关闭态显示在会话名左(呼出);菜单开着时收起钮在菜单头右上(不双显) */
  readonly menuClosed?: boolean;
  readonly onToggleMenu?: () => void;
  /** 2026-10-25 应用级导航(前进/后退)控制面(App 壳持历史);缺场不渲染钮对(旁路 Chat 免配) */
  readonly nav?: NavControls;
  /** 2026-10-27 电脑控制指示:控制类 computer-use 工具条在跑(use-chat-derived 派生)——顶栏会话名行右亮「正在控制」边框徽标 */
  readonly computerUseActive?: boolean;
}

export function ChatTopbar(props: ChatTopbarProps): JSX.Element {
  const { fixedTitle, titleEditing, titleDraft, setTitleDraft, commitTitle, setTitleEditing, displayTitle, sessionId, running, todoActive, taskActive, bgRunning = 0, computerUseActive, conn, onOpenTab, onOpError, archived, onArchive, journalId, root, onSessionsMutated, pins: pinsList, persistPins, menuClosed, onToggleMenu, nav } = props;
  // ⋯ 会话操作菜单(2026-10-22 用户裁定:归档直连钮收敛为 ⋯ 弹窗——置顶⇄/归档⇄,运行中禁用)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 归档二次弹窗确认(2026-10-23 用户裁定):菜单点「归档会话」不直执行,先弹 确认归档|取消
  const [askArchive, setAskArchive] = useState<{ x: number; y: number } | null>(null);
  // 「打开」分体钮(2026-10-27 用户需求):工作区一键进资源管理器/编辑器——主钮开默认应用,
  // ∨ 菜单列已装预设(只有实际安装的才显示,daemon 探测),点选即设默认(✓)并打开。
  // 默认应用 localStorage 持久(机器级偏好,同 zoom/theme 口径)
  const [editorMenu, setEditorMenu] = useState<{ x: number; y: number } | null>(null);
  const [editors, setEditors] = useState<Array<{ id: string; name: string }>>([]);
  const [defaultEditor, setDefaultEditor] = useState<string>(() => localStorage.getItem(OPEN_DEFAULT_KEY) ?? 'explorer');
  const openIn = (id: string): void => {
    if (root === undefined || root === '') return;
    // 失败可见化(D57④:探测后应用被卸载/daemon 异常——主钮常驻,静默吞=点了没反应)
    conn.openInEditor(root, id).catch((err: unknown) => onOpError?.(err));
  };
  /** 原生图标拉取(D57② 双 effect 归一):进入会话预取全部;菜单打开时对缺失项补拉(服务端有
   *  失败负缓存,重试 404 即回零成本)。拉取失败**不落空串**——留 undefined 走品牌字形回落,
   *  下次菜单开自然重试(原「失败标记 '' 永不重试」缺陷根除) */
  const fetchIcon = (id: string): void => {
    if (typeof conn.editorIcon !== 'function') return; // 测试桩/旧 daemon:优雅跳过(图标回落集内字形)
    void conn
      .editorIcon(id)
      .then((ic) => {
        const url = `data:${ic.mime};base64,${ic.data}`;
        editorIconPut(id, url); // 模块级缓存(跨会话/重挂存续,2026-11-07 抖动根修)
        setNativeIcons((m) => ({ ...m, [id]: url }));
      }, () => undefined);
  };
  /** 预取前置(2026-10-28 用户反馈:菜单首开才拉,窗口期渲染 1/4 加载态):进入会话即拉
    应用列表+逐个原生图标——菜单打开时全部热数据 */
  useEffect(() => {
    if (typeof conn.editorsList !== 'function') return; // 测试桩/旧 daemon:优雅跳过(图标回落集内字形)
    let alive = true;
    void conn
      .editorsList()
      .then((r) => {
        if (!alive) return;
        setEditors(r.editors);
        for (const e of r.editors) fetchIcon(e.id);
      }, (err: unknown) => {
        if (alive) onOpError?.(err); // 探测失败可见化(D57④:静默=∨ 菜单零项且无解释)
      });
    return () => {
      alive = false;
    };
  }, [conn, onOpError]);
  const toggleEditorMenu = (anchor: HTMLElement): void => {
    if (editorMenu !== null) {
      setEditorMenu(null);
      return;
    }
    const b = anchor.getBoundingClientRect();
    setEditorMenu({ x: b.right, y: b.bottom + 2 });
  };
  /** 菜单点选=只设默认(✓ 移交+主钮图标随换),**不启动**——启动统一走主钮
    (2026-10-27 用户裁定:点行即开应用会误触) */
  const pickEditor = (id: string): void => {
    localStorage.setItem(OPEN_DEFAULT_KEY, id);
    setDefaultEditor(id);
    setEditorMenu(null);
  };
  /** 应用图标(2026-10-27 用户裁定:用**原生图标**):daemon 从 exe 资源段抽取(机器级缓存),
    dataURL 直显;未取到回落 vscode-icons 集内字形,未知 id 回落 Code2 线性图标 */
  const [nativeIcons, setNativeIcons] = useState<Record<string, string>>({});
  useEffect(() => {
    if (editorMenu === null) return;
    for (const e of editors) {
      // 缺失即补拉(无失败永久标记——服务端负缓存使重试零成本)
      if (nativeIcons[e.id] === undefined) fetchIcon(e.id);
    }
  }, [editorMenu, editors, nativeIcons]);
  const editorIcon = (id: string, size = 18): JSX.Element => {
    // 模块级缓存优先(2026-11-07 抖动根修):App 启动预取后,会话首帧即命中真图标零跳变
    const native = nativeIcons[id] ?? editorIconCached(id);
    // 拉到原生图标直显;失败/未拉到回落品牌字形(D57②:失败不再落 '' 恒跳 Code2——下次菜单开重试)
    if (native !== undefined) return <img src={native} alt="" style={{ width: size, height: size, display: 'block', objectFit: 'contain' }} />;
    const key = id === 'explorer' ? 'default-folder' : id === 'vscode' ? 'file-type-vscode' : id === 'cursor' ? 'folder-type-cursor' : '';
    const body = key === '' ? undefined : (vscodeIcons.icons as Record<string, { body: string } | undefined>)[key]?.body;
    if (body === undefined) return <Code2 size={size - 2} strokeWidth={1.75} />;
    return (
      // 回落字形盒面与真图标同尺寸(2026-11-07 用户裁定「1/4 放大转正常大小」的跳变也源于此:
      // 字形 14/真图标 18 两档)——缓存未命中的首帧也不跳
      <span
        style={{ width: size, height: size, display: 'inline-flex', flex: 'none' }}
        dangerouslySetInnerHTML={{ __html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}">${body}</svg>` }}
      />
    );
  };
  // 2026-10-24 用户裁定「能显示全就显示全」:标题隐现 mask 仅在真溢出时挂(RO 判 scrollWidth)
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [titleClipped, setTitleClipped] = useState(false);
  useEffect(() => {
    const el = titleRef.current;
    if (el === null) return;
    const judge = (): void => setTitleClipped(el.scrollWidth > el.clientWidth + 1);
    judge();
    const ro = new ResizeObserver(judge);
    ro.observe(el);
    return () => ro.disconnect();
  }, [displayTitle]);
  const [pinned, setPinned] = useState(false);
  const loadPinned = (): void => {
    if (journalId === undefined) return;
    conn.appPins().then(
      (r) => setPinned(r.pins.some((p) => p.id === journalId)),
      () => undefined,
    );
  };
  /** 已读面压制到 at(stampSeen 单点:localStorage 即时+服务端双写)——置顶时与钉档时间戳对齐用 */
  const touchSeen = (at: number): Promise<void> =>
    journalId === undefined ? Promise.resolve() : stampSeen(conn, journalId, at);
  const togglePin = (): void => {
    if (journalId === undefined) return;
    const pins = pinsList ?? [];
    const isPinned = pins.some((p) => p.id === journalId) || pinned;
    const now = Date.now();
    const rest = pins.filter((p) => p.id !== journalId);
    // 新钉居前(与侧栏 pinRow 同口径);乐观直更(App 单源 setPins 即侧栏即时生效,零往返)
    const next = isPinned ? rest : [{ id: journalId, root: root ?? '', title: displayTitle !== '' ? displayTitle : t('New session', '新会话'), updatedAt: now }, ...rest];
    setPinned(!isPinned);
    persistPins?.(next);
    // 置顶即正在看:已读戳压到钉档同一时刻(钉组判未读不同刻恒亮蓝点);落库后联动侧栏
    const chain = isPinned ? Promise.resolve() : touchSeen(now);
    void chain.then(onSessionsMutated, onSessionsMutated);
  };
  /* 2026-11-06 用户裁定:复制回显全局统一——点击后菜单项尾显 ✓(COPY_RESET_MS 自回),
     与正文代码块(图标换 ✓)/Files 路径菜单(tail ✓)同款,不再静默复制 */
  const [copiedTag, setCopiedTag] = useState('');
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyText = (text: string, tag: string): void => {
    void navigator.clipboard?.writeText(text).then(() => setCopiedTag(tag), () => setCopiedTag(''));
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedTag(''), COPY_RESET_MS);
  };
  const markUnread = (): void => {
    if (journalId === undefined) return;
    suppressAutoSeen(journalId); // 蓝点压制旗(2026-11-07):打开面压读 effects/侧栏自动已读见旗即跳
    const seen = loadSeenMap();
    delete seen[journalId];
    persistSeenMap(seen); // 本地标记已即时生效——联动成败都上抛(旧 daemon PUT 404 不吞联动)
    if (typeof conn.saveAppSeen !== 'function') {
      onSessionsMutated?.();
      return;
    }
    void conn.saveAppSeen(seen).then(onSessionsMutated, onSessionsMutated);
  };
  const menuItems = [
    {
      id: 'pin',
      label: pinned ? t('Unpin session', '取消置顶会话') : t('Pin session', '置顶会话'),
      icon: pinned ? <PinOff size={14} strokeWidth={1.75} aria-hidden="true" /> : <Pin size={14} strokeWidth={1.75} aria-hidden="true" />,
      // 已归档冻结置顶态(2026-10-22 用户裁定);2026-11-07 撤运行中禁用(用户裁定「运行中也能
      // 置顶,只是切换显示位置」)
      disabled: archived,
      onSelect: () => {
        // 只调 togglePin——它按服务端现态取反且落库后才上抛联动;此处再 loadPinned()
        // 会 GET 到 PUT 落库前的旧档,把刚置的状态打回去(「第一次无效、后续反向」元凶)
        togglePin();
      },
    },
    {
      id: 'archive',
      label: archived ? t('Unarchive session', '取消归档会话') : t('Archive session', '归档会话'),
      icon: archived ? <ArchiveRestore size={14} strokeWidth={1.75} aria-hidden="true" /> : <Archive size={14} strokeWidth={1.75} aria-hidden="true" />,
      // 2026-11-07 用户裁定撤运行中禁用:归档运行中会话=切换显示位置(卷起),不杀运行
      disabled: false,
      onSelect: () => {
        if (archived) onArchive(false);
        else setAskArchive(menu); // 二次确认弹窗(坐标沿用菜单锚点;菜单项回调里 menu 必非空)
      },
    },
    { id: 'divider-1', divider: true, label: '', onSelect: () => undefined },
    {
      id: 'rename',
      label: t('Rename session', '重命名会话'),
      icon: <PenLine size={14} strokeWidth={1.75} aria-hidden="true" />,
      onSelect: () => {
        setTitleDraft(displayTitle);
        setTitleEditing(true);
      },
    },
    {
      id: 'mark-unread',
      label: t('Mark as unread', '标记为未读'),
      icon: <MailOpen size={14} strokeWidth={1.75} aria-hidden="true" />,
      onSelect: () => {
        markUnread(); // 联动已内含(落库后上抛)
      },
    },
    { id: 'divider-2', divider: true, label: '', onSelect: () => undefined },
    {
      id: 'copy-id',
      label: t('Copy session ID', '复制会话 ID'),
      icon: copiedTag === 'id' ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />,
      keepOpen: true,
      onSelect: () => copyText(sessionId, 'id'),
    },
    {
      id: 'copy-path',
      label: t('Copy path', '复制路径'),
      icon: copiedTag === 'path' ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />,
      keepOpen: true,
      onSelect: () => copyText(root ?? '', 'path'),
    },
  ];
  return (
    <header className="chat-topbar" data-drag-band>
        {/* 2026-10-25 应用级导航(前进/后退):菜单关闭态才驻顶栏最左——菜单开着时由菜单头承载
            (2026-10-25 用户裁定「菜单存在显示在菜单里,收起才显示在当前位置」,单点不双显) */}
        {nav !== undefined && menuClosed === true && <NavButtons nav={nav} />}
        {/* 2026-10-24 用户裁定(二轮修正):[|] 仅菜单关闭态显示在会话名左(呼出);菜单开着时收起钮
            在菜单头右上,不双显。会话名不点击改名(⋯ 菜单→弹窗),长度随主栏 flex 收放 */}
        {menuClosed === true && (
          <button
            type="button"
            className="sx-winbtn sx-menu-toggle"
            aria-label="toggle menu"
            data-tip={t('Open menu', '打开菜单')}
            onClick={onToggleMenu}
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
        )}
        {/* 「打开」分体钮:常驻顶栏(工作区功能不随菜单开关隐现);主钮=默认应用开工作区,
            ∨=已装预设菜单(✓=当前默认,点选即换即开) */}
        {(fixedTitle === '' ? null : (
        /* 2026-10-27 用户裁定:辅助对话(fixedTitle==='')去掉工作区应用选择分体钮——旁路面不操作工作区 */
        <span className="sx-open-split" style={{ opacity: root === undefined || root === '' ? 0.4 : 1 }}>
          <button
            type="button"
            className="sx-winbtn sx-open-main"
            aria-label="open workspace"
            data-tip={t('Open workspace', '打开工作区')}
            disabled={root === undefined || root === ''}
            onClick={() => openIn(defaultEditor)}
          >
            {editorIcon(defaultEditor, 14)}
          </button>
          <button
            type="button"
            className="sx-winbtn sx-open-caret"
            aria-label="choose app"
            data-tip={t('Open with', '打开方式')}
            disabled={root === undefined || root === ''}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => toggleEditorMenu(e.currentTarget)}
          >
            <ChevronDown size={14} strokeWidth={2} />
          </button>
        </span>
        ))}
        {fixedTitle === '' ? (
          // G14.32 辅助对话:顶栏无标题(标签页已具名,双显冗余)
          <span className="chat-title" />
        ) : titleEditing ? (
          /* 2026-10-24 用户裁定:改名=弹窗(⋯ 菜单「重命名会话」触发),内联输入退役 */
          <div className="modal-overlay" onClick={() => setTitleEditing(false)}>
            <div className="modal-body rename-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="dirpicker-head">{t('Rename session', '重命名会话')}</div>
              <input
                className="chat-title-input"
                value={titleDraft}
                maxLength={40}
                autoFocus
                aria-label={t('Session title', '会话标题')}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTitle();
                  if (e.key === 'Escape') setTitleEditing(false);
                }}
              />
              <div className="dirpicker-foot">
                <button onClick={() => setTitleEditing(false)}>{t('Cancel', '取消')}</button>
                <button className="primary" onClick={commitTitle}>{t('Confirm', '确认')}</button>
              </div>
            </div>
          </div>
        ) : (
          <span className="chat-title" data-tip={displayTitle} /* 2026-10-25 用户裁定:hover 只显完整会话名,不缀 sessionId/tokens/steps */
            data-session-id={sessionId} /* 机器可读面(e2e openSessionId 解析锚点,视觉零影响) */>
            <span className="chat-title-btn">
              <span className={`chat-title-text${titleClipped ? ' clipped' : ''}`} ref={titleRef}>{displayTitle}</span>
            </span>
            {/* G14.52:运行态圆点迁侧栏会话行左缘(顶栏不再双显) */}
          </span>
        )}
        {/* ⋯ 会话操作钮(2026-10-22 用户裁定:归档直连钮收敛为 ⋯ 弹窗——置顶⇄/归档⇄,运行中禁用)。
            辅助对话不渲染(2026-10-23 用户裁定:fixedTitle==='' 即辅助会话,无会话级操作面)。
            2026-10-24 用户裁定:紧跟标题左聚(不再被计数钮的 auto 边距推到最右),计数钮居其右 */}
        {fixedTitle !== '' && (
          <button type="button" className="sx-iconbtn" data-tip={t('Session actions', '会话操作')}
            aria-label={t('Session actions', '会话操作')}
            onMouseDown={(e) => e.stopPropagation()} // 锚钮自身不触发 document 外点收(toggle 不被击穿)
            onClick={(e) => {
              e.stopPropagation();
              setAskArchive(null); // 重开菜单时收掉残留确认弹窗
              loadPinned();
              if (menu !== null) { setMenu(null); return; } // toggle:再点 ⋯ 收起
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: Math.round(r.right), y: Math.round(r.bottom) });
            }}
          >
            <MoreHorizontal size={16} strokeWidth={1.75} />
          </button>
        )}
        <ChatDynButtons todoActive={todoActive} taskActive={taskActive} bgRunning={bgRunning} running={running} onOpenTab={onOpenTab} />
        {/* 2026-10-27 用户裁定:电脑控制期间会话名行右亮「正在控制」边框徽标(控制类 computer-use
            工具在跑,use-chat-derived 派生,轮收束即隐) */}
        {computerUseActive === true && (
          <span className="sx-controlling-badge" role="status">
            {t('Sunshinex is controlling your computer', 'Sunshinex 正在控制你的电脑')}
          </span>
        )}
        {/* 2026-10-24 拖拽重构:顶栏窗拖拽单点落本空白带(顶栏左聚布局,钮全在带左,带吸右侧余量)——
            旧「容器 drag+按钮挖孔」在 CSS zoom 下拖拽位图挖孔坐标错位,抽屉态窗控簇([|]−□×)真实
            按下被吞(用户实测「抽屉态 [|] 点不动」根因);空白带与一切按钮几何互斥,无孔可挖 */}
        <div className="sx-topbar-drag" data-drag-band aria-hidden="true" />
        {menu !== null && fixedTitle !== '' && (
          <SessionRowMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems} />
        )}
        {editorMenu !== null && (
          <SessionRowMenu
            x={editorMenu.x}
            y={editorMenu.y}
            onClose={() => setEditorMenu(null)}
            items={editors.map((e) => ({
              id: e.id,
              label: e.name,
              tail: e.id === defaultEditor ? <Check size={14} strokeWidth={2.25} /> : undefined,
              active: e.id === defaultEditor,
              // 默认应用图标位挂 ✓(参考图口径:勾标在选中项上);点选只设默认不启动(误触根因,2d80c7e)
              icon: editorIcon(e.id, 14),
              onSelect: () => pickEditor(e.id),
            }))}
          />
        )}
        {askArchive !== null && fixedTitle !== '' && (
          // 归档二次确认弹窗(同款弹层件;外点/Esc 即取消)
          <SessionRowMenu
            x={askArchive.x}
            y={askArchive.y}
            onClose={() => setAskArchive(null)}
            items={[
              { id: 'confirm', label: t('Confirm archive', '确认归档'), onSelect: () => onArchive(true) },
              { id: 'cancel', label: t('Cancel', '取消'), onSelect: () => undefined },
            ]}
          />
        )}
        {/* [|] 侧栏开关退役(2026-10-23 用户裁定):全局唯一切换钮=右上窗控簇(桌面)/固定右上钮(web) */}
    </header>
  );
}
