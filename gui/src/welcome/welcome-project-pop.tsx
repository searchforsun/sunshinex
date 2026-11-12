import { t } from '../i18n';
import { Folder } from 'lucide-react';
import { pathBasename } from '../ui-util';
import { FolderAddIcon } from '../sidebar/ProjectMenu';

/** D62 批E 自 WelcomeComposer 平移的项目弹层(筛选 2026-11-11 用户裁定:与分支弹层同款,仅筛不建):
 *  JSX 与宿主原段逐字等价,清单/选中/提示全经 props 注入零闭包依赖。 */
export function WelcomeProjectPop({
  rows,
  picked,
  query,
  onQuery,
  onPick,
  onBrowse,
  hint,
  projRef,
}: {
  rows: Array<{ slug: string; root?: string }>;
  picked: string;
  query: string;
  onQuery: (v: string) => void;
  onPick: (root: string) => void;
  onBrowse: () => void;
  hint: string;
  projRef: React.Ref<HTMLDivElement>;
}): JSX.Element {
  const baseName = pathBasename;
  const q = query.trim().toLowerCase();
  const projRows =
    q === ''
      ? rows
      : rows.filter((r) => {
          const nm = baseName(r.root ?? r.slug);
          const label = nm === 'default' || nm.startsWith('sunshinex-default') ? t('Default workspace', '默认工作区') : nm;
          return label.toLowerCase().includes(q) || (r.root ?? '').toLowerCase().includes(q);
        });
  return (
    <div className="proj-pop" role="menu" aria-label={t('Projects', '项目')} ref={projRef}>
      {/* 筛选行(2026-11-11 用户裁定:与分支弹层同款,仅筛不建);按项目名/路径包含匹配 */}
      <div className="branch-pop-filter">
        <input
          autoFocus
          value={query}
          aria-label={t('Filter projects', '筛选项目')}
          placeholder={t('Filter projects…', '筛选项目…')}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter=唯一命中即选,多命中选首个,空列表不动作
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const first = projRows[0];
            if (first !== undefined) onPick(first.root ?? '');
          }}
        />
      </div>
      {projRows.map((r) => (
        <button
          key={r.slug}
          type="button"
          role="menuitem"
          className={`sx-menuitem${r.root === picked ? ' active' : ''}`}
          onClick={() => onPick(r.root ?? '')}
        >
          {/* 项目下拉条目前缀文件夹图标(2026-11-11 用户裁定,与分支项分支图标同语言) */}
          <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
          {(() => {
            const nm = baseName(r.root ?? r.slug);
            return nm === 'default' || nm.startsWith('sunshinex-default') ? t('Default workspace', '默认工作区') : nm;
          })()}
        </button>
      ))}
      {projRows.length === 0 && <div className="proj-empty">{t('No matching project', '无匹配项目')}</div>}
      <button type="button" role="menuitem" className="sx-menuitem proj-browse" onClick={onBrowse}>
        <FolderAddIcon size={14} /> {t('Browse folders…', '浏览文件夹…')}
      </button>
      {hint !== '' && <div className="proj-hint">{hint}</div>}
    </div>
  );
}
