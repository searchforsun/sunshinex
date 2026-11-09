import { useLayoutEffect, useRef, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { t } from '../i18n';

/** 欢迎页分支弹层(2026-11-09 用户裁定改版):固定宽高(清单区内滚)、当前分支右侧对号、顶部筛选行——
 *  输入即过滤,输入名不与既有分支同名时右侧「+」可新建并切换(Enter 同义:精确命中即切换,否则新建);
 *  弹层右缘越出主对话区/视口(窄框、开侧栏)时整体左移贴回区内。选中/新建派发经 onPick/onCreate(弹层关闭归调用方) */
export function WelcomeBranchMenu({
  gitBr,
  onPick,
  onCreate,
}: {
  gitBr: { current: string; branches: string[] };
  onPick: (branch: string) => void;
  onCreate: (branch: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [shift, setShift] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // 右界=所在主对话区(.sx-main 开侧栏后变窄且裁剪溢出)与视口取小;左移不越过主区左缘
    const r = el.getBoundingClientRect();
    const main = el.closest('.sx-main')?.getBoundingClientRect();
    const right = Math.min(window.innerWidth, main?.right ?? window.innerWidth) - 8;
    const left = (main?.left ?? 0) + 8;
    const over = r.right - right;
    if (over > 0) setShift(-Math.ceil(Math.min(over, Math.max(0, r.left - left))));
  }, []);
  const q = query.trim();
  const shown = q === '' ? gitBr.branches : gitBr.branches.filter((b) => b.toLowerCase().includes(q.toLowerCase()));
  const exact = gitBr.branches.includes(q);
  const canCreate = q !== '' && !exact && !/[^\w./-]/.test(q) && !q.startsWith('-');
  return (
    <div
      ref={ref}
      className="sx-menu-pop pill-pop branch-pop"
      role="menu"
      aria-label={t('Branch', '分支')}
      style={shift !== 0 ? { transform: `translateX(${shift}px)` } : undefined}
    >
      <div className="branch-pop-filter">
        <input
          autoFocus
          value={query}
          aria-label={t('Filter or create branch', '筛选或新建分支')}
          placeholder={t('Filter branches…', '筛选分支…')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (exact) onPick(q);
            else if (canCreate) onCreate(q);
          }}
        />
        <button
          type="button"
          className="branch-pop-add"
          aria-label={t('Create and switch branch', '新建并切换分支')}
          data-tip={t('Create and switch', '新建并切换')}
          disabled={!canCreate}
          onClick={() => onCreate(q)}
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="branch-pop-list">
        {shown.map((b) => (
          <button
            key={b}
            type="button"
            data-tip={b}
            role="menuitem"
            className={`sx-menuitem${b === gitBr.current ? ' active' : ''}`}
            onClick={() => onPick(b)}
          >
            <span className="branch-pop-name">{b}</span>
            {b === gitBr.current && <Check size={16} strokeWidth={2} className="branch-pop-check" aria-hidden="true" />}
          </button>
        ))}
        {shown.length === 0 && <div className="branch-pop-empty">{t('No matching branch', '无匹配分支')}</div>}
      </div>
    </div>
  );
}
