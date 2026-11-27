/**
 * 「新建群组」弹窗（2026-11-26 群组规格 §6.4）：SUNX 组头入口；名称 1–60 字符、重名 409。
 * portal 到 body；创建成功即关闭并回调（宿主重拉群列表/SUNX 行集）。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';

export interface NewGroupConn {
  createSunxGroup?(name: string): Promise<{ ok: true; group: { id: string; name: string } }>;
}

export function NewGroupDialog(props: {
  open: boolean;
  conn: NewGroupConn;
  onClose: () => void;
  onCreated: (group: { id: string; name: string }) => void;
}): JSX.Element | null {
  const { open, conn, onClose, onCreated } = props;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setBusy(false);
    setError('');
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose, open]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    const n = name.trim();
    if (n === '' || busy || conn.createSunxGroup === undefined) return;
    setBusy(true);
    setError('');
    try {
      const r = await conn.createSunxGroup(n);
      setBusy(false);
      onCreated(r.group);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal-body sx-group-name-dialog" role="dialog" aria-label={t('New group', '新建群组')} onClick={(e) => e.stopPropagation()}>
        <div className="sx-group-members-head"><span>{t('New group', '新建群组')}</span></div>
        <input
          ref={inputRef}
          className="sx-group-name-input"
          value={name}
          placeholder={t('Group name (1-60 chars)', '群组名称（1-60 字符）')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        />
        {error !== '' && <div className="sx-group-error" role="alert">{error}</div>}
        <div className="sx-group-dialog-actions">
          <button type="button" onClick={() => { if (!busy) onClose(); }}>{t('Cancel', '取消')}</button>
          <button type="button" className="primary" disabled={busy || name.trim() === '' || conn.createSunxGroup === undefined} onClick={() => { void submit(); }}>
            {busy ? t('Creating…', '创建中…') : t('Create', '创建')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
