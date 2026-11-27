/**
 * 「新建群组」弹窗（2026-11-26 群组规格 §6.4）：SUNX 组头入口；名称 1–60 字符、重名 409。
 * 门户到 body；表单结构复用 NewSunxDialog/DirPicker（modal-body sx-sunx-dialog + dirpicker-head +
 * sx-sunx-field + dirpicker-foot），不再自建群名输入框/按钮样式。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessagesSquare } from 'lucide-react';
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
    // 点外不关（与新建 Sunx 同口径：编辑性弹窗误触空白不丢表单；关闭走 ×/取消/Esc）
    <div className="modal-overlay">
      <div className="modal-body rename-dialog" role="dialog" aria-label={t('New group', '新建群组')}>
        <header className="dirpicker-head">
          <MessagesSquare size={24} strokeWidth={1.75} className="sx-sunx-dialog-mark" aria-hidden="true" />
          <span>{t('New group', '新建群组')}</span>
          <button type="button" aria-label="close group dialog" disabled={busy} onClick={onClose}>
            ✕
          </button>
        </header>
        <label className="sx-sunx-field">
          <span>{t('Name', '名称')}</span>
          <input
            ref={inputRef}
            aria-label={t('Group name', '群组名称')}
            value={name}
            maxLength={60}
            placeholder={t('Group name (1-60 chars)', '群组名称（1-60 字符）')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
        </label>
        {error !== '' && <p className="dirpicker-error" role="alert">{error}</p>}
        <footer className="dirpicker-foot">
          <button type="button" disabled={busy} onClick={onClose}>{t('Cancel', '取消')}</button>
          <button
            type="button"
            className="primary"
            disabled={busy || name.trim() === '' || conn.createSunxGroup === undefined}
            onClick={() => { void submit(); }}
          >
            {busy ? t('Creating…', '创建中…') : t('Create', '创建')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
