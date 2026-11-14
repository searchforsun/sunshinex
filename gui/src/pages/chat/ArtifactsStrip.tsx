import { useEffect, useState } from 'react';
import { FileIcon } from '../../file-icon';
import { OpenSplit } from './OpenSplit';
import { artifactKindLabel, type ArtifactFile } from '../../artifacts';
import { t } from '../../i18n';
import type { Connection } from '../../connection';

const FOLD_AT = 8;
/** 缩略图只认位图族(svg 走 FileIcon 字形——daemon 图片分支 mime 面不保证 svg) */
const THUMB_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/** 轮末产物卡区(2026-11-12 spec §4):助手正文之后、改动条之前;数据=runmeta.artifacts 只读投影。
 *  网格 auto-fit minmax(360px,1fr)——单卡整行/多卡宽处两列/窄处单列(auto-fit 折叠空轨道);
 *  >8 张折叠为前两行+「展开全部」(复用改动条折叠交互模式) */
export function ArtifactsStrip({ artifacts, conn, sessionId, root, onOpenFile, onOpError, onOpenArtifacts }: {
  artifacts: ReadonlyArray<ArtifactFile>;
  conn: Connection;
  sessionId: string;
  root?: string;
  onOpenFile?: (p: string) => void;
  onOpError?: (err: unknown) => void;
  onOpenArtifacts?: () => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    for (const a of artifacts) {
      const ext = a.path.split('.').pop()?.toLowerCase() ?? '';
      if (!THUMB_EXTS.has(ext) || thumbs[a.path] !== undefined) continue;
      const load = sessionId === '' ? conn.appFile(root ?? '', a.path) : conn.readFile(sessionId, a.path);
      load
        .then((f) => {
          if (alive && f.type === 'image' && typeof f.mime === 'string' && typeof f.data === 'string') {
            setThumbs((prev) => ({ ...prev, [a.path]: `data:${f.mime};base64,${f.data}` }));
          }
        }, () => {})
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [artifacts, conn, sessionId, root]); // thumbs 故意不入 deps:回填不重发请求

  const openWith = (p: string, id: string): void => {
    void conn.openInEditor(p, id, root).catch((err: unknown) => onOpError?.(err));
  };

  const visible = open ? artifacts : artifacts.slice(0, FOLD_AT);
  return (
    <div className="sx-artifacts">
      <div className="sx-artifacts-head">
        <span>{t('Artifacts this turn', '本轮产物')} ({artifacts.length})</span>
        {onOpenArtifacts !== undefined && (
          <button type="button" className="sx-artifacts-link" onClick={onOpenArtifacts}>
            {t('All artifacts →', '全部产物 →')}
          </button>
        )}
        {artifacts.length > FOLD_AT && (
          <button type="button" className="sx-artifacts-fold" onClick={() => setOpen((v) => !v)}>
            {open ? t('Collapse', '收起') : t('Show all', '展开全部')}
          </button>
        )}
      </div>
      <div className="sx-artifacts-grid">
        {visible.map((a) => {
          const name = a.path.split('/').pop() ?? a.path;
          const dir = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : '';
          const label = artifactKindLabel(a.path);
          const thumb = thumbs[a.path];
          return (
            <div key={a.path} className="sx-artifacts-card">
              {thumb !== undefined ? (
                <img className="sx-artifacts-thumb" src={thumb} alt="" loading="lazy" decoding="async" />
              ) : (
                <span className="sx-artifacts-tile">
                  <FileIcon path={a.path} size={20} />
                </span>
              )}
              <span className="sx-artifacts-main">
                <span className="sx-artifacts-name" title={a.path}>{name}</span>
                {label !== undefined && <span className="sx-artifacts-kind">{label}</span>}
                {dir !== '' && <span className="sx-artifacts-dir">{dir}</span>}
              </span>
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
    </div>
  );
}
