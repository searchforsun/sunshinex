import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { DirPicker } from './DirPicker';

/**
 * 首页(G3.5 会话中心入口):左栏工作区列表(GET /workspaces,刷新按钮;root 在场行可展开
 * → GET /sessions?root= 会话行 + Attach 按钮;历史工作区 root 缺场 → 行禁用附提示不可展开);
 * 右栏选中工作区详情(root 路径/会话数/更新时间);「New session」→ DirPicker 模态(逐级浏览
 * /自定义路径/确认)。空态引导文案。
 * Attach 两步裁定(daemon 形态对齐):POST /session/new {root} 装配会话 → POST /session/:id/attach
 * {journalId} 播种恢复 → onOpenSession(sessionId)(daemon 会话注册表无「按 journal 直开」端点,
 * attach 需先有会话壳)。New session 单步:newSession(root) 即入;G6 增 mode 面——DirPicker
 * 「Manual approvals」勾选 → newSession(root, 'manual')(G4 fetch 注入面退役,UI 真面建 manual)。
 * G3.5+T2:会话行 Delete 已退役(G5 裁定——以 journal id 打会话端点恒 404,回收改 Chat 顶栏
 * Delete 按 daemon 会话 id 寻址);sessionsOf 应答 slug 守卫——展开切换/收起后的迟到应答丢弃
 * (慢应答不冲当前展开列表)。
 */

export interface HomeConn {
  workspaces(): Promise<WorkspaceRow[]>;
  sessionsOf(root: string): Promise<SessionRow[]>;
  dirpicker(path?: string): Promise<{ path: string; parent: string; dirs: string[] }>;
  newSession(root: string, mode?: 'manual'): Promise<{ sessionId: string }>;
  attach(sessionId: string, journalId: string): Promise<void>;
}

export interface HomeProps {
  conn: HomeConn;
  onOpenSession: (sessionId: string) => void;
}

export function Home({ conn, onOpenSession }: HomeProps): JSX.Element {
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null);
  const [listError, setListError] = useState('');
  /** 展开中的工作区 slug(= 选中,右栏详情挂它);同时只展开一行 */
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  /** openSlug 的同步镜像:sessionsOf 异步应答到达时读(闭包免陈旧——slug 守卫判据) */
  const openSlugRef = useRef<string | null>(null);
  openSlugRef.current = openSlug;
  const [openRoot, setOpenRoot] = useState<string>('');
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionsError, setSessionsError] = useState('');
  /** attach/new/delete 在途(按钮禁用防双发) */
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const selected = rows?.find((r) => r.slug === openSlug) ?? null;

  const loadWorkspaces = useCallback((): void => {
    conn.workspaces().then(
      (list) => {
        setRows(list);
        setListError('');
      },
      (err: unknown) => setListError(err instanceof Error ? err.message : String(err)),
    );
  }, [conn]);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  /** 拉某工作区会话列表(slug 守卫):应答到达时 slug 已非当前展开(切行/收起)则丢弃——
   *  迟到应答不冲新展开行(慢应答竞态收口) */
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

  /** 展开/收起工作区行:展开即拉 sessionsOf(root);root 缺场行按钮禁用不可达 */
  const toggleRow = (row: WorkspaceRow): void => {
    if (row.root === undefined) return;
    if (openSlug === row.slug) {
      setOpenSlug(null);
      setOpenRoot('');
      setSessions(null);
      return;
    }
    setOpenSlug(row.slug);
    setOpenRoot(row.root);
    setSessions(null);
    setSessionsError('');
    loadSessions(row.root, row.slug);
  };

  /** Attach 两步:newSession(root) 装配壳 → attach(sessionId, journalId) 播种 → 进会话 */
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
          onOpenSession(sessionId);
        },
        (err: unknown) => {
          setBusy(false);
          setActionError(err instanceof Error ? err.message : String(err));
        },
      );
  };

  /** New session:DirPicker 确认 → newSession(root, manual ? 'manual' : undefined)(G6 mode 面
   *  ——Manual approvals 勾选即建 manual 会话;缺省不发 mode 字段,旧 daemon 兼容)→ 进会话;
   *  失败留在首页示错 */
  const createSession = (root: string, manual: boolean): void => {
    if (busy || root === '') return;
    setBusy(true);
    setActionError('');
    conn.newSession(root, manual ? 'manual' : undefined).then(
      ({ sessionId }) => {
        setBusy(false);
        setPickerOpen(false);
        onOpenSession(sessionId);
      },
      (err: unknown) => {
        setBusy(false);
        setActionError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  return (
    <main className="home" aria-label="home">
      <section className="workspaces" aria-label="workspaces">
        <header className="home-head">
          <h1>工作区</h1>
          <div className="home-actions">
            <button type="button" aria-label="refresh workspaces" onClick={loadWorkspaces}>
              刷新
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setActionError('');
                setPickerOpen(true);
              }}
            >
              New session
            </button>
          </div>
        </header>
        {listError !== '' && (
          <p className="home-error" role="alert">
            {listError}
          </p>
        )}
        {rows === null && listError === '' && <p className="home-loading">加载工作区…</p>}
        {rows !== null && rows.length === 0 && (
          <div className="home-empty">
            <p>尚无工作区。</p>
            <p>点「New session」选择一个项目目录,开启第一个会话。</p>
          </div>
        )}
        <ul className="workspace-list">
          {rows?.map((row) => (
            <li key={row.slug} className={`workspace-item${row.root === undefined ? ' no-root' : ''}`}>
              <div className="workspace-row">
                <button
                  type="button"
                  className="workspace-toggle"
                  disabled={row.root === undefined}
                  aria-expanded={openSlug === row.slug}
                  title={row.root ?? 'root 未登记(历史工作区)——无法恢复会话'}
                  onClick={() => toggleRow(row)}
                >
                  <span className="ws-slug">{row.slug}</span>
                  <span className="ws-count">{row.sessionCount} sessions</span>
                </button>
              </div>
              {row.root === undefined && <span className="ws-hint">root 未登记,不可恢复</span>}
              {openSlug === row.slug && row.root !== undefined && (
                <ul className="session-list" aria-label="sessions">
                  {sessions === null && sessionsError === '' && <li className="sessions-loading">加载会话…</li>}
                  {sessionsError !== '' && <li className="home-error">{sessionsError}</li>}
                  {sessions !== null && sessions.length === 0 && <li className="no-sessions">暂无会话——「New session」新建。</li>}
                  {sessions?.map((s) => (
                    <li key={s.id} className="session-row">
                      <div className="session-info">
                        <span className="session-summary">{s.firstUser ?? '(无摘要)'}</span>
                        <span className="session-meta">
                          {s.id} · {new Date(s.updatedAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="session-actions">
                        <button
                          type="button"
                          className="attach"
                          disabled={busy}
                          onClick={() => {
                            if (row.root !== undefined) attachJournal(row.root, s.id);
                          }}
                        >
                          Attach
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="workspace-detail" aria-label="workspace detail">
        {selected === null ? (
          <p className="detail-empty">选择左侧工作区查看会话。</p>
        ) : (
          <>
            <h2>{selected.slug}</h2>
            <dl className="detail-grid">
              <dt>root</dt>
              <dd className="detail-root">{selected.root ?? '(未登记)'}</dd>
              <dt>会话数</dt>
              <dd>{selected.sessionCount}</dd>
              <dt>更新</dt>
              <dd>{new Date(selected.mtime).toLocaleString()}</dd>
            </dl>
            {openRoot !== '' && (
              <p className="detail-hint">展开左栏工作区行可恢复(attach)既有会话日志。</p>
            )}
          </>
        )}
        {actionError !== '' && !pickerOpen && (
          <p className="home-error" role="alert">
            {actionError}
          </p>
        )}
      </section>
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
    </main>
  );
}
