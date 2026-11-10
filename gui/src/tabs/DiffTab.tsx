import { useCallback, useEffect, useRef, useState } from 'react';
import { Circle, CircleDot } from 'lucide-react';
import { pathBasename, withMinSpin } from '../ui-util';
import { Check, ChevronDown, ChevronUp, GitBranch, GitCommitVertical, Loader2, Plus, RefreshCw, Undo2, Upload } from 'lucide-react';
import { DiffLines } from '../diff-lines';
import { FileIcon } from '../file-icon';
import { t } from '../i18n';
import type { Connection } from '../connection';
import type { TabParams } from './tab-state';
import { ChangeStat, changeCounts } from '../change-stat';
import { GIT_CHANGED_EVENT, notifyGitChanged } from '../pages/chat/use-live-changes';
import { WelcomeBranchMenu } from '../welcome/welcome-branch-menu';
import { useBranchSwitch } from '../branch-switch';

/**
 * 审查页签(G14.99 起;2026-11-09 用户裁定两区改版):
 * 顶栏=分支下拉(筛选/切换/新建,未提交改动阻断时弹「提交并切换」确认)+刷新;
 * 「未暂存」区=暂存全部 + 撤回全部(二次确认,丢弃工作区改动、删除未跟踪文件,不可恢复),不提供提交/推送;
 * 「已暂存」区=提交(只提交暂存区)/推送 + 撤销全部(二次确认,取消暂存——改动退回未暂存区不丢失);
 * 每行右侧单独撤销(二次确认,语义随所在区)。行点击展开内嵌 DiffLines(单开 accordion,纵向滚动交外层);
 * 文件名点击开 file 标签。params.path 在场(主对话 write 条目点击)即自动展开对应项。
 */

export interface DiffTabProps {
  readonly conn: Connection;
  readonly sessionId: string;
  readonly params: TabParams;
  /** 会话工作区根(分支清单/切换走根作用域端点) */
  readonly root?: string;
  /** 点击文件名 → 打开 file 标签预览(App 注入 openTabInSession('file')) */
  readonly onOpenFile?: (path: string) => void;
}

interface ChangeFile {
  path: string;
  status: string;
  added: number | null;
  deleted: number | null;
  /** 新建(untracked)文件内容行数:numstat 不覆盖,作增加行数 */
  newLines?: number;
}
type Area = 'staged' | 'unstaged';
type DiffContent = { oldContent?: string; newContent: string; truncated: boolean; deleted: boolean };

/** 目录后缀拆分(名称+所在目录,与文件面板同构) */
function splitPath(p: string): { base: string; dir: string } {
  const norm = p.replaceAll('\\', '/');
  const base = pathBasename(norm);
  return { base, dir: norm.slice(0, norm.length - base.length) };
}

/** 二次确认武装键:首击武装(按钮转红+提示「再次点击确认」),3s 内再击执行,超时自动解除 */
function useArm(): { armed: string | null; arm: (key: string, run: () => void) => void } {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const arm = (key: string, run: () => void): void => {
    window.clearTimeout(timer.current);
    if (armed === key) {
      setArmed(null);
      run();
      return;
    }
    setArmed(key);
    timer.current = window.setTimeout(() => setArmed(null), 3000);
  };
  return { armed, arm };
}

export function DiffTab({ conn, sessionId, params, root, onOpenFile }: DiffTabProps): JSX.Element {
  const autoPath = params.path;
  const [branch, setBranch] = useState('');
  const [staged, setStaged] = useState<ChangeFile[]>([]);
  const [unstaged, setUnstaged] = useState<ChangeFile[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** 单开 accordion:键=区:路径(同一文件可同时在两区) */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, DiffContent>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<'commit' | 'push' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [autoDone, setAutoDone] = useState(false);
  const [branches, setBranches] = useState<{ current: string; branches: string[] } | null>(null);
  /** 区域筛选(2026-11-10 用户裁定:顶栏下拉选 已暂存/未暂存,下方只列所选区) */
  const [areaFilter, setAreaFilter] = useState<Area>('unstaged');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (filterRef.current !== null && e.target instanceof Node && !filterRef.current.contains(e.target)) setFilterOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [filterOpen]);
  const [branchOpen, setBranchOpen] = useState(false);
  const branchRef = useRef<HTMLDivElement | null>(null);
  const { armed, arm } = useArm();

  const refresh = useCallback((): void => {
    if (refreshing) return;
    setRefreshing(true);
    withMinSpin(conn.sessionChanges?.(sessionId) ?? Promise.resolve({ branch: '', files: [] as ChangeFile[] })).then(
      (r) => {
        setBranch(r.branch);
        setStaged(r.staged ?? []);
        setUnstaged(r.unstaged ?? r.files);
        setContents({}); // 区内容随操作变化:清缓存,展开项按需重拉
        setLoadErr(null);
      },
      (err: unknown) => setLoadErr(err instanceof Error ? err.message : String(err)),
    ).finally(() => setRefreshing(false));
  }, [conn, sessionId, refreshing]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    window.addEventListener(GIT_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(GIT_CHANGED_EVENT, refresh);
  }, [refresh]);

  const fetchContent = useCallback((area: Area, p: string): void => {
    const key = `${area}:${p}`;
    if (contents[key] !== undefined) return;
    setLoadingKey(key);
    conn.sessionChangeContent(sessionId, p, area).then(
      (c) => {
        setContents((m) => ({ ...m, [key]: c }));
        setLoadingKey((k) => (k === key ? null : k));
      },
      () => setLoadingKey((k) => (k === key ? null : k)),
    );
  }, [conn, sessionId, contents]);

  // 主对话 write 点击 → 自动展开对应项(未暂存优先)
  useEffect(() => {
    if (autoDone || autoPath === undefined) return;
    const area: Area | null = unstaged.some((f) => f.path === autoPath) ? 'unstaged' : staged.some((f) => f.path === autoPath) ? 'staged' : null;
    if (area === null) return;
    setAutoDone(true);
    setOpenKey(`${area}:${autoPath}`);
    fetchContent(area, autoPath);
  }, [autoDone, autoPath, unstaged, staged, fetchContent]);

  const toggle = (area: Area, p: string): void => {
    const key = `${area}:${p}`;
    setOpenKey((cur) => (cur === key ? null : key));
    if (openKey !== key) fetchContent(area, p);
  };

  /** 操作单点:busy 标签 → 执行 → 成功广播(审查面与各轮尾条同步重拉),失败回显 */
  const run = (tag: string, op: () => Promise<void>, okText?: string, after?: () => void): void => {
    setBusy(tag);
    setResult(null);
    op().then(
      () => {
        setBusy(null);
        if (okText !== undefined) setResult({ ok: true, text: okText });
        after?.();
        notifyGitChanged();
      },
      (err: unknown) => {
        setBusy(null);
        setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
      },
    );
  };
  const flashOk = (kind: 'commit' | 'push'): void => {
    setFlash(kind);
    setTimeout(() => setFlash((cur) => (cur === kind ? null : cur)), 2000);
  };

  // 分支下拉:清单按需拉,切换/新建经 useBranchSwitch(脏树确认框)
  const loadBranches = (): void => {
    if (root === undefined || root === '') return;
    void conn.gitBranches(root).then((r) => setBranches(r.branches.length > 0 ? r : null), () => setBranches(null));
  };
  useEffect(() => {
    if (!branchOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (branchRef.current !== null && e.target instanceof Node && !branchRef.current.contains(e.target)) setBranchOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [branchOpen]);
  const { switchTo, dialog: branchDialog } = useBranchSwitch({
    conn,
    root: root ?? '',
    onSwitched: () => {
      loadBranches();
      notifyGitChanged();
    },
    onError: (msg) => setResult({ ok: false, text: `${t('Branch switch failed', '切换分支失败')}: ${msg}` }),
  });

  const actBtn = (o: { label: string; icon: JSX.Element; onClick: () => void; disabled?: boolean; armKey?: string }): JSX.Element => {
    const isArmed = o.armKey !== undefined && armed === o.armKey;
    return (
      <button
        type="button"
        className={`sx-changes-act${isArmed ? ' arm' : ''}`}
        aria-label={o.label}
        data-tip={isArmed ? t('Click again to confirm', '再次点击确认') : o.label}
        disabled={o.disabled === true || busy !== null}
        onClick={(e) => {
          e.stopPropagation();
          if (o.armKey !== undefined) arm(o.armKey, o.onClick);
          else o.onClick();
        }}
      >
        {o.icon}
      </button>
    );
  };
  const spinOr = (tag: string, icon: JSX.Element): JSX.Element =>
    busy === tag ? <Loader2 size={14} strokeWidth={1.75} style={{ animation: 'sx-spin 1s linear infinite' }} aria-hidden="true" /> : icon;

  const renderRows = (area: Area, list: ChangeFile[]): JSX.Element => (
    <div className="sx-changes-list">
      {list.map((f) => {
        const { base, dir } = splitPath(f.path);
        const key = `${area}:${f.path}`;
        const open = openKey === key;
        const c = contents[key];
        const revertLabel = area === 'staged' ? t('Unstage this file', '撤销此文件的暂存') : t('Discard changes to this file', '撤销此文件的改动');
        return (
          <div key={key} className={`sx-change${open ? ' open' : ''}`}>
            <div className="sx-change-row" role="button" tabIndex={-1} aria-expanded={open} onClick={() => toggle(area, f.path)}>
              <FileIcon path={f.path} />
              <button
                type="button"
                className="sx-change-name"
                data-tip={t('Open file tab', '打开文件标签')}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFile?.(f.path);
                }}
              >
                {base}
              </button>
              <span className="sx-change-dir">{dir}</span>
              <span className="sx-change-stat">
                <ChangeStat {...changeCounts(f)} />
              </span>
              {actBtn({
                label: revertLabel,
                icon: spinOr(`row:${key}`, <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />),
                armKey: `row:${key}`,
                onClick: () =>
                  run(`row:${key}`, () => (area === 'staged' ? conn.unstageChanges(sessionId, [f.path]) : conn.discardUnstaged(sessionId, [f.path]))),
              })}
              <span className="sx-change-toggle" aria-hidden="true">
                {open ? <ChevronUp size={14} strokeWidth={1.75} /> : <ChevronDown size={14} strokeWidth={1.75} />}
              </span>
            </div>
            {open && (
              <div className="sx-change-body">
                {loadingKey === key || c === undefined ? (
                  <div className="sx-change-loading" role="status">{t('loading diff…', 'diff 加载中…')}</div>
                ) : (
                  <DiffLines oldStr={c.oldContent} newStr={c.newContent} path={f.path} collapsible variant="flat" />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="sx-diff-tab sx-changes" aria-label="diff tab">
      <div className="sx-changes-bar">
        {root !== undefined && root !== '' && branch !== '' ? (
          <div className="pill-anchor sx-changes-branch-anchor" ref={branchRef}>
            <button
              type="button"
              className="sx-changes-branch sx-changes-branch-btn"
              aria-label="review branch"
              aria-expanded={branchOpen}
              data-tip={t('Switch branch', '切换分支')}
              onClick={() => {
                if (!branchOpen) loadBranches();
                setBranchOpen((v) => !v);
              }}
            >
              <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="sx-changes-branch-name">{branch}</span>
              <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            {branchOpen && branches !== null && (
              <WelcomeBranchMenu
                gitBr={branches}
                onPick={(b) => {
                  setBranchOpen(false);
                  if (b !== branches.current) switchTo(b);
                }}
                onCreate={(b) => {
                  setBranchOpen(false);
                  switchTo(b, true);
                }}
              />
            )}
            {branchDialog}
          </div>
        ) : (
          <span className="sx-changes-branch">{branch !== '' ? branch : t('Changes', '变动')}</span>
        )}
        <div className="pill-anchor sx-changes-area-anchor" ref={filterRef}>
          <button
            type="button"
            className="sx-changes-branch-btn sx-changes-area-btn"
            aria-label="changes area"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((v) => !v)}
          >
            {areaFilter === 'staged' ? <CircleDot size={14} strokeWidth={1.75} aria-hidden="true" /> : <Circle size={14} strokeWidth={1.75} aria-hidden="true" />}
            <span className="sx-changes-branch-name">{areaFilter === 'staged' ? t('Staged', '已暂存') : t('Unstaged', '未暂存')}</span>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {filterOpen && (
            <div className="sx-menu-pop branch-pop sx-area-pop" role="menu" aria-label={t('Changes area', '改动区')}>
              {(['staged', 'unstaged'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  role="menuitemradio"
                  aria-checked={areaFilter === a}
                  className={`sx-menuitem${areaFilter === a ? ' active' : ''}`}
                  onClick={() => {
                    setAreaFilter(a);
                    setFilterOpen(false);
                  }}
                >
                  <span className="branch-pop-name">{a === 'staged' ? t('Staged', '已暂存') : t('Unstaged', '未暂存')}</span>
                  {areaFilter === a && <Check size={16} strokeWidth={2} className="branch-pop-check" aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="sx-changes-bar-actions">
          {areaFilter === 'staged' ? (
            <>
              {actBtn({
                label: t('Commit staged', '提交已暂存'),
                icon: flash === 'commit' ? <Check size={14} strokeWidth={2.25} aria-hidden="true" /> : <GitCommitVertical size={14} strokeWidth={1.75} aria-hidden="true" />,
                disabled: staged.length === 0,
                onClick: () => setCommitOpen((v) => !v),
              })}
              {actBtn({
                label: t('Push', '推送'),
                icon: flash === 'push' ? <Check size={14} strokeWidth={2.25} aria-hidden="true" /> : spinOr('push', <Upload size={14} strokeWidth={1.75} aria-hidden="true" />),
                onClick: () => run('push', () => conn.pushChanges(sessionId), t('Pushed', '已推送'), () => flashOk('push')),
              })}
              {actBtn({
                label: t('Unstage all', '撤销全部暂存'),
                icon: spinOr('unstage-all', <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />),
                disabled: staged.length === 0,
                armKey: 'unstage-all',
                onClick: () => run('unstage-all', () => conn.unstageChanges(sessionId)),
              })}
            </>
          ) : (
            <>
              {actBtn({
                label: t('Stage all', '暂存全部'),
                icon: spinOr('stage-all', <Plus size={14} strokeWidth={1.75} aria-hidden="true" />),
                disabled: unstaged.length === 0,
                onClick: () => run('stage-all', () => conn.stageChanges(sessionId)),
              })}
              {actBtn({
                label: t('Discard all changes', '撤回全部未暂存'),
                icon: spinOr('discard-all', <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />),
                disabled: unstaged.length === 0,
                armKey: 'discard-all',
                onClick: () => run('discard-all', () => conn.discardUnstaged(sessionId)),
              })}
            </>
          )}
          {actBtn({ label: t('Refresh', '刷新'), icon: <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" className={refreshing ? 'sx-fetching' : undefined} />, onClick: refresh })}
        </span>
      </div>
      {result !== null && (
        <div className={`sx-changes-result ${result.ok ? 'ok' : 'err'}`} role="status">
          {result.text}
        </div>
      )}
      {loadErr !== null && <div className="sx-changes-result err">{loadErr}</div>}

      {/* 非 git 目录(branch 空)不出改动区——无暂存/提交语义,只留空态 */}
      {branch !== '' && (
        <div className="sx-changes-section">
          <div className="sx-changes-section-head">
            <span className="sx-changes-section-title">
              {areaFilter === 'staged' ? t('Staged changes', '已暂存的更改') : t('Changes', '未暂存的更改')}{' '}
              <span className="sx-changes-count">{(areaFilter === 'staged' ? staged : unstaged).length}</span>
            </span>
          </div>
          {commitOpen && areaFilter === 'staged' && staged.length > 0 && (
            <div className="sx-changes-commit">
              <textarea
                aria-label="commit message"
                className="sx-changes-commit-msg"
                rows={3}
                placeholder={t('Commit message…', '提交信息…')}
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
              />
              <div className="sx-changes-commit-foot">
                <button type="button" disabled={busy !== null} onClick={() => { setCommitOpen(false); setResult(null); }}>
                  {t('Cancel', '取消')}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null || commitMsg.trim() === ''}
                  onClick={() =>
                    run('commit', () => conn.commitChanges(sessionId, commitMsg, true), t('Committed', '已提交'), () => {
                      setCommitMsg('');
                      setCommitOpen(false);
                      flashOk('commit');
                    })
                  }
                >
                  {busy === 'commit' ? t('Committing…', '提交中…') : t('Commit', '提交')}
                </button>
              </div>
            </div>
          )}
          {renderRows(areaFilter, areaFilter === 'staged' ? staged : unstaged)}
        </div>
      )}

      {staged.length === 0 && unstaged.length === 0 && loadErr === null && (
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">{t('No uncommitted changes', '没有未提交的变动')}</p>
          <p className="board-empty-hint">{t('Working tree changes will appear here.', '工作区改动会显示在这里。')}</p>
        </div>
      )}
    </div>
  );
}
