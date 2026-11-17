import { useCallback, useEffect, useState } from 'react';
import { ArtifactCardView } from './chat/ArtifactsStrip';
import { artifactKey, type ArtifactRow } from '../artifacts';
import { t } from '../i18n';
import type { Connection } from '../connection';

/** 产物库页签(2026-11-12 spec §6;2026-11-14 kind 化):会话级聚合(GET /session/:id/artifacts,
 *  跨 run 按 artifactKey 去重保留最新,含子 run);行卡复用轮末 ArtifactCardView 三分支
 *  (file=侧栏预览+外部菜单/url=右栏 Web 页签+系统浏览器/command=复制);点行名=file 侧栏预览。
 *  onOpError=外部打开失败浮出——页签装配面(registry Package)暂无错误回传面,prop 可选缺省不接线 */
export function ArtifactsTab({ conn, sessionId, root, refreshNonce, onOpenFile, onOpenWeb, onRunInTerminal, onOpError }: {
  conn: Connection;
  sessionId: string;
  root?: string;
  refreshNonce?: number;
  onOpenFile?: (p: string) => void;
  onOpenWeb?: (url: string) => void;
  onRunInTerminal?: (command: string) => void;
  onOpError?: (err: unknown) => void;
}): JSX.Element {
  const [items, setItems] = useState<ArtifactRow[] | null>(null);
  const [error, setError] = useState('');
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
      // 错误已在 then 第二参落态;尾随 catch 仅防 setError/then 链本身抛错外溢
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
      {/* 空态与计划页/看板页同语言(2026-11-16 用户实测「暂无产物和其他不一样」):board-empty-state
          标题+提示、整页居中——不再左上一行灰字 */}
      {empty && (
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">{t('No artifacts yet', '暂无产物')}</p>
          <p className="board-empty-hint">{t('Documents, images, sheets, links, and launch commands the assistant produces will land here.', '助手产出的文档、图片、表格、网址、启动命令等会出现在这里。')}</p>
        </div>
      )}
      {items !== null && items.length > 0 && (
        <div className="sx-artifacts-grid">
          {items.map((a) => (
            <ArtifactCardView
              key={`${artifactKey(a)}:${a.runSeq}`}
              a={a}
              conn={conn}
              root={root}
              variant="library"
              actions={{
                onOpenFile,
                onOpenWeb,
                onRunInTerminal,
                onOpError,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
