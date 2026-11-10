import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';

/** 分支切换单点(2026-11-09 用户裁定;2026-11-10 改宗「每次切换都弹确认,说明代价」):
 *  选中分支(切换/新建)即拉代价面(branchDiffStat:numstat 汇总+未提交改动数/±行数)弹确认框——
 *  干净树=「切换到 <b>:工作区 N 个文件将被更新(+X −Y)」,取消/切换双钮;
 *  有未提交改动=提交信息输入框(可留空走缺省文案)+「+A −D」数量面,取消/提交并切换;
 *  代价面拉取失败仍确认(文案不示数,不静默切换)。其他失败经 onError 回显 */
export function useBranchSwitch(opts: {
  conn: {
    gitCheckout(root: string, branch: string, create?: boolean): Promise<void>;
    gitCommitCheckout?(root: string, branch: string, create?: boolean, message?: string): Promise<void>;
    branchDiffStat?(root: string, branch: string): Promise<{ files: number; added: number; deleted: number; dirty: number; dirtyAdded: number; dirtyDeleted: number; missing: boolean }>;
  };
  root: string;
  onSwitched: () => void;
  onError: (msg: string) => void;
}): { switchTo: (branch: string, create?: boolean) => void; dialog: JSX.Element | null } {
  const { conn, root, onSwitched, onError } = opts;
  const [pending, setPending] = useState<{ branch: string; create: boolean; stat: { files: number; added: number; deleted: number; dirty: number; dirtyAdded: number; dirtyDeleted: number; missing: boolean } | null } | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const msgInputRef = useRef<HTMLInputElement | null>(null);
  const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const switchTo = (branch: string, create = false): void => {
    // 每次都确认:先弹(无数字),代价面异步到齐即补——选分支到弹窗零延迟,数字慢于首帧可接受
    setMsg('');
    setPending({ branch, create, stat: null });
    conn.branchDiffStat?.(root, branch).then(
      (stat) => {
        setPending((p) => (p !== null && p.branch === branch ? { ...p, stat } : p));
        if (stat.dirty > 0) setTimeout(() => msgInputRef.current?.focus(), 50); // 脏树面:提交信息框 autoFocus
      },
      () => setPending((p) => (p !== null && p.branch === branch ? { ...p, stat: { files: 0, added: 0, deleted: 0, dirty: 0, dirtyAdded: 0, dirtyDeleted: 0, missing: true } } : p)), // 拉不到=不示数仍确认
    );
  };
  const run = (dirty: boolean): void => {
    if (pending === null) return;
    const op =
      dirty && typeof conn.gitCommitCheckout === 'function'
        ? conn.gitCommitCheckout(root, pending.branch, pending.create, msg)
        : conn.gitCheckout(root, pending.branch, pending.create);
    setBusy(true);
    op.then(onSwitched, (err: unknown) => onError(msgOf(err))).finally(() => {
      setBusy(false);
      setPending(null);
      setMsg('');
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
                    ? t(`Uncommitted changes (+${pending.stat!.dirtyAdded} −${pending.stat!.dirtyDeleted}) will be committed first; type a message or leave empty for the default.`, `有未提交改动（+${pending.stat!.dirtyAdded} −${pending.stat!.dirtyDeleted}），将先提交；可输入提交信息，留空用缺省`)
                    : t(`The workspace will update ${pending.stat!.files} files (+${pending.stat!.added} −${pending.stat!.deleted}).`, `工作区 ${pending.stat!.files} 个文件将被更新（+${pending.stat!.added} −${pending.stat!.deleted}）`)
                  : t('Uncommitted changes may block the switch; committed history is unaffected.', '未提交改动可能阻断切换；已提交历史不受影响')}
              </p>
              {dirty && (
                <input
                  ref={msgInputRef}
                  className="sx-dirty-msg"
                  aria-label={t('Commit message', '提交信息')}
                  placeholder={t('Commit message (optional)', '提交信息（可留空）')}
                  value={msg}
                  maxLength={200}
                  onChange={(e) => setMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') run(true);
                    if (e.key === 'Escape') setPending(null);
                  }}
                />
              )}
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
