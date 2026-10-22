import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { errText, pickWorkspaceFolder } from '../ui-util';
import { t } from '../i18n';
import { Search, Settings, SquarePen } from 'lucide-react';
import { DirPicker } from '../pages/DirPicker';
import {
  loadSeenMap,
  persistSeenMap,
  RECENT_VISIBLE_DEFAULT,
  RECENT_VISIBLE_STEP,
  visibleWorkspaces,
} from './project-menu-util';
import type { SeenMap } from './project-menu-util';
import { ProjectSearch } from './project-menu-search';
import { ProjectsSection } from './project-menu-projects';
import { RecentsSection } from './project-menu-recents';
import { ArchiveSection } from './archive-group';
import { PinnedSection } from './pinned-section';
import { normalizePins, pinFromRow, type PinEntry } from './pin-store';

// FolderAddIcon 消费方(App.tsx)零迁移:原路径再导出
export { FolderAddIcon } from './project-menu-util';


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
  /** attach:daemon 可能收编同 journal 在座会话(运行中刷新恢复)——返回**实际** sessionId */
  attach(sessionId: string, journalId: string): Promise<{ sessionId: string }>;
  /** T6 归档/撤销(Connection 结构化子集):侧栏行归档钮落库面(归档行由服务端列表滤除) */
  archiveSession(id: string, archived: boolean): Promise<void>;
  /** 置顶档(2026-10-21 GUI 专属,GET/PUT /app/pins;userConfigDir/gui/pins.json) */
  appPins(): Promise<{ pins: Array<{ id: string; root: string; title?: string; updatedAt?: number }> }>;
  saveAppPins(pins: Array<{ id: string; root: string; title?: string; updatedAt?: number }>): Promise<void>;
  /** 归档区数据面(跨工作区聚合行;GET /sessions/archived)+ 受控删除(已归档态) */
  archivedSessions(): Promise<Array<{ id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number }>>;
  deleteSession(id: string): Promise<void>;
}

export interface ProjectMenuProps {
  readonly conn: ProjectMenuConn;
  readonly connState: string; // 'connecting'|'online'|'offline'|'reconnecting'(显示态)
  readonly activeSessionId: string; // '' = 无会话
  readonly activeRoot: string; // '' = 无(其所属组自动展开)
  /** G14.16 标题统一流联动:rename 落盘后 App bump——变化即重拉 recentSessions(侧栏即时同名) */
  readonly recentVersion?: number;
  /** G14.52 活动会话运行态(App 本地权威,model-start 置位/done·error 复位):圆点亮熄以此为准 */
  readonly runningIds?: ReadonlySet<string>;
  readonly onOpenSession: (sessionId: string, root: string, journalId?: string) => void;
  /** G8c-T8 设置钮回调:App 开设置态(可选——未配时钮不渲染,免独立测试装配面死 UI) */
  readonly onOpenSettings?: () => void;
  /** 「New chat」:回欢迎页开新对话(G10-C16) */
  readonly onNewChat: () => void;
  /** 项目行「+」:回欢迎页并预选该项目与审批模式(G10-C16) */
  readonly onComposeIn: (root: string, mode?: 'auto' | 'manual') => void;
}

/** 相对时间:G8e-T2 抽共享 ui-util(与 SettingsForm 同款逻辑本地复制收敛) */

export function ProjectMenu(props: ProjectMenuProps): JSX.Element {
  const { conn, activeSessionId, activeRoot, onOpenSession, onOpenSettings, onNewChat, onComposeIn } = props;
  const recentVersion = props.recentVersion ?? 0;
  const runningIds = props.runningIds ?? new Set<string>();
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
  // G14.2xx 名称截断隐现(chrome 同形,同标签条):项目名/会话名溢出打 data-cut=右缘渐隐,无省略号。
  // 无依赖面每次渲染重测(数据/计数变化即新节点),RO 盯滚动容器(拖栏宽度变化即重测)
  const sideScrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const mark = (): void => {
      const root = sideScrollRef.current;
      if (root === null) return;
      for (const el of root.querySelectorAll<HTMLElement>('.sx-ws-name, .session-summary')) {
        if (el.scrollWidth > el.clientWidth + 1) el.setAttribute('data-cut', '');
        else el.removeAttribute('data-cut');
      }
    };
    mark();
    const el = sideScrollRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(mark);
    ro.observe(el);
    return () => ro.disconnect();
  });
  // G14.2xx 组内会话默认收窄:默认显 24h 内活跃(最多 10),「显示更多」放全量,「收起」复位;切组复位
  const [groupShowAll, setGroupShowAll] = useState(false);
  const groupShowAllRef = useRef(false);
  groupShowAllRef.current = groupShowAll;
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
    setGroupShowAll(false);
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
    setGroupShowAll(false);
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
      .then(({ sessionId }) => conn.attach(sessionId, journalId).then((r) => r.sessionId)) // G14.2xx daemon 可能收编在座会话,以返回 id 为准
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
  /** 归档会话区(2026-10-21 用户裁定:归档视图在左侧菜单栏,非右侧主对话页):跨工作区聚合行
   *  (GET /sessions/archived),分区头折叠同 RECENTS;行动作失败经 actionError 通道 */
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivedRows, setArchivedRows] = useState<Array<{ id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number }> | null>(null);
  const loadArchived = useCallback((): void => {
    conn.archivedSessions().then(setArchivedRows, () => setArchivedRows([]));
  }, [conn]);

  /** T6 行内归档(确认 morph 由分区组件行级 confirmId 承载):archiveSession 落库后重拉——
   *  组列表计数 + Recents(loadWorkspaces)、归档层列表(loadArchived,置顶行归档时归档层若
   *  开着需即时回显)与展开组会话行(loadSessions,归档行由服务端列表滤除,T2c)。失败经既有
   *  actionError 通道上屏(终审 F4:不再静默,下次 30s/聚焦刷新自愈) */
  const archiveRow = useCallback(
    (id: string, archived: boolean): void => {
      conn.archiveSession(id, archived).then(() => {
        loadWorkspaces();
        loadArchived();
        const row = (rows ?? []).find((r) => r.slug === openSlugRef.current);
        if (row?.root !== undefined) loadSessions(row.root, row.slug);
      }, (err: unknown) => setActionError(errText(err)));
    },
    [conn, loadWorkspaces, loadArchived, loadSessions, rows],
  );

  const unarchiveArchivedRow = useCallback(
    (id: string): void => {
      conn.archiveSession(id, false).then(() => {
        loadArchived();
        loadWorkspaces(); // 撤销即回主列表:组计数/Recents 即时归位
        const row = (rows ?? []).find((r) => r.slug === openSlugRef.current);
        if (row?.root !== undefined) loadSessions(row.root, row.slug); // 展开组会话行即时回行(与 archiveRow 对称)
      }, (err: unknown) => setActionError(errText(err)));
    },
    [conn, loadArchived, loadWorkspaces, loadSessions, rows],
  );

  /** 置顶会话(2026-10-21 用户裁定,GUI 专属):钉存 userConfigDir/gui/pins.json(GET/PUT /app/pins,
   *  桌面壳与浏览器同 daemon 同享;TUI 无此概念不进共享会话档)。钉组跨工作区聚合于「项目」上方,
   *  不支持折叠;无钉不渲染。归档联动(2026-10-21 用户裁定「点击归档不覆盖置顶分组」):置顶组
   *  显示所有钉,不因归档离组;归档层真删时随删防悬挂 */
  const [pins, setPins] = useState<PinEntry[]>([]);
  const loadPins = useCallback((): void => {
    conn.appPins().then((r) => setPins(normalizePins(r.pins)), () => setPins([]));
  }, [conn]);
  useEffect(() => {
    loadPins(); // 挂载拉钉档(userConfigDir/gui/pins.json;2026-10-21 用户裁定「也要持久化」)
  }, [loadPins]);
  const persistPins = useCallback((next: PinEntry[]): void => {
    setPins(next);
    void conn.saveAppPins(next).then(() => undefined, (err: unknown) => setActionError(errText(err)));
  }, [conn]);
  const pinRow = useCallback((row: PinEntry): void => {
    if (pins.some((p) => p.id === row.id)) return;
    persistPins([row, ...pins]); // 新钉居前
  }, [pins, persistPins]);
  /** 会话行置顶钮消费面:行快照 → 钉条目入列(Projects/Recents 两组行共用) */
  const pinSessionRow = useCallback(
    (row: { id: string; root: string; title?: string; updatedAt: number }): void => pinRow(pinFromRow(row)),
    [pinRow],
  );
  const unpinRow = useCallback((id: string): void => {
    persistPins(pins.filter((p) => p.id !== id));
  }, [pins, persistPins]);
  /** 归档层红删除(二次确认 morph 后):受控删除会话档全家后重拉归档层/组计数/Recents;
   *  真删时随删钉防悬挂钉,保存失败经 actionError 可见化(与 persistPins 同口径) */
  const deleteArchivedRow = useCallback(
    (id: string): void => {
      conn.deleteSession(id).then(() => {
        loadArchived();
        loadWorkspaces();
        persistPins(pins.filter((p) => p.id !== id)); // 真删防悬挂钉(钉档随会话档清除)
      }, (err: unknown) => setActionError(errText(err)));
    },
    [conn, loadArchived, loadWorkspaces, persistPins, pins],
  );
  const pinnedIds = useMemo(() => new Set(pins.map((p) => p.id)), [pins]);

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
        <ProjectSearch
          rows={rows}
          allSessions={allSessions}
          query={query}
          onQuery={setQuery}
          onClose={() => setSearchOpen(false)}
          activeSessionId={activeSessionId}
          runningIds={runningIds}
          journalOfSession={journalOfSession}
          busy={busy}
          isUnseen={isUnseen}
          onAttach={attachJournal}
          onComposeIn={onComposeIn}
        />
      )}
            {/* G14.9:单一滚动区装 PROJECTS + RECENTS;footer 贴底 */}
      <div className="sx-side-scroll" ref={sideScrollRef}>
        {/* 置顶组(2026-10-21 用户裁定):「项目」上方,不支持折叠;无钉不渲染(PinnedSection 判空) */}
        <PinnedSection
          pins={pins}
          busy={busy}
          activeSessionId={activeSessionId}
          runningIds={runningIds}
          journalOfSession={journalOfSession}
          isUnseen={isUnseen}
          onOpenSession={attachJournal}
          onUnpin={unpinRow}
          onArchiveRow={archiveRow}
        />
        <ProjectsSection
          projectsOpen={projectsOpen}
          onToggleProjects={() => setProjectsOpen((v) => !v)}
          busy={busy}
          archiveMode={archiveOpen}
          onExitArchive={() => setArchiveOpen(false)}
          onAddWorkspace={(e) => {
            e.stopPropagation();
            setActionError('');
            pickAndAdd();
          }}
          actionError={actionError}
          rows={rows}
          listError={listError}
          openSlug={openSlug}
          groupShowAll={groupShowAll}
          onGroupShowMore={() => setGroupShowAll(true)}
          sessions={sessions}
          sessionsError={sessionsError}
          activeRoot={activeRoot}
          activeSessionId={activeSessionId}
          runningIds={runningIds}
          journalOfSession={journalOfSession}
          isUnseen={isUnseen}
          onToggleGroup={toggleGroup}
          onComposeIn={onComposeIn}
          onAttach={attachJournal}
          onArchiveRow={archiveRow}
          onOpenArchived={() => {
            setArchiveOpen(true);
            loadArchived();
          }}
          pinnedIds={pinnedIds}
          onPinRow={pinSessionRow}
        />
        {/* 归档层(2026-10-21 用户裁定):整替 Projects 列表体+Recents——无独立分组,组头 X 退出 */}
        {archiveOpen ? (
          <ArchiveSection
            rows={archivedRows}
            busy={busy}
            onOpenSession={attachJournal}
            onUnarchive={unarchiveArchivedRow}
            onDelete={deleteArchivedRow}
          />
        ) : (
          <>
            <RecentsSection
              recentsOpen={recentsOpen}
              onToggleRecents={() => {
                setRecentsOpen((v) => !v);
                setRecentLimit(RECENT_VISIBLE_DEFAULT); // G14.115 折叠再展开回默认显形
              }}
              defaultAnchorRoot={defaultAnchorRoot}
              onComposeIn={onComposeIn}
              recents={recents}
              recentLimit={recentLimit}
              onShowMore={() => setRecentLimit((v) => Math.min(v + RECENT_VISIBLE_STEP, recents?.length ?? v))}
              onCollapse={() => setRecentLimit(RECENT_VISIBLE_DEFAULT)}
              activeSessionId={activeSessionId}
              runningIds={runningIds}
              journalOfSession={journalOfSession}
              isUnseen={isUnseen}
              busy={busy}
              onAttach={attachJournal}
              onArchiveRow={archiveRow}
              pinnedIds={pinnedIds}
              onPinRow={pinSessionRow}
            />
          </>
        )}
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
            data-tip={t('Settings', '设置')}
            onClick={onOpenSettings}
          >
            <Settings size={18} strokeWidth={1.75} />
          </button>
        )}
      </footer>
    </nav>
  );
}
