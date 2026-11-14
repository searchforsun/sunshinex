import { useCallback, useEffect, useState } from 'react';
import { FileIcon } from '../file-icon';
import { OpenSplit } from './chat/OpenSplit';
import { artifactKindLabel, type ArtifactRow } from '../artifacts';
import { t } from '../i18n';
import type { Connection } from '../connection';

/** 产物库页签(2026-11-12 spec §6):会话级聚合(GET /session/:id/artifacts,跨 run 按 path
 *  去重保留最新,含子 run);行=图标+名称+类目+来源轮+打开分体钮;点行=侧栏预览。
 *  onOpError=外部打开失败浮出(2026-11-14 终审:与轮末卡区 ArtifactsStrip 同通道,不再静默)——
 *  页签装配面(registry Package)暂无错误回传面,prop 可选缺省不接线 */
export function ArtifactsTab({ conn, sessionId, root, refreshNonce, onOpenFile, onOpError }: {
  conn: Connection;
  sessionId: string;
  root?: string;
  refreshNonce?: number;
  onOpenFile?: (p: string) => void;
  onOpError?: (err: unknown) => void;
}): JSX.Element {
  const [items, setItems] = useState<ArtifactRow[] | null>(null);
  const [error, setError] = useState('');
  // 外部打开失败浮出（与 ArtifactsStrip.openWith 同形——旧态 .catch(()=>{}) 静默吞错,终审 Minor 裁定）
  const openWith = (p: string, id: string): void => {
    void conn.openInEditor(p, id, root).catch((err: unknown) => onOpError?.(err));
  };
  const load = useCallback((): void => {
    if (sessionId === '') {
      setItems([]);
      return;
    }
    conn
      .artifacts(sessionId)
      .then((r) => {
        setItems(r.items);
        setError('');
      }, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .catch(() => {});
  }, [conn, sessionId]);
  useEffect(() => {
    load();
  }, [load, refreshNonce]);

  const empty = items !== null && items.length === 0;
  return (
    <div className="sx-artifacts-page">
      {error !== '' && <div className="sx-artifacts-empty">{error}</div>}
      {error === '' && items === null && <div className="sx-artifacts-empty">{t('Loading…', '加载中…')}</div>}
      {empty && <div className="sx-artifacts-empty">{t('No artifacts yet — deliverables the assistant produces (docs, images, sheets) land here.', '暂无产物——助手产出的文档/图片/表格等交付物会出现在这里。')}</div>}
      {items !== null && items.length > 0 && (
        <div className="sx-artifacts-list">
          {items.map((a) => {
            const name = a.path.split('/').pop() ?? a.path;
            const dir = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : '';
            const label = artifactKindLabel(a.path);
            return (
              <div key={`${a.path}:${a.runSeq}`} className="sx-artifacts-row">
                <FileIcon path={a.path} size={16} />
                <span
                  className="sx-artifacts-rowname"
                  title={a.path}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenFile?.(a.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenFile?.(a.path);
                    }
                  }}
                >
                  {name}
                </span>
                {label !== undefined && <span className="sx-artifacts-kind">{label}</span>}
                <span className="sx-artifacts-rowdir">{dir}</span>
                <span className="sx-artifacts-rowrun">#{a.runSeq}</span>
                <OpenSplit
                  conn={conn}
                  onOpError={onOpError}
                  ariaLabel={`${t('Open', '打开')} ${name}`}
                  onOpenDefault={() => onOpenFile?.(a.path)}
                  onOpenWith={(id) => openWith(a.path, id)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
