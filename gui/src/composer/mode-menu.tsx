import { t } from '../i18n';
import { Eye, NotebookPen, ShieldCheck, Unlock } from 'lucide-react';

/** 会话权限模式四档（spec §3.4；TUI/serve/欢迎页/会话内 pill 全同词汇） */
export type SessionMode = 'read-only' | 'acceptEdits' | 'full-access' | 'plan';

/** pill 回显文案四态（data-tip 与 pill-label 同源；窄视口 CSS 塌缩面 sx-main-narrow 不变） */
export function sessionModeLabel(mode: SessionMode): string {
  return mode === 'plan'
    ? t('Plan mode', '计划模式')
    : mode === 'read-only'
      ? t('Read-only', '只读模式')
      : mode === 'acceptEdits'
        ? t('Workspace edits', '工作区编辑')
        : t('Full access', '完全访问');
}

type ModeMenuRow = { separator: true } | { m: SessionMode; label: string; desc: string; icon: JSX.Element; disabled?: boolean };

/** 权限菜单（spec §3.4 四项两段单点——会话内 ComposerPills 与欢迎页 WelcomeComposer 两 pill 同源，
 *  此前两份逐字复制且 plan 图标已漂移[欢迎页 ListTodo 与 pill ModeIcon 的 NotebookPen 同屏不一致]）：
 *  plan 置顶（阶段三 plan-arm 接通正式开放）+分组线+三权限档；图标+双行（名称+解释）；disabled 行置灰
 *  不可选（data-tip=即将可用）。选中派发经 onPick 回调，弹层关闭归调用方（两面关闭时机语义不同）。 */
export function ModeMenu({ mode, ariaLabel, onPick }: { mode: SessionMode; ariaLabel: string; onPick: (m: SessionMode) => void }): JSX.Element {
  const modeRows: ModeMenuRow[] = [
    { m: 'plan' as const, label: t('Plan mode', '计划模式'), desc: t('Plan first, execute on approval', '先规划，批准后执行'), icon: <NotebookPen size={15} strokeWidth={1.75} aria-hidden="true" /> },
    { separator: true },
    { m: 'read-only' as const, label: t('Read-only', '只读模式'), desc: t('Read-only analysis, no changes', '只读分析，不改文件'), icon: <Eye size={15} strokeWidth={1.75} aria-hidden="true" /> },
    { m: 'acceptEdits' as const, label: t('Workspace edits', '工作区编辑'), desc: t('Direct edits in-workspace, asks outside', '工作区内直接改，域外需确认'), icon: <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" /> },
    { m: 'full-access' as const, label: t('Full access', '完全访问'), desc: t('Fully automatic, blocks destructive commands', '全自动执行，仅拦破坏性命令'), icon: <Unlock size={15} strokeWidth={1.75} aria-hidden="true" /> },
  ];
  return (
    <div className="sx-menu-pop pill-pop mode-pop" role="menu" aria-label={ariaLabel}>
      {modeRows.map((row, idx) => (
        <div key={'separator' in row ? `sep-${idx}` : row.m} className="mode-pop-group">
          {'separator' in row ? (
            <div className="mode-pop-sep" aria-hidden="true" />
          ) : (
            <button
              type="button"
              role="menuitem"
              className={`mode-item${!row.disabled && mode === row.m ? ' active' : ''}`}
              aria-disabled={row.disabled === true ? true : undefined}
              data-tip={row.disabled === true ? t('Coming soon', '即将可用') : undefined}
              onClick={() => {
                if (row.disabled === true) return; // 阶段一 plan 置灰:不可选(阶段三 plan-arm 接通)
                onPick(row.m);
              }}
            >
              <span className="mode-item-icon">{row.icon}</span>
              <span className="mode-item-body">
                <span className="mode-item-name">{row.label}</span>
                <span className="mode-item-desc">{row.desc}</span>
              </span>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
