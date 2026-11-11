import { useLayoutEffect, useRef, useState } from 'react';
import { Check, GitBranch, Plus } from 'lucide-react';
import { t } from '../i18n';

/** 欢迎页分支弹层(2026-11-09 用户裁定改版):固定宽高(清单区内滚)、当前分支右侧对号、顶部筛选行——
 *  输入即过滤,输入名不与既有分支同名时右侧「+」可新建并切换(Enter 同义:精确命中即切换,否则新建);
 *  窄框适配:宽度随可用区缩短(main.tsx 全局钳位器负责平移回区内)。选中/新建派发经 onPick/onCreate(弹层关闭归调用方) */
export function WelcomeBranchMenu({
  gitBr,
  onPick,
  onCreate,
  selected,
}: {
  gitBr: { current: string; branches: string[]; occupied?: Record<string, string> };
  onPick: (branch: string) => void;
  onCreate: (branch: string) => void;
  /** 发送时目标分支(2026-11-10 用户裁定「选择不切换」):≠当前分支即选中态标记 */
  selected?: string;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  // 视口适配(2026-11-09 用户实测「没有自动左移、没有动态缩短」):可用区=视口、主对话区与全部裁剪祖先(overflow 非
  // visible)的交集;宽度取 min(280, 可用宽)(下限 160),再整体左/右移贴回可用区。窗口缩放/布局变化即重算——
  // 命令式写样式(先清旧值再量,免状态回环)
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const fit = (): void => {
      el.style.width = '';
      // 宿主面板边界(2026-11-09 用户实测审查页分支下拉仍挤走):弹窗锚在哪个面板(主对话区/右侧栏)就以它为界——
      // 审查页在右栏内,closest('.sx-main') 为空,旧口径只剩视口=既不缩宽也不左移;窄面板下缩宽+左移双管齐下
      const host = el.closest('.sx-main, .sx-sidebar')?.getBoundingClientRect();
      let left = 8;
      let right = window.innerWidth - 8;
      if (host !== undefined) {
        left = Math.max(left, host.left + 8);
        right = Math.min(right, host.right - 8);
      }
      for (let a = el.parentElement; a !== null; a = a.parentElement) {
        if (a.classList.contains('sx-main') || a.classList.contains('sx-sidebar') || getComputedStyle(a).overflowX === 'visible') continue;
        const r = a.getBoundingClientRect();
        left = Math.max(left, r.left + 8);
        right = Math.min(right, r.right - 8);
      }
      el.style.width = `${Math.round(Math.min(280, Math.max(160, right - left)))}px`; // 平移回区内归全局钳位器(main.tsx)
    };
    fit();
    window.addEventListener('resize', fit);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    ro?.observe(document.documentElement);
    const main = el.closest('.sx-main');
    if (main !== null) ro?.observe(main);
    return () => {
      window.removeEventListener('resize', fit);
      ro?.disconnect();
    };
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
          aria-label={t('Create branch', '创建分支')}
          data-tip={t('Create branch', '创建分支')}
          disabled={!canCreate}
          onClick={() => onCreate(q)}
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="branch-pop-list">
        {shown.map((b) => {
          const held = b !== gitBr.current && gitBr.occupied !== undefined && gitBr.occupied[b] !== undefined;
          const isSelected = selected !== undefined && selected === b && b !== gitBr.current;
          return (
            <button
              key={b}
              type="button"
              data-tip={held ? t('Checked out by another workspace', '已被其他工作区签出') : b}
              role="menuitem"
              aria-disabled={held || undefined}
              className={`sx-menuitem${b === gitBr.current ? ' active' : ''}${held ? ' held' : ''}${isSelected ? ' picked' : ''}`}
              onClick={() => !held && onPick(b)}
            >
              {/* 分支项前缀分支图标(2026-11-11 用户裁定,与项目项文件夹图标同语言) */}
              <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="branch-pop-name">{b}</span>
              {held && <span className="branch-pop-held">{t('Checked out', '已签出')}</span>}
              {b === gitBr.current && <span className="branch-pop-current">{t('Current', '当前')}</span>}
              {isSelected && !held && b !== gitBr.current && <Check size={16} strokeWidth={2} className="branch-pop-check" aria-hidden="true" />}
            </button>
          );
        })}
        {shown.length === 0 && <div className="branch-pop-empty">{t('No matching branch', '无匹配分支')}</div>}
      </div>
    </div>
  );
}
