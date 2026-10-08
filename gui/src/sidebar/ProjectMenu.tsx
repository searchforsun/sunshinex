import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { DirPicker } from '../pages/DirPicker';
import { relTime } from '../ui-util';
import { ChevronRight, Plus, RefreshCw, Settings, SquarePen } from 'lucide-react';

/**
 * 左栏项目分组菜单(G8a-T4,spec §1):Home 页职能内化——工作区=项目组,一项目一工作区。
 * 组列表(GET /workspaces):组头(chevron+Folder+slug+会话数)点击展开惰拉 GET /sessions?root=
 * (slug 守卫照搬 Home——openSlugRef 过期应答丢弃);root 缺场历史组禁用不可展开;组内「+」弹
 * mode 菜单(auto/manual)→ newSession(root, mode) 直进;会话行 Attach 两步(newSession 装配壳
 * → attach 播种)→ onOpenSession(sessionId, root)。底部「+ 添加工作区」开 DirPicker 模态
 * (Home 的 modal-overlay 结构原样)。底栏连接态点(conn-dot conn-{state},App 同款)。
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
}

/** 连接态中文标签(底部状态行;键=ConnectionState 四态) */
const CONN_LABEL: Record<string, string> = { connecting: '连接中', open: '已连接', reconnecting: '重连中', closed: '未连接' };

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
  const { conn, connState, activeSessionId, activeRoot, onOpenSession, onOpenSettings } = props;
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
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 组内「+」的 mode 弹层挂哪组(slug;null = 收) */
  const [menuSlug, setMenuSlug] = useState<string | null>(null);

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
      setSessions(null);
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

  /** mode 弹层外点收(点组「+」自身走 click 切换,不在收面) */
  useEffect(() => {
    if (menuSlug === null) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target;
      if (t instanceof Element && t.closest('[role="menu"]') === null && t.closest('.sx-iconbtn') === null) {
        setMenuSlug(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuSlug]);

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
          onOpenSession(sessionId, root);
        },
        (err: unknown) => {
          setBusy(false);
          setActionError(err instanceof Error ? err.message : String(err));
        },
      );
  };

  /** 组内「+」新建(mode 弹层选中即调):auto 缺省不发 mode 字段(旧 daemon 兼容)/manual
   *  显式;失败行内报错 */
  const createInGroup = (root: string, mode: 'auto' | 'manual'): void => {
    setMenuSlug(null);
    if (busy) return;
    setBusy(true);
    setActionError('');
    conn.newSession(root, mode === 'manual' ? 'manual' : undefined).then(
      ({ sessionId }) => {
        setBusy(false);
        loadWorkspaces(); // 组内新建落位即刷新组列表(spec §1:ws-count 随新 rows 到场;attachJournal 不改工作区面不刷)
        onOpenSession(sessionId, root);
      },
      (err: unknown) => {
        setBusy(false);
        setActionError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  /** 「新对话」nav 行(G10-C2):最近激活工作区直建(auto);无激活工作区禁用(title 提示) */
  const newChatActive = (): void => {
    if (busy || activeRoot === '') return;
    setBusy(true);
    setActionError('');
    conn.newSession(activeRoot).then(
      ({ sessionId }) => {
        setBusy(false);
        loadWorkspaces();
        onOpenSession(sessionId, activeRoot);
      },
      (err: unknown) => {
        setBusy(false);
        setActionError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  /** 「+ 添加工作区」:DirPicker 确认 → newSession(root, manual ? 'manual' : undefined)
   *  (G6 mode 面——Manual approvals 勾选即建 manual 会话)→ onOpenSession;失败留在弹层示错 */
  const createSession = (root: string, manual: boolean): void => {
    if (busy || root === '') return;
    setBusy(true);
    setActionError('');
    conn.newSession(root, manual ? 'manual' : undefined).then(
      ({ sessionId }) => {
        setBusy(false);
        setPickerOpen(false);
        loadWorkspaces(); // 选新项目根→刷新组列表(spec §1:新装首工作区后左栏即见,activeRoot 自动展开 effect 随新 rows 接手)
        onOpenSession(sessionId, root);
      },
      (err: unknown) => {
        setBusy(false);
        setActionError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  return (
    <nav className="sx-menu" aria-label="projects">
      <header className="sx-menu-head">
        <span className="sx-brand">Sunshinex</span>
        <button type="button" aria-label="refresh workspaces" className="sx-iconbtn" title="刷新" onClick={loadWorkspaces}>
          <RefreshCw size={16} strokeWidth={1.75} />
        </button>
      </header>
      <button
        type="button"
        className="sx-new-chat"
        aria-label="new chat"
        disabled={busy || activeRoot === ''}
        title={activeRoot === '' ? '先在 Projects 选择工作区' : '新对话'}
        onClick={newChatActive}
      >
        <SquarePen size={16} strokeWidth={1.75} />
        <span>新对话</span>
      </button>
      <div className="sx-side-head">Projects</div>
      <ul className="workspace-list sx-groups" aria-label="workspace groups">
        {rows === null && listError === '' && <li className="home-loading">加载工作区…</li>}
        {listError !== '' && (
          <li className="home-error" role="alert">
            {listError}
          </li>
        )}
        {rows !== null && rows.length === 0 && (
          <li className="home-empty">尚无工作区——「+ 添加工作区」选择项目目录开启第一个。</li>
        )}
        {actionError !== '' && !pickerOpen && (
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
                  <span
                    className="sx-chevron"
                    style={{ transform: openSlug === row.slug ? 'rotate(90deg)' : 'none' }}
                  >
                    <ChevronRight size={16} strokeWidth={1.75} />
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
                    disabled={busy}
                    onClick={() => setMenuSlug((s) => (s === row.slug ? null : row.slug))}
                  >
                    <Plus size={16} strokeWidth={1.75} />
                  </button>
                )}
                {menuSlug === row.slug && root !== undefined && (
                  <div className="sx-menu-pop" role="menu" aria-label="new session mode">
                    <button
                      type="button"
                      role="menuitem"
                      className="sx-menuitem"
                      disabled={busy}
                      onClick={() => createInGroup(root, 'auto')}
                    >
                      auto 自动审批
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="sx-menuitem"
                      disabled={busy}
                      onClick={() => createInGroup(root, 'manual')}
                    >
                      manual 手动审批
                    </button>
                  </div>
                )}
              </div>
              {openSlug === row.slug && root !== undefined && (
                <ul className="session-list" aria-label="sessions">
                  {sessions === null && sessionsError === '' && <li className="sessions-loading">加载会话…</li>}
                  {sessionsError !== '' && <li className="home-error">{sessionsError}</li>}
                  {sessions !== null && sessions.length === 0 && (
                    <li className="no-sessions">暂无会话——组内「+」新建。</li>
                  )}
                  {sessions?.map((s) => {
                    // active 判定:id 直配优先;兜底 activeRoot 组内行点亮——daemon 会话 id
                    // (newSession 回抛)与 journal 行 id(GET /sessions?root=)异名,id 直配
                    // 恒不中(见 task-4 测试:activeSessionId='new-…' vs 行 id='j1')
                    const active =
                      activeSessionId !== '' && (s.id === activeSessionId || root === activeRoot);
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
                        <span className={`sx-session-dot${running ? ' running' : ''}`} title={running ? '运行中会话' : undefined} />
                        <span className="session-summary" title={`${s.firstUser ?? ''} · ${s.id}`}>
                          {s.firstUser ?? '(无摘要)'}
                        </span>
                        <span className="session-meta">{relTime(s.updatedAt)}</span>
                        <button
                          type="button"
                          className="attach"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            attachJournal(root, s.id);
                          }}
                        >
                          Attach
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className="sx-side-head">Recents</div>
      <ul className="recent-list" aria-label="recent sessions">
        {recents === null && <li className="sessions-loading">加载会话…</li>}
        {recents !== null && recents.length === 0 && <li className="no-sessions">暂无最近会话</li>}
        {recents?.map((r) => {
          const running = r.id === activeSessionId;
          // active 兜底与组行同判据(activeSessionId 异名:daemon 会话 id ≠ journal id,root 兜底点亮)
          const active = activeSessionId !== '' && (r.id === activeSessionId || r.root === activeRoot);
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
              <span className={`sx-session-dot${running ? ' running' : ''}`} />
              <span className="session-summary" title={`${r.firstUser ?? ''} · ${r.id}`}>{r.firstUser ?? '(无摘要)'}</span>
              <span className="session-meta">{relTime(r.updatedAt)}</span>
              <button
                type="button"
                className="attach"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  attachJournal(r.root, r.id);
                }}
              >
                Attach
              </button>
            </li>
          );
        })}
      </ul>
      <div className="sx-menu-add">
        <button
          type="button"
          className="sx-add-workspace"
          onClick={() => {
            setActionError('');
            setPickerOpen(true);
          }}
        >
          + 添加工作区
        </button>
      </div>
      <footer className="sx-menu-foot">
        <span className={`conn-dot conn-${connState}`} aria-label={`connection: ${connState}`} />
        <span>{CONN_LABEL[connState] ?? connState}</span>
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
      {pickerOpen && (
        <div className="modal-overlay">
          <div className="modal-body">
            <DirPicker conn={conn} onCancel={() => setPickerOpen(false)} onConfirm={createSession} />
            {actionError !== '' && (
              <p className="home-error" role="alert">
                {actionError}
              </p>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
