import { createPortal } from 'react-dom';
import { t } from '../i18n';

/** D62 批E 自 WelcomeComposer 平移的三个全局 portal 对话框(2026-11-10/11 分支+隔离特性线增量):
 *  JSX 与宿主原段逐字等价,输入面全经 props 注入零闭包依赖;状态与发送编排仍宿主自持。 */

/** 发送前切换确认(全局 portal):branchDiffStat 代价面;脏树=提交信息框+±数量 */
export function WelcomeSwitchDialog({
  pending,
  msg,
  onMsg,
  busy,
  onSend,
  onClose,
}: {
  pending: { branch: string; stat: { files: number; added: number; deleted: number; dirty: number; dirtyAdded: number; dirtyDeleted: number; missing: boolean } | null };
  msg: string;
  onMsg: (v: string) => void;
  busy: boolean;
  onSend: () => void;
  onClose: () => void;
}): JSX.Element {
  const switchPending = pending;
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-body sx-dirty-dialog" role="dialog" aria-label={t('Switch and send', '切换并发送')} onClick={(e) => e.stopPropagation()}>
        <p className="sx-dirty-target">
          {t('Send after switching to', '发送后切换到')} <b>{switchPending.branch}</b>
        </p>
        <p className="sx-dirty-text">
          {switchPending.stat === null || switchPending.stat.missing
            ? t('Uncommitted changes may block the switch; committed history is unaffected.', '未提交改动可能阻断切换；已提交历史不受影响')
            : switchPending.stat.dirty > 0
              ? t(`Uncommitted changes (+${switchPending.stat.dirtyAdded} −${switchPending.stat.dirtyDeleted}) will be committed first; type a message or leave empty for the default.`, `有未提交改动（+${switchPending.stat.dirtyAdded} −${switchPending.stat.dirtyDeleted}），将先提交；可输入提交信息，留空用缺省`)
              : switchPending.stat.files === 0
                ? t('No file differences between the branches.', '目标分支与当前无文件差异')
                : t(`The workspace will update ${switchPending.stat.files} files (+${switchPending.stat.added} −${switchPending.stat.deleted}).`, `工作区 ${switchPending.stat.files} 个文件将被更新（+${switchPending.stat.added} −${switchPending.stat.deleted}）`)}
        </p>
        {switchPending.stat !== null && !switchPending.stat.missing && switchPending.stat.dirty > 0 && (
          <input
            className="sx-dirty-msg"
            aria-label={t('Commit message', '提交信息')}
            placeholder={t('Commit message (optional)', '提交信息（可留空）')}
            value={msg}
            maxLength={200}
            autoFocus
            onChange={(e) => onMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSend();
              if (e.key === 'Escape') onClose();
            }}
          />
        )}
        <div className="sx-dirty-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            {t('Cancel', '取消')}
          </button>
          <button type="button" className="primary" disabled={busy} onClick={onSend}>
            {t('Switch and send', '切换并发送')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 隔离分支被占(全局 portal):输入框空=随机新分支;重选分支=重开分支菜单 */
export function WelcomeHeldBranchDialog({
  branch,
  newBranch,
  onNewBranch,
  busy,
  onClose,
  onPickAnother,
  onCreate,
}: {
  branch: string;
  newBranch: string;
  onNewBranch: (v: string) => void;
  busy: boolean;
  onClose: () => void;
  onPickAnother: () => void;
  onCreate: (name: string) => void;
}): JSX.Element {
  const heldBranch = branch;
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-body sx-dirty-dialog" role="dialog" aria-label={t('Branch already checked out', '分支已被签出')} onClick={(e) => e.stopPropagation()}>
        <p className="sx-dirty-target">
          {t('Branch already checked out', '分支已被签出')} <b>{heldBranch === '' ? '' : heldBranch}</b>
        </p>
        <p className="sx-dirty-text">
          {t('Pick another branch, or create a new one (empty = auto name).', '请选择其他分支，或新建一个（留空自动命名）')}
        </p>
        <input
          className="sx-dirty-msg"
          aria-label={t('New branch name', '新分支名')}
          placeholder={t('New branch name (empty = auto)', '新分支名（留空自动命名）')}
          value={newBranch}
          maxLength={80}
          autoFocus
          onChange={(e) => onNewBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="sx-dirty-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            {t('Cancel', '取消')}
          </button>
          <button type="button" disabled={busy} onClick={onPickAnother}>
            {t('Pick another branch', '重选分支')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onCreate(newBranch.trim())}
          >
            {t('Create branch and isolate', '创建分支并隔离')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 全局弹窗(2026-11-10 用户裁定「弹窗是全局的」):portal 到 body——composer 祖先带定位上下文,
 *  内联 modal-overlay 的 fixed 会被困住落底部 */
export function WelcomeIsoDialog({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }): JSX.Element {
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-body sx-iso-dialog" role="dialog" aria-label={t('Isolated workspace', '隔离工作区')} onClick={(e) => e.stopPropagation()}>
        <p className="sx-dirty-target">{t('Isolated workspace (git worktree)', '隔离工作区（git worktree）')}</p>
        <p className="sx-dirty-text">
          {t('Works in a dedicated branch copy; the main workspace stays clean.', '在独立分支的副本中工作，主工作区不受影响')}
        </p>
        <div className="sx-dirty-actions">
          <button type="button" onClick={onClose}>
            {t('Cancel', '取消')}
          </button>
          <button type="button" className="primary" onClick={onConfirm}>
            {t('Turn on isolation', '开启隔离')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
