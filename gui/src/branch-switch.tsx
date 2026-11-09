import { useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';

/** 分支切换单点(2026-11-09 用户裁定):欢迎页分支弹窗与审查页分支下拉共用——切换/新建失败且为未提交改动
 *  阻断(conn 抛 code='DIRTY_TREE')时弹确认框「当前分支有未提交的代码,请先处理或提交分支改动」:
 *  取消=不动;提交并切换=提交全部未提交改动后切换(gitCommitCheckout)。其他失败经 onError 回显 */
export function useBranchSwitch(opts: {
  conn: {
    gitCheckout(root: string, branch: string, create?: boolean): Promise<void>;
    gitCommitCheckout?(root: string, branch: string, create?: boolean): Promise<void>;
  };
  root: string;
  onSwitched: () => void;
  onError: (msg: string) => void;
}): { switchTo: (branch: string, create?: boolean) => void; dialog: JSX.Element | null } {
  const { conn, root, onSwitched, onError } = opts;
  const [pending, setPending] = useState<{ branch: string; create: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const switchTo = (branch: string, create = false): void => {
    conn.gitCheckout(root, branch, create).then(onSwitched, (err: unknown) => {
      if ((err as { code?: unknown } | null)?.code === 'DIRTY_TREE' && typeof conn.gitCommitCheckout === 'function') setPending({ branch, create });
      else onError(msgOf(err));
    });
  };
  const confirm = (): void => {
    if (pending === null || typeof conn.gitCommitCheckout !== 'function') return;
    setBusy(true);
    conn
      .gitCommitCheckout(root, pending.branch, pending.create)
      .then(onSwitched, (err: unknown) => onError(msgOf(err)))
      .finally(() => {
        setBusy(false);
        setPending(null);
      });
  };
  const dialog =
    pending === null
      ? null
      : createPortal(
          <div className="modal-overlay" onClick={() => !busy && setPending(null)}>
            <div className="modal-body sx-dirty-dialog" role="dialog" aria-label={t('Uncommitted changes', '未提交的改动')} onClick={(e) => e.stopPropagation()}>
              <p className="sx-dirty-text">
                {t('The current branch has uncommitted changes. Handle or commit them first.', '当前分支有未提交的代码，请先处理或提交分支改动')}
              </p>
              <p className="sx-dirty-target">
                {t('Switch to', '切换到')} <b>{pending.branch}</b>
              </p>
              <div className="sx-dirty-actions">
                <button type="button" disabled={busy} onClick={() => setPending(null)}>
                  {t('Cancel', '取消')}
                </button>
                <button type="button" className="primary" disabled={busy} onClick={confirm}>
                  {busy ? t('Committing…', '提交中…') : t('Commit and switch', '提交并切换')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        );
  return { switchTo, dialog };
}
