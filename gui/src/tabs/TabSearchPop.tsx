import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, FileText } from 'lucide-react';
import { t } from '../i18n';
import { FileIcon, hasFileTypeIcon } from '../file-icon';
import { TAB_ICONS, tabEntry } from './registry';
import { disambiguateTabTitles } from './tab-state';
import type { ClosedTab, TabInstance } from './tab-state';
import { SearchCatBar, SearchSectionHead, useSearchListNav } from '../search-kit';

/**
 * G14.2xx 标签搜索弹窗(chrome「搜索标签页」同位,用户裁定纵向形态):搜索框过滤 +
 * 「打开的标签页」(图标/消歧标题/相对时间/×关)+「最近关闭的标签页」(点击重开)。
 * 纯受控渲染件:开合与数据全部上抛(TabStrip 触发,App 持 recentClosed/reopen)。
 * 2026-11-21 用户裁定「所有搜索框下边可以置顶分类,搜索出来内容可以进行合理跳转」:
 * 搜索框下常驻 全部/打开的标签页/最近关闭 分类条,分组头吸顶;↑↓/Enter 直达(打开项切过去,
 * 最近关闭项重开)。
 */

type TabCat = 'all' | 'open' | 'closed';

interface OpenHit {
  readonly kind: 'open';
  readonly tab: TabInstance;
  readonly title: string;
}
interface ClosedHit {
  readonly kind: 'closed';
  readonly closed: ClosedTab;
  readonly index: number;
  readonly title: string;
}
type TabHit = OpenHit | ClosedHit;

interface TabSearchPopProps {
  readonly tabs: readonly TabInstance[];
  readonly activeUid: string | null;
  readonly recentClosed: readonly ClosedTab[];
  readonly onSelect: (uid: string) => void;
  readonly onCloseTab: (uid: string) => void;
  readonly onReopen: (index: number) => void;
  /** 收口(选单/Esc/外点)——TabStrip 据此落 searchOpen=false */
  readonly onDone: () => void;
}

/** 相对时间(chrome 同位):刚刚/N分/N小时/N天;无时刻(历史档)留空 */
function fmtAge(ts: number | undefined, now: number): string {
  if (ts === undefined || ts <= 0) return ''; // 0=盘档未知时刻:留空
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return t('just now', '刚刚');
  const m = Math.floor(s / 60);
  if (m < 60) return t(`${m}m`, `${m}分`);
  const h = Math.floor(m / 60);
  if (h < 24) return t(`${h}h`, `${h}小时`);
  return t(`${Math.floor(h / 24)}d`, `${Math.floor(h / 24)}天`);
}

export function TabSearchPop({ tabs, activeUid, recentClosed, onSelect, onCloseTab, onReopen, onDone }: TabSearchPopProps): JSX.Element {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<TabCat>('all');
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  // 挂载即聚焦搜索框;开席期 30s tick 刷新相对时间(刚刚→N分 不冻结)
  useEffect(() => {
    inputRef.current?.focus();
    const iv = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(iv);
  }, []);
  const titles = useMemo(() => disambiguateTabTitles(tabs), [tabs]);
  const needle = q.trim().toLowerCase();
  const hit = (title: string): boolean => needle === '' || title.toLowerCase().includes(needle);
  const openRows: OpenHit[] = tabs
    .map((tab) => ({ kind: 'open' as const, tab, title: titles.get(tab.uid) ?? tabEntry(tab.type).title(tab.params) }))
    .filter((r) => hit(r.title));
  const closedRows: ClosedHit[] = recentClosed
    .map((closed, index) => ({ kind: 'closed' as const, closed, index, title: tabEntry(closed.type).title(closed.params) }))
    .filter((r) => hit(r.title));
  const showOpen = cat !== 'closed';
  const showClosed = cat !== 'open';
  const entries: TabHit[] = [...(showOpen ? openRows : []), ...(showClosed ? closedRows : [])];
  const pick = (index: number): void => {
    const entry = entries[index];
    if (entry === undefined) return;
    if (entry.kind === 'open') onSelect(entry.tab.uid);
    else onReopen(entry.index);
    onDone();
  };
  const nav = useSearchListNav<HTMLDivElement>({ count: entries.length, onPick: pick, resetKey: q + '|' + cat });
  const closedOffset = showOpen ? openRows.length : 0;
  const pickCat = (id: string): void => {
    setCat(id as TabCat);
    inputRef.current?.focus(); // 分类点击后回搜索框:方向键/Enter 连续可用
  };
  const iconOf = (type: TabInstance['type'], path: string | undefined): JSX.Element => {
    if (path !== undefined && hasFileTypeIcon(path)) return <FileIcon path={path} size={16} />;
    const Icon = TAB_ICONS[type] ?? FileText;
    return <Icon size={16} strokeWidth={1.75} />;
  };
  return (
    <div className="sx-tabsearch" role="dialog" aria-label={t('Search tabs', '搜索标签页')}>
      <div className="sx-tabsearch-head">
        <Search size={14} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={inputRef}
          value={q}
          placeholder={t('Search tabs…', '搜索标签页…')}
          aria-label={t('Search tabs', '搜索标签页')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onDone();
              return;
            }
            nav.onKeyDown(e);
          }}
        />
      </div>
      <SearchCatBar
        cats={[
          { id: 'all', en: 'All', zh: '全部' },
          { id: 'open', en: 'Open tabs', zh: '打开的标签页' },
          { id: 'closed', en: 'Recently closed', zh: '最近关闭' },
        ]}
        active={cat}
        onPick={pickCat}
      />
      <div className="sx-tabsearch-body">
        {showOpen && openRows.length > 0 && <SearchSectionHead label={t('Open tabs', '打开的标签页')} />}
        {showOpen && openRows.map(({ tab, title }, i) => (
          <div
            key={tab.uid}
            ref={i === nav.active ? nav.activeRef : undefined}
            role="button"
            tabIndex={0}
            className={`sx-tabsearch-row${tab.uid === activeUid ? ' active' : ''}${i === nav.active ? ' sx-kbd-active' : ''}`}
            onMouseEnter={() => nav.setActive(i)}
            onClick={() => pick(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') pick(i);
            }}
          >
            {iconOf(tab.type, tab.params.path)}
            <span className="sx-tabsearch-name" data-tip={title}>{title}</span>
            <span className="sx-tabsearch-time">{fmtAge(tab.createdAt, now)}</span>
            <span
              role="button"
              aria-label={`${t('Close tab', '关闭标签')} ${title}`}
              className="sx-tabsearch-close"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.uid);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  onCloseTab(tab.uid);
                }
              }}
            >
              <X size={14} strokeWidth={1.75} />
            </span>
          </div>
        ))}
        {showClosed && closedRows.length > 0 && <SearchSectionHead label={t('Recently closed', '最近关闭的标签页')} />}
        {showClosed && closedRows.map(({ closed, index, title }, i) => {
          const idx = closedOffset + i;
          return (
            <div
              key={`${closed.closedAt}:${index}`}
              ref={idx === nav.active ? nav.activeRef : undefined}
              role="button"
              tabIndex={0}
              className={`sx-tabsearch-row${idx === nav.active ? ' sx-kbd-active' : ''}`}
              data-tip={title}
              onMouseEnter={() => nav.setActive(idx)}
              onClick={() => pick(idx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') pick(idx);
              }}
            >
              {iconOf(closed.type, closed.params.path)}
              <span className="sx-tabsearch-name">{title}</span>
              <span className="sx-tabsearch-time">{fmtAge(closed.closedAt, now)}</span>
            </div>
          );
        })}
        {entries.length === 0 && <div className="sx-tabsearch-empty">{t('No matching tabs', '无匹配标签页')}</div>}
      </div>
    </div>
  );
}
