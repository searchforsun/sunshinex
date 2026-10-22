import { useState } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, GitFork } from 'lucide-react';
import { t } from '../../i18n';
import { fmtTokens, pathBasename } from '../../ui-util';
import { shortClockMs } from '../../ui-util';
import { useCopyFeedback } from '../../use-copy-feedback';
import type { ChatEntry } from '../../chat-reducer';
import { FileIcon } from '../../file-icon';

/** run 尾部操作条与变更汇总（D32 批C-1 拆分自 Chat.tsx）：Worked for 时长/复制/分叉钮与
 *  本轮改动文件变更条——纯渲染件，props 注入。行为零变化（Chat.test 为锚）。
 */

/** run 尾部操作条(G11 §6,对标 Codex 回复工具行):复制该条 md/fork 新会话 + 封段统计
 *  (steps·tokens·HH:mm,数据缺省逐项省略)。常显淡灰(截图裁定),钮 hover 提亮 */
export function RunFooter({ text, run, onFork }: { text: string; run: ChatEntry | undefined; onFork?: () => void }): JSX.Element {
  const { status, copy } = useCopyFeedback();
  const time = run?.endedTs !== undefined ? shortClockMs(run.endedTs) : undefined;
  return (
    <div className="run-footer">
      <TipButton
        tip={status === 'ok' ? t('Copied', '已复制') : t('Copy', '复制')}
        label="copy reply"
        icon={status === 'ok' ? <Check size={12} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
        onClick={() => copy(text)}
      />
      {onFork !== undefined && <TipButton tip={t('Fork', '分叉')} label="fork session" icon={<GitFork size={12} strokeWidth={1.75} aria-hidden="true" />} onClick={onFork} />}
      {(run?.steps !== undefined || run?.tokens !== undefined) && (
        <span className="run-stats">
          {run?.steps !== undefined && <span>{run.steps === 1 ? t('1 step', '1 步') : `${run.steps} steps`}</span>}
          {run?.tokens !== undefined && <span>{fmtTokens(run.tokens)}</span>}
          {time !== undefined && <span>{time}</span>}
        </span>
      )}
    </div>
  );
}

/** G14.100 轮尾变动汇总条(对标 Codex):「N 个文件已更改 +X -Y」折叠条+右侧撤销(整轮);
 *  展开逐文件(图标+名称+目录+±+行尾撤销);点击文件名 → 侧栏 diff 标签自动展开对应项;
 *  撤销 = restore 回 HEAD(本轮新建 → 删除),已撤销项本地隐藏 */
export function RunChangesBar({
  changes,
  onOpenDiff,
  onRestore,
}: {
  changes: ReadonlyArray<{ path: string; status: string; added: number | null; deleted: number | null; newLines?: number }>;
  onOpenDiff?: (path: string) => void;
  onRestore?: (path: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set());
  const visible = changes.filter((c) => !restored.has(c.path));
  const add = visible.reduce((n, c) => n + (c.added ?? (c as { newLines?: number }).newLines ?? 0), 0);
  const del = visible.reduce((n, c) => n + (c.deleted ?? 0), 0);
  const restore = (path: string): void => {
    onRestore?.(path);
    setRestored((s) => new Set(s).add(path));
  };
  return (
    <div className="run-changes" aria-label={t('run changes', '本轮改动')}>
      <div className="run-changes-head">
        <button type="button" className="run-changes-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />}
          <span>
            {t(`${visible.length} files changed`, `${visible.length} 个文件已更改`)}
          </span>
          <span className="run-changes-stat">
            {add > 0 && <span className="sx-change-add">{`+${add}`}</span>}
            {del > 0 && <span className="sx-change-del">{`-${del}`}</span>}
          </span>
        </button>
        <button
          type="button"
          className="run-changes-undo"
          data-tip={t('Revert all changes in this turn', '撤销本轮全部变动')}
          onClick={() => visible.forEach((c) => restore(c.path))}
        >
          {t('Undo', '撤销')}
        </button>
      </div>
      {open && (
        <div className="run-changes-list">
          {visible.map((c) => {
            const norm = c.path.replaceAll('\\', '/');
            const base = pathBasename(norm);
            const dir = norm.slice(0, norm.length - base.length);
            return (
              <div key={c.path} className="run-changes-row">
                <FileIcon path={c.path} />
                <button type="button" className="run-changes-name" onClick={() => onOpenDiff?.(c.path)}>
                  {base}
                </button>
                <span className="run-changes-dir">{dir}</span>
                <span className="run-changes-stat">
                  {c.added !== null && c.added > 0 && <span className="sx-change-add">{`+${c.added}`}</span>}
                  {c.deleted !== null && c.deleted > 0 && <span className="sx-change-del">{`-${c.deleted}`}</span>}
                  {c.added === null && c.newLines !== undefined && c.newLines > 0 && <span className="sx-change-add">{`+${c.newLines}`}</span>}
                </span>
                <button type="button" className="run-changes-undo-row" data-tip={t('Revert this file', '撤销此文件')} onClick={() => restore(c.path)}>
                  {t('Undo', '撤销')}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}/** 统一图标钮(G11 §8):纯图标 + data-tip Tooltip(视觉层)+ aria-label(可达性/查询锚)。
 *  不用原生 title;复制成功反馈由调用面换 icon/tip,本组件无状态 */
export function TipButton({ tip, label, icon, onClick, className }: { tip: string; label: string; icon: ReactNode; onClick?: () => void; className?: string }): JSX.Element {
  return (
    <button
      type="button"
      className={className !== undefined ? `sx-tip ${className}` : 'sx-tip'}
      aria-label={label}
      data-tip={tip}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}


