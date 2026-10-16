import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { errText, pickWorkspaceFolder, relTime, shortLocalTime } from '../ui-util';
import { t } from '../i18n';
import { ChevronRight, Folder, FolderOpen, Search, Settings, SquarePen } from 'lucide-react';

/** G14.75 模糊匹配:大小写不敏感子序列(字符依次命中即过);空查询恒真 */
function fuzzyHit(text: string, query: string): boolean {
  if (query.trim() === '') return true;
  let i = 0;
  const t = text.toLowerCase();
  for (const ch of query.trim().toLowerCase()) {
    i = t.indexOf(ch, i);
    if (i < 0) return false;
    i += 1;
  }
  return true;
}

/** G14.68 添加工作区图标:文件夹 + 右上角加号(lucide FolderPlus 加号居中,不符用户裁定) */
export function FolderAddIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 文件夹整体下移,右上角留白给加号(G14.68:加号在右上角,非居中) */}
      <g transform="translate(0 2)">
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </g>
      <path d="M18 .8v5" />
      <path d="M15.5 3.3h5" />
    </svg>
  );
}
import { DirPicker } from '../pages/DirPicker';

/** G14.195 已读会话持久化(localStorage `sunshinex.seen-sessions`):id → 最近已读 updatedAt。
 *  刷新不再全员亮蓝点(原内存 Set「本次运行内」即清空);行 updatedAt 新于已读时刻即重新视为
 *  未读(真·未读)。容量封顶 200(超出丢最旧),存储满/禁用静默。 */
const SEEN_KEY = 'sunshinex.seen-sessions';
type SeenMap = Record<string, number>;
function loadSeenMap(): SeenMap {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw === null) return {};
    const obj = JSON.parse(raw) as SeenMap;
    return obj !== null && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}
function persistSeenMap(m: SeenMap): void {
  try {
    const entries = Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200);
    localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 存储满/禁用:静默 */
  }
}

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
  /** G14.69 原生选择定位:按标记文件找所选目录绝对路径 */
  locateWorkspace(body: { token: string; roots?: string[] }): Promise<{ path: string | null }>;
  attach(sessionId: string, journalId: string): Promise<void>;
}

export interface ProjectMenuProps {
  readonly conn: ProjectMenuConn;
  readonly connState: string; // 'connecting'|'online'|'offline'|'reconnecting'(显示态)
  readonly activeSessionId: string; // '' = 无会话
  readonly activeRoot: string; // '' = 无(其所属组自动展开)
  /** G14.16 标题统一流联动:rename 落盘后 App bump——变化即重拉 recentSessions(侧栏即时同名) */
  readonly recentVersion?: number;
  /** G14.52 活动会话运行态(App 本地权威,model-start 置位/done·error 复位):圆点亮熄以此为准 */
  readonly runActive?: boolean;
  readonly onOpenSession: (sessionId: string, root: string, journalId?: string) => void;
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

/** G14.115 RECENTS 分页显形:默认 10 条(约近 3 天窗),「显示更多」步进 10,上限=全量;收起复位 */
const RECENT_VISIBLE_DEFAULT = 10;
const RECENT_VISIBLE_STEP = 10;

/** 会话统计行(G14.17 回溯面):旁车 meta 有几段拼几段——轮/步/tokens/缓存/上文占比/模型·档位/
 *  建档时刻;RECENTS 与搜索行 tooltip 消费,空 meta 返回 ''(行 tooltip 退化为标题+id) */
function sessionMetaLine(r: SessionRow & { root: string; slug: string }): string {
  // G14.106 会话行 tooltip 收敛两行:会话名称(调用方拼)+「N 轮 M 步 · 创建于 时间」——
  // tokens/缓存/上文/模型/孤立 id 等全家桶退役
  const parts: string[] = [];
  if (r.runs !== undefined) parts.push(t(`${r.runs} run${r.runs === 1 ? '' : 's'}`, `${r.runs} 轮`));
  if (r.steps !== undefined) parts.push(t(`${r.steps} step${r.steps === 1 ? '' : 's'}`, `${r.steps} 步`));
  if (r.createdAt !== undefined) parts.push(t(`created ${shortLocalTime(r.createdAt)}`, `创建于 ${shortLocalTime(r.createdAt)}`));
  return parts.join(' · ');
}

/** 工作区显示名:真实项目目录名(basename),路径 slug 仅兜底/悬浮(2026-10-08 可读性裁定:
 *  路径 slug「D-project-bi-mammoth-internal-410e80d4」换行破碎不可读——目录名才是用户心智的项目名) */
/** default 锚点唯一化(G14.10):临时锚 <tmp>/sunshinex-default 在场时,旧仓库内 default
 *  工作区行隐藏(目录与历史会话保留,RECENTS/搜索仍可达)——两个「default」行只示其一 */
function visibleWorkspaces(rows: WorkspaceRow[]): WorkspaceRow[] {
  const baseOf = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? '';
  // G14.34:默认锚点工作区(sunshinex-default,非项目会话的落点)不再入 PROJECTS 列表——
  // 其会话仍经 RECENTS 可达(attach 只需 root/slug,与工作区行在场与否无关)
  return rows.filter((r) => {
    if (r.root === undefined) return true;
    const base = baseOf(r.root);
    if (base === 'sunshinex-default') return false; // G14.34:默认锚点不入 PROJECTS(会话走 RECENTS)
    return true;
  });
}

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
  const recentVersion = props.recentVersion ?? 0;
  const runActive = props.runActive ?? false;
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null);
  /** Recents 扁平最近会话(G10-C2;跨工作区,daemon 聚合) */
  const [recents, setRecents] = useState<Array<SessionRow & { root: string; slug: string }> | null>(null);
  const [recentsOpen, setRecentsOpen] = useState(true);
  /** G14.115 最近会话逐步显形:默认 10 条,「显示更多」每次多放 10 条,「收起」/分区折叠复位 */
  const [recentLimit, setRecentLimit] = useState(RECENT_VISIBLE_DEFAULT);
  /** G14.42 默认锚点工作区 root(RECENTS 头 ✎ 新建默认会话用;无注册行不示钮) */
  const defaultAnchorRoot = (rows ?? []).find(
    (r) => r.root !== undefined && r.root.split(/[\\/]+/).filter(Boolean).pop() === 'sunshinex-default',
  )?.root;
  const [listError, setListError] = useState('');
  /** G14.51 浏览器态服务端目录选择弹层(添加工作区无桌面壳时) */
  const [dirOpen, setDirOpen] = useState(false);
  /** 展开中的组 slug(G14.32 恢复组展开;null = 全收)+ sessionsOf 应答缓存/错误 */
  const [openSlug, setOpenSlug] = useState<string | null>(null);
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
  /** 查找面板(G10-C13):项目 + 会话历史搜索 */
  const [searchOpen, setSearchOpen] = useState(false);
  /** G14.75 聚合搜索:全部工作区的会话扁平集(打开搜索时聚合一次,rows 变化重拉) */
  const [allSessions, setAllSessions] = useState<Array<SessionRow & { root: string; slug: string }> | null>(null);
  const [query, setQuery] = useState('');
  /** 已读会话映射(localStorage 持久化):id → 最近已读 updatedAt;刷新不清空 */
  const [seenMap, setSeenMap] = useState<SeenMap>(() => loadSeenMap());
  /** 未读判定:行 updatedAt 新于已读时刻即未读 */
  const isUnseen = (id: string, updatedAt: number): boolean => (seenMap[id] ?? -1) < updatedAt;
  const markSeen = (id: string, updatedAt: number): void =>
    setSeenMap((prev) => {
      if ((prev[id] ?? -1) >= updatedAt) return prev;
      const next = { ...prev, [id]: updatedAt };
      persistSeenMap(next);
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
  }, [loadWorkspaces, recentVersion]); // G14.52:run 起跑经 App recentVersion bump 驱动刷新(liveSessionId 圆点跟手)

  /** 拉展开组的会话列表(slug 守卫):应答到达时已切组/收起则丢弃(慢应答竞态收口) */
  const loadSessions = useCallback(
    (root: string, slug: string): void => {
      conn.sessionsOf(root).then(
        (list) => {
          if (openSlugRef.current !== slug) return;
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

  /** 展开组:展开即惰拉 sessionsOf(root);ref 先行同步写(守卫须已见新 slug) */
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

  const toggleGroup = (row: WorkspaceRow): void => {
    if (row.root === undefined) return;
    if (openSlug === row.slug) {
      openSlugRef.current = null;
      setOpenSlug(null);
      return;
    }
    expandGroup(row);
  };

  /** activeRoot 组自动展开(当前会话所属组;与手动 toggle 共用 openSlug 态) */
  useEffect(() => {
    const row = (rows ?? []).find((r) => r.root === activeRoot);
    if (row === undefined || openSlugRef.current === row.slug) return;
    expandGroup(row);
  }, [activeRoot, rows, expandGroup]);

  /** G14.52:run 起跑/收束(App recentVersion bump)时,展开中的组重拉会话行——liveSessionId
   *  运行圆点跟手。组列表只在展开时惰拉,不重拉则行恒为展开时刻快照(圆点不亮/不熄) */
  useEffect(() => {
    if (recentVersion === 0 || openSlugRef.current === null) return;
    const row = (rows ?? []).find((r) => r.slug === openSlugRef.current);
    if (row?.root !== undefined) loadSessions(row.root, row.slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recentVersion 即刷新信号;rows/openSlugRef 取现值
  }, [recentVersion]);


  // G14.75 聚合搜索:打开时拉全部工作区会话(sessionsOf 每工作区一次,失败静默为空)
  useEffect(() => {
    if (!searchOpen) return;
    const targets = visibleWorkspaces(rows ?? []).filter((r) => r.root !== undefined);
    void Promise.all(
      targets.map((r) =>
        conn
          .sessionsOf(r.root as string)
          .then((list) => list.map((x) => ({ ...x, root: r.root as string, slug: r.slug })))
          .catch(() => []), // 刷新失败按空清单降级(侧栏计数面,非权威数据;下次展开重拉)
      ),
    ).then((groups) => setAllSessions(groups.flat()));
  }, [searchOpen, rows, conn]);

  // 30s 定时自动刷新(G10-C13)+ 窗口聚焦刷新(G14.9:回窗即见最新会话列表)
  useEffect(() => {
    const timer = setInterval(() => loadWorkspaces(), 30_000);
    const onFocus = (): void => loadWorkspaces();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadWorkspaces]);



  /** Attach 两步(daemon 形态对齐,Home 照搬):newSession(root) 装配壳 → attach(sessionId,
   *  journalId) 播种恢复 → onOpenSession(sessionId, root);失败行内报错,busy 防双发 */
  const attachJournal = (root: string, journalId: string, journalUpdatedAt?: number): void => {
    if (busy) return;
    setBusy(true);
    setActionError('');
    conn
      .newSession(root)
      .then(({ sessionId }) => conn.attach(sessionId, journalId).then(() => sessionId))
      .then(
        (sessionId) => {
          setBusy(false);
          markSeen(journalId, journalUpdatedAt ?? Date.now());
          markJournal(sessionId, journalId);
          onOpenSession(sessionId, root, journalId); // G14.213 journalId 随行下发(滚动位存档稳定键)
          loadWorkspaces(); // 点会话即刷新(G10-C13:计数/最近区即时更新)
        },
        (err: unknown) => {
          setBusy(false);
          setActionError(err instanceof Error ? err.message : String(err));
        },
      );
  };





  /** 「+ 添加工作区」(G10-C11 + G14.51 收口):桌面壳走 IPC 系统对话框(回全路径);浏览器态
   *  开服务端 DirPicker 逐级浏览——两路都回「既有目录」绝对路径,daemon {path} 分支只登记不建
   *  目录(旧按 name 在 projectsRoot 下 mkdir 的行为废除)。登记后回欢迎页预选该项目。 */
  const pickAndAdd = (): void => {
    setActionError('');
    const shell = window.sunshinex;
    if (typeof shell?.pickFolder === 'function') {
      void shell.pickFolder().then((p) => {
        if (p === null) return;
        conn
          .createWorkspace({ path: p })
          .then((res) => {
            loadWorkspaces(); // 建项目落位即刷新组列表
            onComposeIn(res.root); // 纯回调无 busy,目标提交即刻可用
          })
          .catch((err: unknown) => setActionError(errText(err)));
      });
      return;
    }
    // G14.69 浏览器态:原生系统文件夹选择(showDirectoryPicker)→ 标记文件定位绝对路径→登记;
    // 取消静默;不支持/权限被拒/定位超时 → 回退自建目录浏览
    void pickWorkspaceFolder((q) => conn.locateWorkspace(q)).then((r) => {
      if (r === null) return;
      if (r !== 'unsupported' && r !== 'denied' && r !== 'timeout') {
        conn
          .createWorkspace({ path: r.path })
          .then((res) => {
            loadWorkspaces();
            onComposeIn(res.root);
          })
          .catch((err: unknown) => setActionError(errText(err)));
        return;
      }
      setDirOpen(true);
    });
  };
  /** DirPicker 确认:登记所选既有目录为工作区(同桌面壳后段;已登记幂等) */
  const registerFolder = (p: string): void => {
    setDirOpen(false);
    conn
      .createWorkspace({ path: p })
      .then((res) => {
        loadWorkspaces();
        onComposeIn(res.root);
      })
      .catch((err: unknown) => setActionError(errText(err)));
  };

  return (
    <nav className="sx-menu" aria-label="projects">
      <header className="sx-menu-head">
        <span className="sx-brand">Sunshinex</span>
        <button type="button" aria-label="search" className="sx-iconbtn" data-tip={t('Search projects & sessions', '搜索项目与会话')} onClick={() => setSearchOpen((v) => !v)}>
          <Search size={16} strokeWidth={1.75} />
        </button>
      </header>
      <button
        type="button"
        className="sx-new-chat"
        aria-label="new chat"
        onClick={onNewChat}
      >
        <SquarePen size={16} strokeWidth={1.75} />
        <span>{t('New chat', '新对话')}</span>
      </button>
      {searchOpen && (
        <div className="modal-overlay" onClick={() => setSearchOpen(false)}>
          <div
            className="sx-search-modal"
            role="search"
            aria-label={t('Search projects & sessions', '搜索项目与会话')}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={query}
              placeholder={t('Search projects & sessions', '搜索项目与会话…')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearchOpen(false);
              }}
            />
            <div className="sx-search-modal-list">
              <div className="sx-search-sec">{t('Projects', '项目')}</div>
              {(rows ?? [])
                .filter((r) => fuzzyHit(wsName(r) + ' ' + r.slug, query))
                .map((r) => (
                  <button
                    key={r.slug}
                    type="button"
                    className="sx-search-row"
                    onClick={() => {
                      const row = (rows ?? []).find((x) => x.slug === r.slug);
                      if (row !== undefined && row.root !== undefined) onComposeIn(row.root);
                      setSearchOpen(false);
                    }}
                  >
                    <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span className="sx-search-label">{wsName(r)}</span>
                    <span className="sx-search-meta">{r.sessionCount}</span>
                  </button>
                ))}
              {(rows ?? []).length === 0 && <div className="sx-search-empty">{t('No matching projects', '无匹配项目')}</div>}
              <div className="sx-search-sec">{t('Sessions', '会话')}</div>
              {(allSessions ?? [])
                .filter((r) => fuzzyHit((r.title ?? r.firstUser ?? '') + ' ' + r.id, query))
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, 20)
                .map((r) => {
                  // G14.52 running 身份:活动会话以 runActive 为准(收束即时熄);他会话看 daemon 标注
                  const isMapped = r.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === r.id;
                  const running = isMapped ? activeSessionId !== '' && runActive : r.liveSessionId !== undefined;
                  const label = r.title ?? r.firstUser ?? t('New session', '新会话');
                  const metaLine = sessionMetaLine(r);
                  return (
                    <button
                      key={r.root + '/' + r.id}
                      type="button"
                      className="sx-search-row"
                      data-tip={`${label}${metaLine !== '' ? `
${metaLine}` : ''}`}
                      onClick={() => {
                        if (busy) return;
                        attachJournal(r.root, r.id, r.updatedAt);
                        setSearchOpen(false);
                      }}
                    >
                      {running ? (
                        <span className="sx-session-dot running" />
                      ) : isUnseen(r.id, r.updatedAt) ? (
                        <span className="sx-session-dot unseen" />
                      ) : null}
                      <span className="sx-search-label">{label}</span>
                      <span className="sx-search-meta">{relTime(r.updatedAt)}</span>
                    </button>
                  );
                })}
              {(allSessions ?? []).length === 0 && <div className="sx-search-empty">{t('No matching sessions', '无匹配会话')}</div>}
            </div>
          </div>
        </div>
      )}
            {/* G14.9:单一滚动区装 PROJECTS + RECENTS;footer 贴底 */}
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
            data-tip={t('Open a folder as workspace', '打开文件夹作为工作区')}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              setActionError('');
              pickAndAdd();
            }}
          >
            <FolderAddIcon size={14} />
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
              <li className="home-empty">{t('No projects yet', '暂无项目')}</li>
            )}
            {actionError !== '' && (
              <li className="home-error" role="alert">
                {actionError}
              </li>
            )}
            {visibleWorkspaces(rows ?? []).map((row) => {
              const root = row.root; // const 捕获:root 收窄可入回调
              return (
                <li
                  key={row.slug}
                  className={`workspace-item${root === undefined ? ' no-root' : ''}`}
                  style={{ position: 'relative' }}
                >
                  <div className="workspace-row" style={{ display: 'flex', alignItems: 'center' }}>
                    <button
                      type="button"
                      className={`workspace-toggle sx-group-head${root !== undefined && root === activeRoot ? ' active' : ''}`}
                      disabled={root === undefined}
                      aria-expanded={openSlug === row.slug}
                      data-tip={root ?? 'root 未登记(历史工作区)——无法新建会话'}
                      onClick={() => toggleGroup(row)}
                    >
                      <span className="sx-ws-folder" aria-hidden="true">
                        {openSlug === row.slug ? <FolderOpen size={16} strokeWidth={1.75} /> : <Folder size={16} strokeWidth={1.75} />}
                      </span>
                      <span className="ws-slug sx-ws-name">{wsName(row)}</span>
                      <span className="ws-count sx-count">
                        {row.sessionCount}
                      </span>
                    </button>
                    {root !== undefined && (
                      <button
                        type="button"
                        aria-label={`new session in ${row.slug}`}
                        className="sx-iconbtn"
                        data-tip={t('New chat in this project', '在此项目中新对话')}
                        onClick={() => onComposeIn(root)}
                      >
                        <SquarePen size={14} strokeWidth={1.75} />
                      </button>
                    )}
                  </div>
                  {root !== undefined && (
                    <div className={`sx-collapse${openSlug === row.slug ? ' open' : ''}`}>
                      <ul className="session-list" aria-label="sessions">
                        {sessionsError !== '' && <li className="home-error">{sessionsError}</li>}
                        {/* G14.35:RECENTS 只收默认锚点会话,组内列表恢复展示本项目全部会话 */}
                        {sessions !== null && sessions.length === 0 && (
                          <li className="no-sessions">{t('No sessions', '暂无会话')}</li>
                        )}
                        {sessions?.map((sr) => {
                          // G14.52:活动会话圆点以 runActive 为准;他会话看 daemon 标注
                          const active =
                            activeSessionId !== '' &&
                            (sr.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === sr.id);
                          const running = active
                            ? runActive
                            : sr.liveSessionId !== undefined && sr.liveSessionId !== activeSessionId;
                          const label = sr.title ?? sr.firstUser ?? t('New session', '新会话');
                          // G14.188 项目组会话行同样 hover 出会话信息(与最近会话行同款;贴主对话缘)
                          const srMeta = [
                            sr.runs !== undefined ? t(`${sr.runs} rounds`, `${sr.runs} 轮`) : '',
                            sr.steps !== undefined ? t(`${sr.steps} steps`, `${sr.steps} 步`) : '',
                            sr.createdAt !== undefined ? `${t('Created', '创建于')} ${sr.createdAt.slice(5, 16).replace('T', ' ')}` : '',
                          ].filter((x) => x !== '').join(' · ');
                          return (
                            <li
                              key={sr.id}
                              className={`session-row sx-session-row${active ? ' active' : ''}`}
                              data-session-row="1"
                              data-tip={`${label}${srMeta !== '' ? `\n${srMeta}` : ''}`}
                              data-tip-pos="right"
                              onClick={() => {
                                if (busy || root === undefined) return;
                                attachJournal(root, sr.id, sr.updatedAt);
                              }}
                            >
                              {running ? (
                                <span className="sx-session-dot running" />
                              ) : isUnseen(sr.id, sr.updatedAt) ? (
                                <span className="sx-session-dot unseen" />
                              ) : null}
                              <span className="session-summary" data-id={sr.id}>{label}</span>
                              <span className="session-meta">{relTime(sr.updatedAt)}</span>
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
        {/* RECENTS 在 PROJECTS 下侧(用户裁定);空态「暂无最近会话」占位 */}
        {/* G14.42:RECENTS 头同 PROJECTS 款——chevron 紧跟标题(hover 显形/点击折叠),✎ 新建默认会话 */}
        <div
          className="sx-side-head sx-side-head-row sx-side-head-btn"
          role="button"
          aria-expanded={recentsOpen}
          tabIndex={0}
          onClick={() => {
            setRecentsOpen((v) => !v);
            setRecentLimit(RECENT_VISIBLE_DEFAULT); // G14.115 折叠再展开回默认显形
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setRecentsOpen((v) => !v);
              setRecentLimit(RECENT_VISIBLE_DEFAULT);
            }
          }}
        >
          <span>{t('Recents', '最近会话')}</span>
          <ChevronRight
            size={12}
            strokeWidth={2}
            aria-hidden="true"
            className={`sx-side-chev${recentsOpen ? ' open' : ''}`}
          />
          {defaultAnchorRoot !== undefined && (
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="new default chat"
              data-tip={t('New chat in default workspace', '默认工作区新对话')}
              onClick={(e) => {
                e.stopPropagation();
                onComposeIn(defaultAnchorRoot);
              }}
            >
              <SquarePen size={14} strokeWidth={1.75} />
            </button>
          )}
        </div>
        <div className={`sx-collapse sx-collapse-recents${recentsOpen ? ' open' : ''}`}>
        <ul className="recent-list" aria-label="recent sessions">
          {recents !== null && recents.length === 0 && <li className="no-sessions">{t('No recent sessions', '暂无最近会话')}</li>}
          {(recents ?? []).slice(0, recentLimit).map((r) => {
            // G14.52:活动会话圆点以 runActive 为准;他会话看 daemon 标注
            const active =
              activeSessionId !== '' &&
              (r.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === r.id);
            const running = active
              ? runActive
              : r.liveSessionId !== undefined && r.liveSessionId !== activeSessionId;
            const label = r.title ?? r.firstUser ?? t('New session', '新会话');
            const metaLine = sessionMetaLine(r);
            return (
              <li
                key={`${r.root}/${r.id}`}
                className={`session-row sx-session-row${active ? ' active' : ''}`}
                data-session-row="1"
                onClick={() => {
                  if (busy) return;
                  attachJournal(r.root, r.id);
                }}
              >
                {running ? (
                  <span className="sx-session-dot running" />
                ) : isUnseen(r.id, r.updatedAt) ? (
                  <span className="sx-session-dot unseen" />
                ) : null}
                <span className="session-summary" data-tip={`${label}${metaLine !== '' ? `\n${metaLine}` : ''}`} data-tip-pos="right">{label}</span>
                <span className="session-meta">{relTime(r.updatedAt)}</span>
              </li>
            );
          })}
          {/* G14.115 尾行分页控件:有藏 >「显示更多」(步进 10);已全放且曾展开 >「收起」复位 */}
          {recents !== null && recents.length > RECENT_VISIBLE_DEFAULT && (
            recents.length > recentLimit ? (
              <li
                key="recent-more"
                className="recent-more"
                role="button"
                tabIndex={0}
                onClick={() => setRecentLimit((v) => Math.min(v + RECENT_VISIBLE_STEP, recents.length))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setRecentLimit((v) => Math.min(v + RECENT_VISIBLE_STEP, recents.length));
                  }
                }}
              >
                {t('Show more', '显示更多')}
              </li>
            ) : recentLimit > RECENT_VISIBLE_DEFAULT ? (
              <li
                key="recent-less"
                className="recent-more"
                role="button"
                tabIndex={0}
                onClick={() => setRecentLimit(RECENT_VISIBLE_DEFAULT)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setRecentLimit(RECENT_VISIBLE_DEFAULT);
                  }
                }}
              >
                {t('Collapse', '收起')}
              </li>
            ) : null
          )}
        </ul>
        </div>
        {dirOpen && (
          <div className="modal-overlay" onClick={() => setDirOpen(false)}>
            <div className="modal-body" onClick={(e) => e.stopPropagation()}>
              <DirPicker conn={conn} showManual={false} onCancel={() => setDirOpen(false)} onConfirm={registerFolder} />
            </div>
          </div>
        )}
      </div>
      <footer className="sx-menu-foot">
        {onOpenSettings !== undefined && (
          <button
            type="button"
            aria-label="open settings"
            className="sx-iconbtn"
            data-tip="设置"
            onClick={onOpenSettings}
          >
            <Settings size={18} strokeWidth={1.75} />
          </button>
        )}
      </footer>
    </nav>
  );
}
