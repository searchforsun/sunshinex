import { useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';

/** 分支切换单点(2026-11-09 用户裁定;2026-11-10 改宗「每次切换都弹确认,说明代价」):
 *  选中分支(切换/新建)即拉代价面(branchDiffStat:numstat 汇总+未提交改动数)弹确认框——
 *  干净树=「切换到 <b>:工作区 N 个文件将被更新(+X −Y)」,取消/切换双钮;
 *  有未提交改动=提示先处理,取消/提交并切换(全部提交后切换,gitCommitCheckout);
 *  代价面拉取失败仍确认(文案不示数,不静默切换)。其他失败经 onError 回显 */
export function useBranchSwitch(opts: {
  conn: {
    gitCheckout(root: string, branch: string, create?: boolean): Promise<void>;
    gitCommitCheckout?(root: string, branch: string, create?: boolean): Promise<void>;
    branchDiffStat?(root: string, branch: string): Promise<{ files: number; added: number; deleted: number; dirty: number; missing: boolean }>;
  };
  root: string;
  onSwitched: () => void;
  onError: (msg: string) => void;
}): { switchTo: (branch: string, create?: boolean) => void; dialog: JSX.Element | null } {
  const { conn, root, onSwitched, onError } = opts;
  const [pending, setPending] = useState<{ branch: string; create: boolean; stat: { files: number; added: number; deleted: number; dirty: number; missing: boolean } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const switchTo = (branch: string, create = false): void => {
    // 每次都确认:先弹(无数字),代价面异步到齐即补——选分支到弹窗零延迟,数字慢于首帧可接受
    setPending({ branch, create, stat: null });
    conn.branchDiffStat?.(root, branch).then(
      (stat) => setPending((p) => (p !== null && p.branch === branch ? { ...p, stat } : p)),
      () => setPending((p) => (p !== null && p.branch === branch ? { ...p, stat: { files: 0, added: 0, deleted: 0, dirty: 0, missing: true } } : p)), // 拉不到=不示数仍确认
    );
  };
  const run = (dirty: boolean): void => {
    if (pending === null) return;
    const op = dirty && typeof conn.gitCommitCheckout === 'function'
      ? conn.gitCommitCheckout(root, pending.branch, pending.create)
      : conn.gitCheckout(root, pending.branch, pending.create);
    setBusy(true);
    op.then(onSwitched, (err: unknown) => onError(msgOf(err))).finally(() => {
      setBusy(false);
      setPending(null);
    });
  };
  const dirty = (pending?.stat?.dirty ?? 0) > 0;
  const hasStat = pending !== null && pending.stat !== null && !pending.stat.missing;
  const dialog =
    pending === null
      ? null
      : createPortal(
          <div className="modal-overlay" onClick={() => !busy && setPending(null)}>
            <div className="modal-body sx-dirty-dialog" role="dialog" aria-label={t('Switch branch', '切换分支')} onClick={(e) => e.stopPropagation()}>
              <p className="sx-dirty-target">
                {pending.create ? t('Create and switch to', '新建并切换到') : t('Switch to', '切换到')} <b>{pending.branch}</b>
              </p>
              <p className="sx-dirty-text">
                {hasStat
                  ? dirty
                    ? t('You have uncommitted changes. Commit them first or cancel and handle them yourself.', '有未提交的改动：切换会提交它们或被阻断。可先提交，或取消后自行处理')
                    : t(`The workspace will update ${pending.stat!.files} files (+${pending.stat!.added} −${pending.stat!.deleted}).`, `工作区 ${pending.stat!.files} 个文件将被更新（+${pending.stat!.added} −${pending.stat!.deleted}）`)
                  : t('Uncommitted changes may block the switch; committed history is unaffected.', '未提交的改动可能阻断切换；已提交历史不受影响')}
              </p>
              <div className="sx-dirty-actions">
                <button type="button" disabled={busy} onClick={() => setPending(null)}>
                  {t('Cancel', '取消')}
                </button>
                {dirty && typeof conn.gitCommitCheckout === 'function' ? (
                  <button type="button" className="primary" disabled={busy} onClick={() => run(true)}>
                    {busy ? t('Committing…', '提交中…') : t('Commit and switch', '提交并切换')}
                  </button>
                ) : (
                  <button type="button" className="primary" disabled={busy} onClick={() => run(false)}>
                    {busy ? t('Switching…', '切换中…') : t('Switch', '切换')}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        );
  return { switchTo, dialog };
}
