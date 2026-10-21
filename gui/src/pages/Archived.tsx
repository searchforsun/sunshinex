import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, ArrowLeft, Trash2 } from 'lucide-react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { Connection } from '../connection';

type ArchivedRow = { id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number };

export function ArchivedPage({ conn, onOpen, onClose }: {
  conn: Connection;
  onOpen: (root: string, journalId: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [rows, setRows] = useState<ArchivedRow[] | null>(null);
  const [confirmingId, setConfirmingId] = useState('');
  // 行级操作失败最小可见面(2026-10-21 终审 F4):最后一笔错误上屏(单行,下一笔成功操作不清——
  // 列表重拉刷新面),行保持原位即操作未生效的双信号
  const [opError, setOpError] = useState('');
  useEffect(() => {
    let alive = true;
    conn.archivedSessions().then(
      (r) => { if (alive) setRows(r); },
      () => { if (alive) setRows([]); },
    );
    return () => { alive = false; };
  }, [conn]);
  const unarchive = useCallback((id: string) => {
    void conn.archiveSession(id, false).then(
      () => setRows((cur) => (cur ?? []).filter((r) => r.id !== id)),
      (err: unknown) => setOpError(errText(err)),
    );
  }, [conn]);
  const remove = useCallback((id: string) => {
    void conn.deleteSession(id).then(
      () => setRows((cur) => (cur ?? []).filter((r) => r.id !== id)),
      (err: unknown) => setOpError(errText(err)),
    );
  }, [conn]);
  return (
    <div className="sx-archived-page" role="region" aria-label={t('Archived sessions', '归档会话')}>
      <div className="sx-archived-head">
        <button type="button" className="sx-iconbtn" data-tip={t('Back', '返回')} aria-label={t('Back', '返回')} onClick={onClose}>
          <ArrowLeft size={15} strokeWidth={1.75} />
        </button>
        <h2>{t('Archived sessions', '归档会话')}</h2>
      </div>
      {opError !== '' && <p className="sx-archived-error">{t(`Operation failed: ${opError}`, `操作失败：${opError}`)}</p>}
      {rows === null ? (
        <p className="insight-empty">{t('Loading…', '加载中…')}</p>
      ) : rows.length === 0 ? (
        <p className="insight-empty">{t('No archived sessions', '暂无归档会话')}</p>
      ) : (
        <ul className="sx-archived-list">
          {rows.map((r) => (
            <li key={r.id} className="sx-archived-row" onClick={() => onOpen(r.root, r.id)}>
              <div className="sx-archived-main">
                <span className="sx-archived-title">{r.title ?? r.id}</span>
                <span className="sx-archived-slug">{r.slug}</span>
              </div>
              <div className="sx-archived-actions" onClick={(e) => e.stopPropagation()}>
                {confirmingId === r.id ? (
                  <button type="button" className="sx-archive-confirm" aria-label={`${t('Confirm delete', '确认删除')} ${r.id}`}
                    onClick={() => { setConfirmingId(''); remove(r.id); }}>
                    {t('Confirm', '确认')}
                  </button>
                ) : (
                  <>
                    <button type="button" className="sx-iconbtn" data-tip={t('Unarchive', '撤销归档')}
                      aria-label={`${t('Unarchive', '撤销归档')} ${r.id}`} onClick={() => unarchive(r.id)}>
                      <ArchiveRestore size={13} strokeWidth={1.75} />
                    </button>
                    <button type="button" className="sx-iconbtn sx-danger" data-tip={t('Delete', '删除')}
                      aria-label={`${t('Delete', '删除')} ${r.id}`} onClick={() => setConfirmingId(r.id)}>
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
