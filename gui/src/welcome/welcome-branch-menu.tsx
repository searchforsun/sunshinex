import { t } from '../i18n';

/** 欢迎页分支弹层清单（D62 批D 自 WelcomeComposer 外提——行为零变化）：当前项 active 高亮，选中派发
 *  经 onPick（弹层关闭归调用方）。 */
export function WelcomeBranchMenu({
  gitBr,
  onPick,
}: {
  gitBr: { current: string; branches: string[] };
  onPick: (branch: string) => void;
}): JSX.Element {
  return (
    <div className="sx-menu-pop pill-pop branch-pop" role="menu" aria-label={t('Branch', '分支')}>
      {gitBr.branches.map((b) => (
        <button
          key={b}
          type="button"
          data-tip={b}
          role="menuitem"
          className={`sx-menuitem${b === gitBr.current ? ' active' : ''}`}
          onClick={() => onPick(b)}
        >
          {b}
        </button>
      ))}
    </div>
  );
}
