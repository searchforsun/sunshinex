import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, Upload, GitCommitVertical } from 'lucide-react';
import { DiffLines } from '../diff-lines';
import { FileIcon } from '../file-icon';
import { t } from '../i18n';
import type { Connection } from '../connection';
import type { TabParams } from './tab-state';

/**
 * G14.99 Diff 标签终态:工作区未提交变动目录(未暂存视图)——
 * 顶栏(分支+刷新+提交/推送钮) / 文件列表(图标+名称+目录后缀+±统计,行点击展开内嵌
 * DiffLines flat;文件名点击开 file 标签预览) / params.path 在场(主对话 write 条目点击)
 * 即自动展开对应项。params.callId 历史语义(write 时刻快照)保留:callId 在场且 path 不在
 * 变动列表 → 回落旧单文件 diff 视图(G8d 面)。提交/推送弹窗:message 输入 + 双动作。
 * G14.120:单开 accordion(同一时刻至多一个文件展开,diff 平铺无内滚——纵向滚动统一外层);
 * hunk 折叠(上下文各留 4 行)+ LCS 行配对(行号双列不错位)。
 */

export interface DiffTabProps {
  readonly conn: Connection;
  readonly sessionId: string;
  readonly params: TabParams;
  /** 点击文件名 → 打开 file 标签预览(App 注入 openTabInSession('file')) */
  readonly onOpenFile?: (path: string) => void;
}

interface ChangeFile {
  path: string;
  status: string;
  added: number | null;
  deleted: number | null;
}

/** 目录后缀拆分(名称+所在目录,与文件面板同构) */
function splitPath(p: string): { base: string; dir: string } {
  const norm = p.replaceAll('\\', '/');
  const base = norm.split('/').pop() ?? norm;
  return { base, dir: norm.slice(0, norm.length - base.length) };
}

export function DiffTab({ conn, sessionId, params, onOpenFile }: DiffTabProps): JSX.Element {
  const autoPath = params.path;
  // G14.109 LegacyDiff 退役:diff 标签统一 ChangesView,params.path 自动展开对应项
  // (write 时刻快照语义由 git 当前变动视图替代——点 write 行即定位工作区变动)
  const [branch, setBranch] = useState('');
  const [files, setFiles] = useState<ChangeFile[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /** G14.120 单开 accordion:同一时刻至多展开一个文件的 diff(开新即合旧),纵向滚动交外层 */
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, { oldContent?: string; newContent: string; truncated: boolean; deleted: boolean }>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** 列表里是否含 params.path(含 → 自动展开该项;不含且 callId 在场 → 旧单文件视图) */
  const [autoPathInList, setAutoPathInList] = useState<boolean | null>(null);

  const refresh = useCallback((): void => {
    (conn.sessionChanges?.(sessionId) ?? Promise.resolve({ branch: '', files: [] })).then(
      (r) => {
        setBranch(r.branch);
        setFiles(r.files);
        setLoadErr(null);
        if (autoPath !== undefined) setAutoPathInList(r.files.some((f) => f.path === autoPath));
      },
      (err: unknown) => setLoadErr(err instanceof Error ? err.message : String(err)),
    );
  }, [conn, sessionId, autoPath]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const fetchContent = useCallback((p: string): void => {
    if (loadingPath !== null || contents[p] !== undefined) return;
    setLoadingPath(p);
    conn.sessionChangeContent(sessionId, p).then(
      (c) => {
        setContents((m) => ({ ...m, [p]: c }));
        setLoadingPath(null);
      },
      () => setLoadingPath(null),
    );
  }, [conn, sessionId, contents, loadingPath]);

  useEffect(() => {
    if (autoPathInList !== true || autoPath === undefined) return;
    setOpenPath(autoPath); // 主对话 write 点击 → 自动展开对应项(单开:合掉他项)
    fetchContent(autoPath); // 展开即拉内容(否则 loading 悬挂)
  }, [autoPathInList, autoPath, fetchContent]);

  const toggle = (p: string): void => {
    setOpenPath((cur) => {
      const next = cur === p ? null : p;
      if (next !== null) fetchContent(next);
      return next;
    });
  };

  const runGit = (kind: 'commit' | 'push'): void => {
    setBusy(kind);
    setResult(null);
    const req = kind === 'commit' ? conn.commitChanges(sessionId, commitMsg) : conn.pushChanges(sessionId);
    void req.then(
      () => {
        setBusy(null);
        setResult({ ok: true, text: kind === 'commit' ? t('Committed', '已提交') : t('Pushed', '已推送') });
        if (kind === 'commit') {
          setCommitMsg('');
          setCommitOpen(false);
          refresh();
        }
      },
      (err: unknown) => {
        setBusy(null);
        setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
      },
    );
  };


  return (
    <div className="sx-diff-tab sx-changes" aria-label="diff tab">
      <div className="sx-changes-bar">
        <span className="sx-changes-branch" data-tip={t('Unstaged working tree', '未暂存的工作区变动')}>
          {branch !== '' ? branch : t('Changes', '变动')}
        </span>
        <span className="sx-changes-bar-actions">
          <button type="button" className="sx-changes-act" aria-label={t('Commit', '提交')} data-tip={t('Commit', '提交')} onClick={() => setCommitOpen((v) => !v)}>
            <GitCommitVertical size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" className="sx-changes-act" aria-label={t('Push', '推送')} data-tip={t('Push', '推送')} onClick={() => runGit('push')}>
            <Upload size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" className="sx-changes-act" aria-label={t('Refresh', '刷新')} data-tip={t('Refresh', '刷新')} onClick={refresh}>
            <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </span>
      </div>
      {commitOpen && (
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
            <button type="button" className="primary" disabled={busy !== null || commitMsg.trim() === ''} onClick={() => runGit('commit')}>
              {busy === 'commit' ? t('Committing…', '提交中…') : t('Commit', '提交')}
            </button>
          </div>
        </div>
      )}
      {result !== null && (
        <div className={`sx-changes-result ${result.ok ? 'ok' : 'err'}`} role="status">
          {result.text}
        </div>
      )}
      {loadErr !== null && <div className="sx-changes-result err">{loadErr}</div>}
      {files.length === 0 && loadErr === null && (
        <div className="sx-changes-empty">{t('No uncommitted changes', '没有未提交的变动')}</div>
      )}
      <div className="sx-changes-list">
        {files.map((f) => {
          const { base, dir } = splitPath(f.path);
          const open = openPath === f.path;
          const c = contents[f.path];
          return (
            /* G14.104 整行点击展开(文件名除外=开标签);展开钮移最右;无边框 */
            <div key={f.path} className={`sx-change${open ? ' open' : ''}`}>
              <div
                className="sx-change-row"
                role="button"
                tabIndex={-1}
                aria-expanded={open}
                onClick={() => toggle(f.path)}
              >
                <FileIcon path={f.path} />
                <button
                  type="button"
                  className="sx-change-name"
                  data-tip={t('Open file tab', '打开文件标签')}
                  onClick={(e) => {
                    e.stopPropagation(); // 文件名=开 file 标签,不触发行展开
                    onOpenFile?.(f.path);
                  }}
                >
                  {base}
                </button>
                <span className="sx-change-dir">{dir}</span>
                <span className="sx-change-stat">
                  {f.added === null ? (
                    <span className="sx-change-new">{t('new', '新建')}</span>
                  ) : (
                    <>
                      <span className="sx-change-add">{`+${f.added}`}</span>
                      <span className="sx-change-del">{`-${f.deleted}`}</span>
                    </>
                  )}
                </span>
                <span className="sx-change-toggle" aria-hidden="true">
                  {open ? <ChevronUp size={13} strokeWidth={1.75} /> : <ChevronDown size={13} strokeWidth={1.75} />}
                </span>
              </div>
              {open && (
                <div className="sx-change-body">
                  {loadingPath === f.path || c === undefined ? (
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
    </div>
  );
}
