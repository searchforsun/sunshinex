import { useEffect, useRef, useState } from 'react';
import type { RestorePlan } from '../../connection';
import { t } from '../../i18n';
import { ModalShell } from '../../settings/components';

/** 回退二次确认弹窗(2026-11-05):取消 / 回退会话 / 回退会话和文件。挂 body——转录行在 content-visibility
 *  容器内,fixed 遮罩会被裁。文件清单为空或拉取失败时「和文件」置灰(没有可回退的记录) */
export function TurnConfirmDialog({ resend, loadPlan, onCancel, onConfirm }: {
  /** true=编辑重发(回退后发送编辑文本);false=回到此轮(纯回退) */
  resend: boolean;
  loadPlan: () => Promise<RestorePlan>;
  onCancel: () => void;
  onConfirm: (restoreFiles: boolean) => Promise<void>;
}): JSX.Element {
  const [files, setFiles] = useState<RestorePlan['files'] | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const loadPlanRef = useRef(loadPlan);
  useEffect(() => {
    let alive = true;
    loadPlanRef.current().then(
      (p) => {
        if (alive) setFiles(p.files);
      },
      () => {
        if (alive) setFiles([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  // Esc/遮罩点击走守卫过的 cancel（busy 中不退）——ModalShell 壳面注入即原语义（D96）
  const cancel = (): void => {
    if (!busyRef.current) onCancel();
  };
  const confirm = (restoreFiles: boolean): void => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void onConfirm(restoreFiles).finally(() => {
      busyRef.current = false;
      setBusy(false);
    });
  };
  const title = resend ? t('Rewind and resend?', '回退并重新发送?') : t('Rewind to this turn?', '回退到这一轮?');
  return (
    <ModalShell title={title} onClose={cancel} modifier="sx-turn-confirm" portal closeButton={false}>
      <div className="sx-turn-confirm-body">
        <p>
          {resend
            ? t('This message and everything after it will be removed, including sidebar content, then your edited text is sent.', '这条消息及其之后的全部内容(含侧栏)都会被移除,然后发送修改后的内容。')
            : t('This turn and everything after it will be removed, including sidebar content.', '这一轮及其之后的全部内容(含侧栏)都会被移除。')}
        </p>
        {files === null && <p className="sx-turn-confirm-note">{t('Checking file changes…', '正在检查文件改动…')}</p>}
        {files !== null && files.length === 0 && <p className="sx-turn-confirm-note">{t('No recorded file changes to rewind.', '没有可回退的文件改动记录。')}</p>}
        {files !== null && files.length > 0 && (
          <>
            <p className="sx-turn-confirm-note">{t(`Rewinding files affects ${files.length}:`, `回退文件将影响 ${files.length} 个文件:`)}</p>
            <ul className="sx-turn-confirm-files">
              {files.map((f) => (
                <li key={f.path}>
                  <span>{f.path}</span>
                  {f.deleted && <span className="sx-turn-confirm-tag">{t('will be deleted', '将删除')}</span>}
                </li>
              ))}
            </ul>
            <p className="sx-turn-confirm-note">{t('Only edits made by file tools are tracked; changes from shell commands are not rewound.', '只记录文件工具的改动,命令行产生的改动不会回退。')}</p>
          </>
        )}
      </div>
      <div className="sx-turn-confirm-actions">
        <button type="button" disabled={busy} onClick={cancel}>{t('Cancel', '取消')}</button>
        {/* 2026-11-06 用户裁定:确认/继续钮=反色实心(.primary),取消=同色系 ghost */}
        <button type="button" className="primary" disabled={busy} onClick={() => confirm(false)}>{t('Rewind session', '回退会话')}</button>
        <button type="button" className="primary" disabled={busy || files === null || files.length === 0} onClick={() => confirm(true)}>{t('Rewind session and files', '回退会话和文件')}</button>
      </div>
    </ModalShell>
  );
}
