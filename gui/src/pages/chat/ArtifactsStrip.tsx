import { useState } from 'react';
import { Copy, ExternalLink, Globe, Terminal } from 'lucide-react';
import { FileIcon } from '../../file-icon';
import { OpenSplit } from './OpenSplit';
import { artifactKindLabel, artifactTitleOf, type Artifact } from '../../artifacts';
import { t } from '../../i18n';
import { openExternalUrl } from '../../ui-util';
import { useCopyFeedback } from '../../use-copy-feedback';
import type { Connection } from '../../connection';

const FOLD_AT = 8;

export interface ArtifactCardActions {
  /** file 类主钮:侧栏预览 */
  onOpenFile?: (p: string) => void;
  /** url 类主钮:右栏 Web 页签内嵌打开 */
  onOpenWeb?: (url: string) => void;
  onOpError?: (err: unknown) => void;
}

/** 单产物卡(2026-11-14 kind 化三分支;同轮样式裁定:第一行展示原始名称(文件名/网址/命令全称),
 *  第二行 desc 限长省略不换行;动作钮统一「打开 ▾」胶囊格式——两侧收窄/适当增高/弧度不变;
 *  示例图片不用缩略图,统一 FileIcon 图标(用户裁定,弧度一致) */
export function ArtifactCardView({ a, conn, root, actions }: {
  a: Artifact;
  conn: Connection;
  root?: string;
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
      <OpenSplit
        ariaLabel={`${t('Open', '打开')} ${name}`}
        onOpenDefault={() => actions.onOpenWeb?.(a.url)}
        items={[
          {
            id: 'browser',
            label: t('System browser', '系统浏览器'),
            icon: <ExternalLink size={14} strokeWidth={1.75} />,
            onSelect: () => openExternalUrl(a.url),
          },
        ]}
      />
    );
  } else if (a.kind === 'command') {
    tile = (
      <span className="sx-artifacts-tile">
        <Terminal size={20} strokeWidth={1.75} aria-hidden="true" />
      </span>
    );
    actionRow = (
      <OpenSplit
        ariaLabel={`${t('Copy command', '复制命令')} ${name}`}
        label={status === 'ok' ? t('Copied', '已复制') : t('Open', '打开')}
        onOpenDefault={() => copy(a.command)}
        items={[
          {
            id: 'copy',
            label: t('Copy command', '复制命令'),
            icon: <Copy size={14} strokeWidth={1.75} />,
            onSelect: () => copy(a.command),
          },
        ]}
      />
    );
  } else {
    tile = (
      <span className="sx-artifacts-tile">
        <FileIcon path={a.path} size={20} />
      </span>
    );
    actionRow = (
      <OpenSplit
        conn={conn}
        useEditors
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
 *  行距 16px——单卡整行/多卡宽处两列/窄处单列;>8 张折叠,「展开全部」居左(hover 灰→主文字色,
 *  与「全部产物」同语言) */
export function ArtifactsStrip({ artifacts, conn, root, onOpenFile, onOpenWeb, onOpError, onOpenArtifacts }: {
  artifacts: ReadonlyArray<Artifact>;
  conn: Connection;
  /** 会话席(缩略图链路撤除后暂无消费;保留类型位免 MessageList 串联churn) */
  sessionId?: string;
  root?: string;
  onOpenFile?: (p: string) => void;
  onOpenWeb?: (url: string) => void;
  onOpError?: (err: unknown) => void;
  onOpenArtifacts?: () => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);

  const visible = open ? artifacts : artifacts.slice(0, FOLD_AT);
  return (
    <div className="sx-artifacts">
      <div className="sx-artifacts-head">
        {artifacts.length > FOLD_AT && (
          <button type="button" className="sx-artifacts-fold" onClick={() => setOpen((v) => !v)}>
            {open ? t('Collapse', '收起') : t('Show all', '展开全部')}
          </button>
        )}
        {onOpenArtifacts !== undefined && (
          <button type="button" className="sx-artifacts-link" onClick={onOpenArtifacts}>
            {t('All artifacts', '全部产物')}
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
            actions={{ onOpenFile, onOpenWeb, onOpError }}
          />
        ))}
      </div>
    </div>
  );
}
