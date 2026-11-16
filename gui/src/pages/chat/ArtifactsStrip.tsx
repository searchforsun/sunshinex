import { useState } from 'react';
import { Check, Copy, ExternalLink, Globe, Terminal } from 'lucide-react';
import { FileIcon } from '../../file-icon';
import { OpenSplit } from './OpenSplit';
import { artifactKey, artifactKindLabel, artifactTitleOf, type Artifact } from '../../artifacts';
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
  /** command 类主钮:打开终端页签并写入声明命令(2026-11-14 用户裁定「打开终端复制到其中」) */
  onRunInTerminal?: (command: string) => void;
  onOpError?: (err: unknown) => void;
}

/** 单产物卡(2026-11-14 kind 化三分支;同轮样式裁定:第一行展示原始名称(文件名/网址/命令全称),
 *  第二行 desc 限长省略不换行;动作钮统一「打开 ▾」胶囊格式——两侧收窄/适当增高/弧度不变;
 *  示例图片不用缩略图,统一 FileIcon 图标(用户裁定,弧度一致)。
 *  variant(2026-11-16 用户裁定):strip=正文卡零 hover(名称/desc 不挂原生 title,整体性优先);
 *  library=侧栏产物页签卡 hover 显完整 desc/name 全文(窄栏截断时的补读路径) */
export function ArtifactCardView({ a, conn, root, actions, variant = 'strip' }: {
  a: Artifact;
  conn: Connection;
  root?: string;
  actions: ArtifactCardActions;
  variant?: 'strip' | 'library';
}): JSX.Element {
  const { status, copy } = useCopyFeedback();
  const name = artifactTitleOf(a);
  const label = a.desc !== undefined && a.desc !== '' ? a.desc : artifactKindLabel(a);
  const nameTip = variant === 'library' ? (a.kind === 'file' ? a.path : a.kind === 'url' ? a.url : a.command) : undefined;
  const descTip = variant === 'library' && a.desc !== undefined && a.desc !== '' ? a.desc : undefined;
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
        ariaLabel={`${t('Open in terminal', '终端打开')} ${name}`}
        onOpenDefault={() => {
          // 主钮=打开终端页签并自动写入声明命令(seedCmd 不带回车,用户过目后回车);未接线时回落复制
          if (actions.onRunInTerminal !== undefined) actions.onRunInTerminal(a.command);
          else copy(a.command);
        }}
        items={[
          {
            id: 'copy',
            label: t('Copy command', '复制命令'),
            // 复制回显=前面的复制图标原地变 √(2026-11-15 用户裁定;非行尾尾标),留 COPY_RESET_MS 再自动关
            icon: status === 'ok' ? <Check size={14} strokeWidth={2.25} /> : <Copy size={14} strokeWidth={1.75} />,
            keepOpen: true,
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
        <span className="sx-artifacts-name" title={nameTip}>
          {name}
        </span>
        <span className="sx-artifacts-kind" title={descTip}>{label}</span>
      </span>
      {actionRow}
    </div>
  );
}

/** 轮末产物卡区(2026-11-12 spec §4;2026-11-14 kind 化):助手正文之后、改动条之前;数据=
 *  runmeta.artifacts 只读投影。无容器框(对标 codex 简洁),网格 auto-fit minmax(min(360px,1fr))
 *  行距 16px——单卡整行/多卡宽处两列/窄处单列;>8 张折叠,「展开全部」居左(hover 灰→主文字色,
 *  与「全部产物」同语言) */
export function ArtifactsStrip({ artifacts, conn, onRunInTerminal, root, onOpenFile, onOpenWeb, onOpError, onOpenArtifacts }: {
  artifacts: ReadonlyArray<Artifact>;
  conn: Connection;
  /** 会话席(缩略图链路撤除后暂无消费;保留类型位免 MessageList 串联churn) */
  sessionId?: string;
  root?: string;
  onOpenFile?: (p: string) => void;
  onOpenWeb?: (url: string) => void;
  onRunInTerminal?: (command: string) => void;
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
            key={artifactKey(a)}
            a={a}
            conn={conn}
            root={root}
            actions={{ onOpenFile, onOpenWeb, onRunInTerminal, onOpError }}
          />
        ))}
      </div>
    </div>
  );
}
