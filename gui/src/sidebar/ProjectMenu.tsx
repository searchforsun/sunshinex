import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { errText, pickFolderNative, relTime } from '../ui-util';
import { t } from '../i18n';
import { ChevronRight, Folder, FolderOpen, Plus, Search, Settings, SquarePen } from 'lucide-react';

/**
 * 左栏项目分组菜单(G8a-T4,spec §1):Home 页职能内化——工作区=项目组,一项目一工作区。
 * 组列表(GET /workspaces):组头(chevron+Folder+slug+会话数)点击展开惰拉 GET /sessions?root=
 * (slug 守卫照搬 Home——openSlugRef 过期应答丢弃);root 缺场历史组禁用不可展开;组内「+」弹
 * mode 菜单(auto/manual)→ newSession(root, mode) 直进;会话行 Attach 两步(newSession 装配壳
 * → attach 播种)→ onOpenSession(sessionId, root)。Projects 分区头「+」开原生文件选择器(选完自动建项目, G10-C11);品牌行查找钮开项目/会话搜索面板 + 30s 定时自动刷新(G10-C13);
 * Home 的 modal-overlay 结构原样)。连接态显示退役(G10:一体本地,无连接语义可显)。
 * activeRoot 组自动展开(T5 App 壳传当前活动工作区;与手动展开共用同一 openSlug 态)。
 * 样式用 app.css T1 的 sx- 类 + Home 既有测试钩子类(workspace-、ws-、session- 前缀与
 * attach、no-root,零 e2e 迁移);唯一内联样式为组行锚定(mode 弹层定位面)与 chevron 旋转。
 */

/** 连接面:Home.tsx HomeConn 原样五方法(G8a-T4 平移源;本文件独立等价声明,不 import
 *  Home——T5 删 Home 页时本组件零牵连) */
export interface ProjectMenuConn {
  workspaces(): Promise<WorkspaceRow[]>;
  sessionsOf(root: string): Promise<SessionRow[]>;
  /** 跨工作区扁平最近会话(G10-C2 侧栏 Recents 区;daemon /sessions/recent 聚合) */
  recentSessions(): Promise<Array<SessionRow & { root: string; slug: string }>>;
  dirpicker(path?: string): Promise<{ path: string; parent: string; dirs: string[] }>;
  newSession(root: string, mode?: 'manual'): Promise<{ sessionId: string }>;
  /** 建项目(G10-C11):原生选择器确认后注册/创建工作区 */
  createWorkspace(body: { name?: string; path?: string }): Promise<{ ok: true; root: string; slug: string }>;
  attach(sessionId: string, journalId: string): Promise<void>;
}

export interface ProjectMenuProps {
  readonly conn: ProjectMenuConn;
  readonly connState: string; // 'connecting'|'online'|'offline'|'reconnecting'(显示态)
  readonly activeSessionId: string; // '' = 无会话
  readonly activeRoot: string; // '' = 无(其所属组自动展开)
  readonly onOpenSession: (sessionId: string, root: string) => void;
  /** G8c-T8 设置钮回调:App 开设置态(可选——未配时钮不渲染,免独立测试装配面死 UI) */
  readonly onOpenSettings?: () => void;
  /** 「New chat」:回欢迎页开新对话(G10-C16) */
  readonly onNewChat: () => void;
  /** 项目行「+」:回欢迎页并预选该项目与审批模式(G10-C16) */
  readonly onComposeIn: (root: string, mode?: 'auto' | 'manual') => void;
}


/** 遗留档(无 root)显示名:去尾部 hash、dash→空格——slug 是给机器的,人读的是路径词 */
function legacyName(slug: string): string {
  return slug.replace(/-[0-9a-f]{8}$/i, '').replace(/-/g, ' ');
}

/** 工作区显示名:真实项目目录名(basename),路径 slug 仅兜底/悬浮(2026-10-08 可读性裁定:
 *  路径 slug「D-project-bi-mammoth-internal-410e80d4」换行破碎不可读——目录名才是用户心智的项目名) */
function wsName(row: { root?: string; slug: string }): string {
  if (row.root !== undefined && row.root !== '') {
    const base = row.root.split(/[\\/]/).filter(Boolean).pop();
    if (base !== undefined && base !== '') return base;
  }
  return legacyName(row.slug);
}

/** 相对时间:G8e-T2 抽共享 ui-util(与 SettingsForm 同款逻辑本地复制收敛) */

export function ProjectMenu(props: ProjectMenuProps): JSX.Element {
  const { conn, activeSessionId, activeRoot, onOpenSession, onOpenSettings, onNewChat, onComposeIn } = props;
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null);
  /** Recents 扁平最近会话(G10-C2;跨工作区,daemon 聚合) */
  const [recents, setRecents] = useState<Array<SessionRow & { root: string; slug: string }> | null>(null);
  const [listError, setListError] = useState('');
  /** 展开中的组 slug(手动 toggle 与 activeRoot 自动展开共用同一态);null = 全收 */
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  /** openSlug 的同步镜像:sessionsOf 异步应答到达时读(闭包免陈旧——slug 守卫判据) */
  const openSlugRef = useRef<string | null>(null);
  openSlugRef.current = openSlug;
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionsError, setSessionsError] = useState('');
  /** attach/组内新建/添加工作区在途(按钮禁用防双发) */
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  /** 组内「+」的 mode 弹层挂哪组(slug;null = 收) */
  /** 分区折叠(G10-C18):PROJECTS/RECENTS 分区头可折叠(平滑过渡) */
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [recentsOpen, setRecentsOpen] = useState(true);
  /** 查找面板(G10-C13):项目 + 会话历史搜索 */
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** 已读会话集(本次运行内):点开过的会话不再显示蓝色未读光点;运行中恒显示转圈 */
  const [seenIds, setSeenIds] = useState<ReadonlySet<string>>(() => new Set());
  const markSeen = (id: string): void =>
    setSeenIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  /** 会话 id → journal 行 id 映射(attach 时记下):行 active 只亮当前打开会话对应的 journal 行,
   *  不再用 root 兜底(兜底会把同组所有行全点亮,看起来像误 hover) */
  const [journalOfSession, setJournalOfSession] = useState<ReadonlyMap<string, string>>(() => new Map());
  const markJournal = (sessionId: string, journalId: string): void =>
    setJournalOfSession((prev) => {
      if (prev.get(sessionId) === journalId) return prev;
      const next = new Map(prev);
      next.set(sessionId, journalId);
      return next;
    });

  const loadWorkspaces = useCallback((): void => {
    conn.workspaces().then(
      (list) => {
        setRows(list);
        setListError('');
      },
      (err: unknown) => setListError(err instanceof Error ? err.message : String(err)),
    );
    conn.recentSessions().then(setRecents, () => setRecents([])); // Recents 静默降级:空列表即可用
  }, [conn]);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);


  // 查找面板外点收(钮自身走 click 切换,不在收面)
  useEffect(() => {
    if (!searchOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target;
      if (t instanceof Element && t.closest('.sx-side-search') === null && t.closest('[aria-label="search"]') === null) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [searchOpen]);

  // 30s 定时自动刷新(G10-C13:替代手动刷新钮;loadWorkspaces 同刷 Recents)
  useEffect(() => {
    const timer = setInterval(() => loadWorkspaces(), 30_000);
    return () => clearInterval(timer);
  }, [loadWorkspaces]);

  /** 拉展开组的会话列表(slug 守卫,Home 照搬):应答到达时 slug 已非当前展开(切组/收起)
   *  则丢弃——迟到应答不冲新展开组(慢应答竞态收口) */
  const loadSessions = useCallback(
    (root: string, slug: string): void => {
      conn.sessionsOf(root).then(
        (list) => {
          if (openSlugRef.current !== slug) return; // 过期应答:展开已切走/收起,丢
          setSessions(list);
        },
        (err: unknown) => {
          if (openSlugRef.current !== slug) return;
          setSessionsError(err instanceof Error ? err.message : String(err));
        },
      );
    },
    [conn],
  );

  /** 展开组(手动 toggle / activeRoot 自动共用入口):展开即惰拉 sessionsOf(root)。
   *  ref 先行同步写:自动展开走 effect 路径,setOpenSlug 的重渲染可能晚于 sessionsOf
   *  已 resolve 的微任务续体——守卫届时须已见新 slug,否则唯一应答被当过期丢弃 */
  const expandGroup = useCallback(
    (row: WorkspaceRow): void => {
      if (row.root === undefined) return;
      openSlugRef.current = row.slug;
      setOpenSlug(row.slug);
      setSessions(null);
      setSessionsError('');
      loadSessions(row.root, row.slug);
    },
    [loadSessions],
  );

  /** 展开/收起组:root 缺场历史组按钮禁用不可达 */
  const toggleGroup = (row: WorkspaceRow): void => {
    if (row.root === undefined) return;
    if (openSlug === row.slug) {
      openSlugRef.current = null;
      setOpenSlug(null);
      return;
    }
    expandGroup(row);
  };

  /** activeRoot 组自动展开:mount/activeRoot 变化(含刷新后 rows 新到场)时,其组未展开则
   *  展开并拉会话;手动收起后 deps 不变不重扰,刷新替换 rows 数组后会重新评估 */
  useEffect(() => {
    if (activeRoot === '' || rows === null) return;
    const row = rows.find((r) => r.root === activeRoot);
    if (row === undefined || openSlugRef.current === row.slug) return;
    expandGroup(row);
  }, [activeRoot, rows, expandGroup]);


  /** Attach 两步(daemon 形态对齐,Home 照搬):newSession(root) 装配壳 → attach(sessionId,
   *  journalId) 播种恢复 → onOpenSession(sessionId, root);失败行内报错,busy 防双发 */
  const attachJournal = (root: string, journalId: string): void => {
    if (busy) return;
    setBusy(true);
    setActionError('');
    conn
      .newSession(root)
      .then(({ sessionId }) => conn.attach(sessionId, journalId).then(() => sessionId))
      .then(
        (sessionId) => {
          setBusy(false);
          markSeen(journalId);
          markJournal(sessionId, journalId);
          onOpenSession(sessionId, root);
          loadWorkspaces(); // 点会话即刷新(G10-C13:计数/最近区即时更新)
        },
        (err: unknown) => {
          setBusy(false);
          setActionError(err instanceof Error ? err.message : String(err));
        },
      );
  };





  /** 「+ 添加工作区」(G10-C11):原生文件选择器(Win 系统对话框)选完即自动建项目——
   *  浏览器态按名字在 projectsRoot 下建;桌面壳态注册既有目录。建好即展开组并开一个
   *  auto 会话(对齐旧 DirPicker 确认后进会话的交互);失败行内报错 */
  const pickAndAdd = async (): Promise<void> => {
    setActionError('');
    const picked = await pickFolderNative();
    if (picked === null) return;
    if (picked === 'unsupported') {
      setActionError(
        t('Native folder picker needs a Chromium browser or the desktop app', '原生文件夹选择需要 Chrome/Edge 浏览器或桌面版'),
      );
      return;
    }
    try {
      const res = await conn.createWorkspace(picked.path !== undefined ? { path: picked.path } : { name: picked.name });
      loadWorkspaces(); // 建项目落位即刷新组列表
      // 建好即回欢迎页预选该项目(auto 档)——纯回调无 busy,目标提交即刻可用
      onComposeIn(res.root, 'auto');
    } catch (err) {
      setActionError(errText(err));
    }
  };

  return (
    <nav className="sx-menu" aria-label="projects">
      <header className="sx-menu-head">
        <span className="sx-brand">Sunshinex</span>
        <button type="button" aria-label="search" className="sx-iconbtn" title={t('Search projects & sessions', '搜索项目与会话')} onClick={() => setSearchOpen((v) => !v)}>
          <Search size={16} strokeWidth={1.75} />
        </button>
      </header>
      {searchOpen && (
        <div className="sx-side-search" role="search" aria-label={t('Search projects & sessions', '搜索项目与会话')}>
          <input
            autoFocus
            value={query}
            placeholder={t('Search projects & sessions', '搜索项目与会话…')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearchOpen(false);
            }}
          />
          <div className="sx-side-search-list">
            <div className="sx-search-sec">{t('Projects', '项目')}</div>
            {(rows ?? [])
              .filter((r) => query.trim() === '' || wsName(r).toLowerCase().includes(query.trim().toLowerCase()))
              .map((r) => (
                <button
                  key={r.slug}
                  type="button"
                  className="sx-search-row"
                  onClick={() => {
                    const row = (rows ?? []).find((x) => x.slug === r.slug);
                    if (row !== undefined && row.root !== undefined) expandGroup(row);
                    setSearchOpen(false);
                  }}
                >
                  <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span className="sx-search-label">{wsName(r)}</span>
                  <span className="sx-search-meta">{r.sessionCount}</span>
                </button>
              ))}
            <div className="sx-search-sec">{t('Recent sessions', '会话历史')}</div>
            {(recents ?? [])
              .filter((r) => query.trim() === '' || (r.firstUser ?? '').toLowerCase().includes(query.trim().toLowerCase()))
              .slice(0, 12)
              .map((r) => {
                const running = r.id === activeSessionId;
                return (
                  <button
                    key={r.root + '/' + r.id}
                    type="button"
                    className="sx-search-row"
                    title={r.firstUser ?? undefined}
                    onClick={() => {
                      if (busy) return;
                      attachJournal(r.root, r.id);
                      setSearchOpen(false);
                    }}
                  >
                    {running ? (
                      <span className="sx-session-dot running" />
                    ) : !seenIds.has(r.id) ? (
                      <span className="sx-session-dot unseen" />
                    ) : null}
                    <span className="sx-search-label">{r.firstUser ?? '(无摘要)'}</span>
                    <span className="sx-search-meta">{relTime(r.updatedAt)}</span>
                  </button>
                );
              })}
          </div>
        </div>
      )}
      <button
        type="button"
        className="sx-new-chat"
        aria-label="new chat"
        title={t('New chat', '新对话')}
        onClick={onNewChat}
      >
        <SquarePen size={16} strokeWidth={1.75} />
        <span>{t('New chat', '新对话')}</span>
      </button>
      <div className="sx-side-scroll">
        <div
          className="sx-side-head sx-side-head-row sx-side-head-btn"
          role="button"
          aria-expanded={projectsOpen}
          tabIndex={0}
          onClick={() => setProjectsOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setProjectsOpen((v) => !v);
            }
          }}
        >
          <span>{t('Projects', '项目')}</span>
          <ChevronRight
            size={12}
            strokeWidth={2}
            aria-hidden="true"
            className={`sx-side-chev${projectsOpen ? ' open' : ''}`}
          />
          <button
            type="button"
            className="sx-iconbtn"
            aria-label="add workspace"
            title={t('Add workspace', '添加工作区')}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              setActionError('');
              void pickAndAdd();
            }}
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
        </div>
        <div className={`sx-collapse${projectsOpen ? ' open' : ''}`}>
        <ul className="workspace-list sx-groups" aria-label="workspace groups">
        {rows === null && listError === '' && <li className="home-loading">{t('Loading workspaces…', '加载工作区…')}</li>}
        {listError !== '' && (
          <li className="home-error" role="alert">
            {listError.startsWith('-> 401')
              ? t('Token expired — reopen the URL printed by `serve` (or append ?token=<new> to the address)', 'token 已失效——请重新打开 serve 启动时打印的链接(或在地址后追加 ?token=<新 token>)')
              : listError}
          </li>
        )}
        {rows !== null && rows.length === 0 && (
          <li className="home-empty">{t('No workspaces yet — add one via + above.', '尚无工作区——用上方「+」添加项目目录。')}</li>
        )}
        {actionError !== '' && (
          <li className="home-error" role="alert">
            {actionError}
          </li>
        )}
        {rows?.map((row) => {
          const root = row.root; // const 捕获:root 收窄可入回调
          return (
            <li
              key={row.slug}
              className={`workspace-item${root === undefined ? ' no-root' : ''}`}
              style={{ position: 'relative' }} // mode 弹层(sx-menu-pop absolute)锚定本组行
            >
              <div className="workspace-row" style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  type="button"
                  className={`workspace-toggle sx-group-head${root !== undefined && root === activeRoot ? ' active' : ''}`}
                  disabled={root === undefined}
                  aria-expanded={openSlug === row.slug}
                  title={root ?? 'root 未登记(历史工作区)——无法恢复会话'}
                  onClick={() => toggleGroup(row)}
                >
                  <span className="sx-ws-folder" aria-hidden="true">
                    {openSlug === row.slug ? (
                      <FolderOpen size={16} strokeWidth={1.75} />
                    ) : (
                      <Folder size={16} strokeWidth={1.75} />
                    )}
                  </span>
                  <span className="ws-slug sx-ws-name">{wsName(row)}</span>
                  <span className="ws-count sx-count" title={`${row.sessionCount} sessions`}>
                    {row.sessionCount}
                  </span>
                </button>
                {root !== undefined && (
                  <button
                    type="button"
                    aria-label={`new session in ${row.slug}`}
                    className="sx-iconbtn"
                    title={t('New chat in this project', '在此项目中新对话')}
                    onClick={() => onComposeIn(root)}
                  >
                    <SquarePen size={16} strokeWidth={1.75} />
                  </button>
                )}
              </div>
              {root !== undefined && (
              <div className={`sx-collapse${openSlug === row.slug ? ' open' : ''}`}>
                <ul className="session-list" aria-label="sessions">
                  {sessions === null && sessionsError === '' && <li className="sessions-loading">{t('Loading sessions…', '加载会话…')}</li>}
                  {sessionsError !== '' && <li className="home-error">{sessionsError}</li>}
                  {sessions !== null && sessions.length === 0 && (
                    <li className="no-sessions">{t('No sessions yet — create one via + above.', '暂无会话——组内「+」新建。')}</li>
                  )}
                  {sessions?.map((s) => {
                    // active 判定:daemon 会话 id 直配,或该会话经 attach 记下的 journal 行 id
                    // (异名映射,G10-C7 补)——root 兜底退役:整组全亮读作误 hover
                    const active =
                      activeSessionId !== '' &&
                      (s.id === activeSessionId || journalOfSession.get(activeSessionId) === s.id);
                    // G8e 三面②会话行状态点:id 直配行=accent 实心(运行中会话;与 active 类同判据
                    // 锚 activeSessionId——不含 root 兜底,兜底行=灰空心「非本行会话」)
                    const running = s.id === activeSessionId;
                    return (
                      <li
                        key={s.id}
                        className={`session-row sx-session-row${active ? ' active' : ''}`}
                        title="打开会话"
                        onClick={() => {
                          if (busy || root === undefined) return;
                          attachJournal(root, s.id);
                        }}
                      >
                        {running ? (
                          <span className="sx-session-dot running" title="运行中会话" />
                        ) : !seenIds.has(s.id) ? (
                          <span className="sx-session-dot unseen" />
                        ) : null}
                        <span className="session-summary" title={`${s.firstUser ?? ''} · ${s.id}`}>
                          {s.firstUser ?? '(无摘要)'}
                        </span>
                        <span className="session-meta">{relTime(s.updatedAt)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              )}
            </li>
          );
        })}
      </ul>
      </div>
      <div
        className="sx-side-head sx-side-head-btn"
        role="button"
        aria-expanded={recentsOpen}
        tabIndex={0}
        onClick={() => setRecentsOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setRecentsOpen((v) => !v);
          }
        }}
      >
        <span>{t('Recents', '最近会话')}</span>
        <button
          type="button"
          className="sx-iconbtn"
          aria-label="new chat"
          title={t('New chat', '新对话')}
          onClick={(e) => {
            e.stopPropagation();
            onNewChat();
          }}
        >
          <SquarePen size={14} strokeWidth={1.75} />
        </button>
        <ChevronRight
          size={12}
          strokeWidth={2}
          aria-hidden="true"
          className={`sx-side-chev${recentsOpen ? ' open' : ''}`}
        />
      </div>
      <div className={`sx-collapse${recentsOpen ? ' open' : ''}`}>
      <ul className="recent-list" aria-label="recent sessions">
        {recents === null && <li className="sessions-loading">{t('Loading sessions…', '加载会话…')}</li>}
        {recents !== null && recents.length === 0 && <li className="no-sessions">{t('No recent sessions', '暂无最近会话')}</li>}
        {recents?.map((r) => {
          const running = r.id === activeSessionId;
          // active 同组行:daemon 会话 id 直配或 journal 异名映射;root 兜底退役
          const active =
            activeSessionId !== '' &&
            (r.id === activeSessionId || journalOfSession.get(activeSessionId) === r.id);
          return (
            <li
              key={`${r.root}/${r.id}`}
              className={`session-row sx-session-row${active ? ' active' : ''}`}
              title="打开会话"
              onClick={() => {
                if (busy) return;
                attachJournal(r.root, r.id);
              }}
            >
              {running ? (
                <span className="sx-session-dot running" />
              ) : !seenIds.has(r.id) ? (
                <span className="sx-session-dot unseen" />
              ) : null}
              <span className="session-summary" title={`${r.firstUser ?? ''} · ${r.id}`}>{r.firstUser ?? '(无摘要)'}</span>
              <span className="session-meta">{relTime(r.updatedAt)}</span>
            </li>
          );
        })}
      </ul>
      </div>
      </div>
      <footer className="sx-menu-foot">
        {onOpenSettings !== undefined && (
          <button
            type="button"
            aria-label="open settings"
            className="sx-iconbtn"
            title="设置"
            onClick={onOpenSettings}
          >
            <Settings size={16} strokeWidth={1.75} />
          </button>
        )}
      </footer>
    </nav>
  );
}
