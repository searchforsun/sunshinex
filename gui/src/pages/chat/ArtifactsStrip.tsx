import { useEffect, useState } from 'react';
import { ExternalLink, Globe, Terminal } from 'lucide-react';
import { FileIcon } from '../../file-icon';
import { OpenSplit } from './OpenSplit';
import { artifactKindLabel, artifactTitleOf, type Artifact } from '../../artifacts';
import { t } from '../../i18n';
import { openExternalUrl } from '../../ui-util';
import { useCopyFeedback } from '../../use-copy-feedback';
import type { Connection } from '../../connection';

const FOLD_AT = 8;
/** 缩略图只认位图族(svg 走 FileIcon 字形——daemon 图片分支 mime 面不保证 svg) */
const THUMB_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

export interface ArtifactCardActions {
  /** file 类主钮:侧栏预览 */
  onOpenFile?: (p: string) => void;
  /** url 类主钮:右栏 Web 页签内嵌打开 */
  onOpenWeb?: (url: string) => void;
  onOpError?: (err: unknown) => void;
}

/** 单产物卡(2026-11-14 kind 化三分支):file=FileIcon/缩略图 tile+侧栏预览+「打开 ▾」外部菜单;
 *  url=Globe tile+「网站」标签+主钮右栏 Web 页签+副钮系统浏览器;command=Terminal tile+主钮复制。
 *  第一行=声明 title 优先(缺省推导),第二行=desc 优先(缺省类目标签) */
export function ArtifactCardView({ a, conn, root, thumb, actions }: {
  a: Artifact;
  conn: Connection;
  root?: string;
  /** 预取的位图缩略图(strip 面 lazy 预热;产物库行不传) */
  thumb?: string;
  actions: ArtifactCardActions;
}): JSX.Element {
  const { status, copy } = useCopyFeedback();
  const name = artifactTitleOf(a);
  const label = a.desc !== undefined && a.desc !== '' ? a.desc : artifactKindLabel(a);
  const openExternal = (p: string, id: string): void => {
    void conn.openInEditor(p, id, root).catch((err: unknown) => actions.onOpError?.(err));
  };

  let tile: JSX.Element;
  let actionRow: JSX.Element;
  if (a.kind === 'url') {
    tile = (
      <span className="sx-artifacts-tile">
        <Globe size={20} strokeWidth={1.75} aria-hidden="true" />
      </span>
    );
    actionRow = (
      <span className="sx-artifacts-open">
        <button
          type="button"
          className="sx-artifacts-openbtn"
          aria-label={`${t('Open', '打开')} ${name}`}
          onClick={() => actions.onOpenWeb?.(a.url)}
        >
          {t('Open', '打开')}
        </button>
        <button
          type="button"
          className="sx-artifacts-caret"
          aria-label={t('Open in system browser', '系统浏览器打开')}
          data-tip={t('Open in system browser', '系统浏览器打开')}
          onClick={() => openExternalUrl(a.url)}
        >
          <ExternalLink size={14} strokeWidth={1.75} />
        </button>
      </span>
    );
  } else if (a.kind === 'command') {
    tile = (
      <span className="sx-artifacts-tile">
        <Terminal size={20} strokeWidth={1.75} aria-hidden="true" />
      </span>
    );
    actionRow = (
      <span className="sx-artifacts-open">
        <button
          type="button"
          className="sx-artifacts-openbtn"
          aria-label={`${t('Copy command', '复制命令')} ${name}`}
          data-tip={status === 'ok' ? t('Copied', '已复制') : t('Copy command', '复制命令')}
          onClick={() => copy(a.command)}
        >
          {status === 'ok' ? t('Copied', '已复制') : t('Copy', '复制')}
        </button>
      </span>
    );
  } else {
    tile =
      thumb !== undefined ? (
        <img className="sx-artifacts-thumb" src={thumb} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="sx-artifacts-tile">
          <FileIcon path={a.path} size={20} />
        </span>
      );
    actionRow = (
      <OpenSplit
        conn={conn}
        onOpError={actions.onOpError}
        ariaLabel={`${t('Open', '打开')} ${name}`}
        onOpenDefault={() => actions.onOpenFile?.(a.path)}
        onOpenWith={(id) => openExternal(a.path, id)}
      />
    );
  }

  return (
    <div className="sx-artifacts-card">
      {tile}
      <span className="sx-artifacts-main">
        <span className="sx-artifacts-name" title={a.kind === 'file' ? a.path : a.kind === 'url' ? a.url : a.command}>
          {name}
        </span>
        <span className="sx-artifacts-kind">{label}</span>
      </span>
      {actionRow}
    </div>
  );
}

/** 轮末产物卡区(2026-11-12 spec §4;2026-11-14 kind 化):助手正文之后、改动条之前;数据=
 *  runmeta.artifacts 只读投影。无容器框(对标 codex 简洁),网格 auto-fit minmax(min(360px,1fr))
 *  行距 16px——单卡整行/多卡宽处两列/窄处单列;>8 张折叠(前两行+展开全部) */
export function ArtifactsStrip({ artifacts, conn, sessionId, root, onOpenFile, onOpenWeb, onOpError, onOpenArtifacts }: {
  artifacts: ReadonlyArray<Artifact>;
  conn: Connection;
  sessionId: string;
  root?: string;
  onOpenFile?: (p: string) => void;
  onOpenWeb?: (url: string) => void;
  onOpError?: (err: unknown) => void;
  onOpenArtifacts?: () => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [localThumbs, setLocalThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    for (const a of artifacts) {
      if (a.kind !== 'file') continue;
      const ext = a.path.split('.').pop()?.toLowerCase() ?? '';
      if (!THUMB_EXTS.has(ext)) continue;
      const known = localThumbs[a.path];
      if (known !== undefined) continue;
      const load = sessionId === '' ? conn.appFile(root ?? '', a.path) : conn.readFile(sessionId, a.path);
      load
        .then((f) => {
          if (alive && f.type === 'image' && typeof f.mime === 'string' && typeof f.data === 'string') {
            setLocalThumbs((prev) => ({ ...prev, [a.path]: `data:${f.mime};base64,${f.data}` }));
          }
        }, () => {})
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [artifacts, conn, sessionId, root]); // localThumbs 故意不入 deps:回填不重发请求

  const visible = open ? artifacts : artifacts.slice(0, FOLD_AT);
  const thumbOf = (a: Artifact): string | undefined => (a.kind === 'file' ? localThumbs[a.path] : undefined);
  return (
    <div className="sx-artifacts">
      <div className="sx-artifacts-head">
        {onOpenArtifacts !== undefined && (
          <button type="button" className="sx-artifacts-link" onClick={onOpenArtifacts}>
            {t('All artifacts', '全部产物')}
          </button>
        )}
        {artifacts.length > FOLD_AT && (
          <button type="button" className="sx-artifacts-fold" onClick={() => setOpen((v) => !v)}>
            {open ? t('Collapse', '收起') : t('Show all', '展开全部')}
          </button>
        )}
      </div>
      <div className="sx-artifacts-grid">
        {visible.map((a) => (
          <ArtifactCardView
            key={a.kind === 'file' ? a.path : a.kind === 'url' ? a.url : a.command}
            a={a}
            conn={conn}
            root={root}
            thumb={thumbOf(a)}
            actions={{ onOpenFile, onOpenWeb, onOpError }}
          />
        ))}
      </div>
    </div>
  );
}
