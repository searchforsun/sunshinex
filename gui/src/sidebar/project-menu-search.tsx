import { useRef, useState } from 'react';
import type { ScheduleJobView, SessionRow, WorkspaceRow } from '../connection';
import { relTime } from '../ui-util';
import { t } from '../i18n';
import { Clock, Folder, Keyboard, Settings, Zap } from 'lucide-react';
import { SunxIcon } from '../sunx-icon';
import { fuzzyHit, sessionMetaLine, wsName } from './project-menu-util';
import { SearchCatBar, SearchSectionHead, useSearchListNav } from '../search-kit';
import { SETTINGS_SEARCH_ITEMS } from '../settings/settings-search';
import type { SettingsSearchItem } from '../settings/settings-search';
import type { SearchAction } from '../search-actions';

/** 分类过滤(搜索框下常驻:内容类型 + 设置项 + 操作,全 App 可搜) */
type SearchCat = 'all' | 'project' | 'session' | 'sunx' | 'schedule' | 'settings' | 'action';

type SessionHit = SessionRow & { root: string; slug: string };
type SearchEntry =
  | { readonly kind: 'project'; readonly row: WorkspaceRow }
  | { readonly kind: 'session' | 'sunx'; readonly row: SessionHit }
  | { readonly kind: 'schedule'; readonly row: ScheduleJobView }
  | { readonly kind: 'setting'; readonly row: SettingsSearchItem }
  | { readonly kind: 'action'; readonly row: SearchAction };

/** 定时任务行右侧元信息:终态/暂停优先,其次下次运行倒计时(UI 相对时间,非写链面) */
function scheduleMetaOf(job: ScheduleJobView): string {
  if (job.ended === true) return t('Ended', '已结束');
  if (job.enabled === false) return t('Paused', '已暂停');
  if (job.nextRunAt === null) return t('Scheduled', '已排期');
  const diff = job.nextRunAt - Date.now();
  if (diff <= 0) return t('due now', '即将运行');
  const m = Math.floor(diff / 60_000);
  if (m < 60) return t(`in ${m}m`, `${m} 分钟后`);
  const h = Math.floor(m / 60);
  if (h < 24) return t(`in ${h}h`, `${h} 小时后`);
  const d = Math.floor(h / 24);
  return t(`in ${d}d`, `${d} 天后`);
}

/** 查找面板(G10-C13):品牌行查找钮开的全 App 搜索弹层(D32 批PM-2 自 ProjectMenu 平移)。
 *  2026-11-21 用户裁定:搜索框下常驻分类条(不显示数量),结果分组头吸顶,↑↓/Home/End 移动
 *  + Enter 直达;宽度参考整体应用宽度(不绑主会话列宽)。覆盖类型:
 *  项目/会话/SUNX/定时任务(内容) + 设置项/快捷键说明(设置页直达行锚) + 操作(菜单动作)——
 *  「不用单独点击设置页、菜单、侧栏的东西」全部从搜索框直达。 */
interface ProjectSearchProps {
  readonly rows: WorkspaceRow[] | null;
  readonly allSessions: ReadonlyArray<SessionHit> | null;
  /** SUNX 域会话全域枚举(null=装载中) */
  readonly allSunx: ReadonlyArray<SessionHit> | null;
  /** 定时任务清单(null=装载中;undefined/空=无任务) */
  readonly schedules: ReadonlyArray<ScheduleJobView> | null;
  /** 操作类快捷项(宿主注入可执行闭包;未接=不出操作分类) */
  readonly searchActions?: readonly SearchAction[];
  readonly query: string;
  readonly onQuery: (q: string) => void;
  readonly onClose: () => void;
  readonly activeSessionId: string;
  readonly runningIds: ReadonlySet<string>;
  readonly journalOfSession: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly isUnseen: (id: string, updatedAt: number) => boolean;
  readonly onAttach: (root: string, journalId: string, journalUpdatedAt?: number) => void;
  readonly onComposeIn: (root: string) => void;
  /** SUNX 条目:journalId 域直寻址重开(宿主 attachSunx 包装) */
  readonly onAttachSunx: (journalId: string, journalUpdatedAt?: number) => void;
  /** 定时任务条目:开任务页并定位到该卡(未接线=不出定时任务分类) */
  readonly onOpenSchedule?: (id: string) => void;
  /** 设置项/快捷键:开设置面板并滚到行锚(未接线=不出设置分类) */
  readonly onOpenSettingsItem?: (pane: string, row?: string) => void;
}

export function ProjectSearch(props: ProjectSearchProps): JSX.Element {
  const { rows, allSessions, allSunx, schedules, searchActions = [], query, onQuery, onClose, activeSessionId, runningIds, journalOfSession, busy, isUnseen, onAttach, onComposeIn, onAttachSunx, onOpenSchedule, onOpenSettingsItem } = props;
  /** 分类态:切换即回焦点到搜索框,键盘流不断(↑↓ 仍可直达结果) */
  const [cat, setCat] = useState<SearchCat>('all');
  const inputRef = useRef<HTMLInputElement>(null);
  const q = query.trim();
  const projects = (rows ?? []).filter((r) => fuzzyHit(wsName(r) + ' ' + r.slug, query));
  const sessions = (allSessions ?? [])
    .filter((r) => fuzzyHit((r.title ?? r.firstUser ?? '') + ' ' + r.id, query))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20);
  const sunx = (allSunx ?? [])
    .filter((r) => fuzzyHit((r.title ?? r.firstUser ?? '') + ' ' + r.id, query))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20);
  const scheduleHits = (schedules ?? []).filter((j) => fuzzyHit(j.name + ' ' + j.prompt + ' ' + j.root, query));
  // 设置项/操作条目多,默认只在按键后进「全部」结果;分类条点选时全量列出
  const showSettings = onOpenSettingsItem !== undefined && (cat === 'settings' || (cat === 'all' && q !== ''));
  const showActions = searchActions.length > 0 && (cat === 'action' || (cat === 'all' && q !== ''));
  const settingsHits = showSettings
    ? SETTINGS_SEARCH_ITEMS.filter((it) =>
        fuzzyHit(
          `${it.label.en} ${it.label.zh} ${it.desc?.en ?? ''} ${it.desc?.zh ?? ''} ${it.paneTitle.en} ${it.paneTitle.zh} ${(it.keys ?? []).join(' ')}`,
          query,
        ),
      ).slice(0, 60)
    : [];
  const actionHits = showActions
    ? searchActions.filter((a) => fuzzyHit(`${a.en} ${a.zh} ${a.hint ?? ''}`, query))
    : [];
  const showProjects = cat === 'all' || cat === 'project';
  const showSessions = cat === 'all' || cat === 'session';
  const showSunx = cat === 'all' || cat === 'sunx';
  const showSchedules = onOpenSchedule !== undefined && (cat === 'all' || cat === 'schedule');
  const entries: SearchEntry[] = [
    ...(showProjects ? projects.map((row): SearchEntry => ({ kind: 'project', row })) : []),
    ...(showSessions ? sessions.map((row): SearchEntry => ({ kind: 'session', row })) : []),
    ...(showSunx ? sunx.map((row): SearchEntry => ({ kind: 'sunx', row })) : []),
    ...(showSchedules ? scheduleHits.map((row): SearchEntry => ({ kind: 'schedule', row })) : []),
    ...settingsHits.map((row): SearchEntry => ({ kind: 'setting', row })),
    ...actionHits.map((row): SearchEntry => ({ kind: 'action', row })),
  ];
  const pick = (index: number): void => {
    const entry = entries[index];
    if (entry === undefined) return;
    if (entry.kind === 'project') {
      if (entry.row.root !== undefined) onComposeIn(entry.row.root);
      onClose();
      return;
    }
    if (entry.kind === 'schedule') {
      onOpenSchedule?.(entry.row.id);
      onClose();
      return;
    }
    if (entry.kind === 'setting') {
      onOpenSettingsItem?.(entry.row.pane, entry.row.row);
      onClose();
      return;
    }
    if (entry.kind === 'action') {
      entry.row.run();
      onClose();
      return;
    }
    if (busy) return;
    if (entry.kind === 'sunx') onAttachSunx(entry.row.id, entry.row.updatedAt);
    else onAttach(entry.row.root, entry.row.id, entry.row.updatedAt);
    onClose();
  };
  const nav = useSearchListNav({ count: entries.length, onPick: pick, resetKey: query + '|' + cat });
  const sessionOffset = showProjects ? projects.length : 0;
  const sunxOffset = sessionOffset + (showSessions ? sessions.length : 0);
  const scheduleOffset = sunxOffset + (showSunx ? sunx.length : 0);
  const settingsOffset = scheduleOffset + (showSchedules ? scheduleHits.length : 0);
  const actionOffset = settingsOffset + settingsHits.length;
  const pickCat = (id: string): void => {
    setCat(id as SearchCat);
    inputRef.current?.focus(); // 分类条点击后焦点回搜索框:方向键/Enter 连续可用
  };
  /** 会话行身份/状态段(SUNX 与普通会话同款口径;图标由宿主外置) */
  const sessionStatusOf = (r: SessionHit): { running: boolean; unseen: boolean } => {
    const isMapped = r.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === r.id;
    return {
      running: isMapped ? runningIds.has(activeSessionId) : r.liveSessionId !== undefined,
      unseen: isUnseen(r.id, r.updatedAt),
    };
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="sx-search-modal"
        role="search"
        aria-label={t('Search everything', '搜索全部')}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          autoFocus
          value={query}
          placeholder={t('Search projects, sessions, settings, actions…', '搜索项目、会话、设置项、操作…')}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onClose();
              return;
            }
            nav.onKeyDown(e);
          }}
        />
        <SearchCatBar
          cats={[
            { id: 'all', en: 'All', zh: '全部' },
            { id: 'project', en: 'Projects', zh: '项目' },
            { id: 'session', en: 'Sessions', zh: '会话' },
            { id: 'sunx', en: 'SUNX', zh: 'SUNX' },
            ...(onOpenSchedule !== undefined ? [{ id: 'schedule', en: 'Scheduled', zh: '定时任务' }] : []),
            ...(onOpenSettingsItem !== undefined ? [{ id: 'settings', en: 'Settings', zh: '设置' }] : []),
            ...(searchActions.length > 0 ? [{ id: 'action', en: 'Actions', zh: '操作' }] : []),
          ]}
          active={cat}
          onPick={pickCat}
        />
        <div className="sx-search-modal-list">
          {showProjects && (
            <>
              <SearchSectionHead label={t('Projects', '项目')} />
              {projects.map((r, i) => (
                <button
                  key={r.slug}
                  ref={i === nav.active ? nav.activeRef : undefined}
                  type="button"
                  className={`sx-search-row${i === nav.active ? ' sx-kbd-active' : ''}`}
                  onMouseEnter={() => nav.setActive(i)}
                  onClick={() => pick(i)}
                >
                  <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span className="sx-search-label">{wsName(r)}</span>
                </button>
              ))}
              {projects.length === 0 && <div className="sx-search-empty">{t('No matching projects', '无匹配项目')}</div>}
            </>
          )}
          {showSessions && (
            <>
              <SearchSectionHead label={t('Sessions', '会话')} />
              {allSessions === null && <div className="sx-search-empty">{t('Loading sessions…', '正在加载会话…')}</div>}
              {sessions.map((r, i) => {
                const index = sessionOffset + i;
                // G14.2xx running 身份按会话记(runningIds 含本行映射会话);他会话看 daemon 标注
                const { running, unseen } = sessionStatusOf(r);
                const label = r.title ?? r.firstUser ?? t('New session', '新会话');
                const metaLine = sessionMetaLine(r);
                return (
                  <button
                    key={r.root + '/' + r.id}
                    ref={index === nav.active ? nav.activeRef : undefined}
                    type="button"
                    className={`sx-search-row${index === nav.active ? ' sx-kbd-active' : ''}`}
                    data-tip={`${label}${metaLine !== '' ? `\n${metaLine}` : ''}`}
                    onMouseEnter={() => nav.setActive(index)}
                    onClick={() => pick(index)}
                  >
                    {running ? <span className="sx-session-dot running" /> : unseen ? <span className="sx-session-dot unseen" /> : null}
                    <span className="sx-search-label">{label}</span>
                    <span className="sx-search-meta">{relTime(r.updatedAt)}</span>
                  </button>
                );
              })}
              {allSessions !== null && sessions.length === 0 && <div className="sx-search-empty">{t('No matching sessions', '无匹配会话')}</div>}
            </>
          )}
          {showSunx && (
            <>
              <SearchSectionHead label="SUNX" />
              {allSunx === null && <div className="sx-search-empty">{t('Loading SUNX sessions…', '正在加载 SUNX…')}</div>}
              {sunx.map((r, i) => {
                const index = sunxOffset + i;
                const { running, unseen } = sessionStatusOf(r);
                const label = r.title ?? r.firstUser ?? t('New Sunx', '新建 Sunx');
                const metaLine = sessionMetaLine(r);
                return (
                  <button
                    key={'sunx:' + r.id}
                    ref={index === nav.active ? nav.activeRef : undefined}
                    type="button"
                    className={`sx-search-row${index === nav.active ? ' sx-kbd-active' : ''}`}
                    data-tip={`${label}${metaLine !== '' ? `\n${metaLine}` : ''}`}
                    onMouseEnter={() => nav.setActive(index)}
                    onClick={() => pick(index)}
                  >
                    <SunxIcon size={14} strokeWidth={1.75} />
                    {running ? <span className="sx-session-dot running" /> : unseen ? <span className="sx-session-dot unseen" /> : null}
                    <span className="sx-search-label">{label}</span>
                    <span className="sx-search-meta">{relTime(r.updatedAt)}</span>
                  </button>
                );
              })}
              {allSunx !== null && sunx.length === 0 && <div className="sx-search-empty">{t('No matching SUNX sessions', '无匹配 SUNX')}</div>}
            </>
          )}
          {showSchedules && (
            <>
              <SearchSectionHead label={t('Scheduled tasks', '定时任务')} />
              {schedules === null && <div className="sx-search-empty">{t('Loading scheduled tasks…', '正在加载定时任务…')}</div>}
              {scheduleHits.map((job, i) => {
                const index = scheduleOffset + i;
                const label = job.name !== '' ? job.name : job.prompt;
                return (
                  <button
                    key={'schedule:' + job.id}
                    ref={index === nav.active ? nav.activeRef : undefined}
                    type="button"
                    className={`sx-search-row${index === nav.active ? ' sx-kbd-active' : ''}`}
                    data-tip={`${job.name}\n${job.prompt}`}
                    onMouseEnter={() => nav.setActive(index)}
                    onClick={() => pick(index)}
                  >
                    <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span className="sx-search-label">{label}</span>
                    <span className="sx-search-meta">{scheduleMetaOf(job)}</span>
                  </button>
                );
              })}
              {schedules !== null && scheduleHits.length === 0 && (
                <div className="sx-search-empty">{t('No matching scheduled tasks', '无匹配定时任务')}</div>
              )}
            </>
          )}
          {showSettings && (
            <>
              <SearchSectionHead label={t('Settings', '设置')} />
              {settingsHits.map((it, i) => {
                const index = settingsOffset + i;
                const label = t(it.label.en, it.label.zh);
                const desc = it.desc !== undefined ? t(it.desc.en, it.desc.zh) : '';
                return (
                  <button
                    key={'setting:' + it.id}
                    ref={index === nav.active ? nav.activeRef : undefined}
                    type="button"
                    className={`sx-search-row${index === nav.active ? ' sx-kbd-active' : ''}`}
                    data-tip={desc !== '' ? `${label}\n${desc}` : label}
                    onMouseEnter={() => nav.setActive(index)}
                    onClick={() => pick(index)}
                  >
                    {it.keys !== undefined ? <Keyboard size={14} strokeWidth={1.75} aria-hidden="true" /> : <Settings size={14} strokeWidth={1.75} aria-hidden="true" />}
                    <span className="sx-search-label">{label}</span>
                    <span className="sx-search-meta">{it.keys !== undefined ? it.keys.join(' + ') : t(it.paneTitle.en, it.paneTitle.zh)}</span>
                  </button>
                );
              })}
              {settingsHits.length === 0 && <div className="sx-search-empty">{t('No matching settings', '无匹配设置项')}</div>}
            </>
          )}
          {showActions && (
            <>
              <SearchSectionHead label={t('Actions', '操作')} />
              {actionHits.map((a, i) => {
                const index = actionOffset + i;
                return (
                  <button
                    key={'action:' + a.id}
                    ref={index === nav.active ? nav.activeRef : undefined}
                    type="button"
                    className={`sx-search-row${index === nav.active ? ' sx-kbd-active' : ''}`}
                    onMouseEnter={() => nav.setActive(index)}
                    onClick={() => pick(index)}
                  >
                    <Zap size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span className="sx-search-label">{t(a.en, a.zh)}</span>
                    {a.hint !== undefined && <span className="sx-search-meta">{a.hint}</span>}
                  </button>
                );
              })}
              {actionHits.length === 0 && <div className="sx-search-empty">{t('No matching actions', '无匹配操作')}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
