import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { SkillsGroup } from '../connection';
import { Select } from './controls';
import { ScopeSelect, SearchBar } from './components';
import type { SettingsScope } from './components';

/**
 * G8c T9 技能面板(设置·技能页):**跨项目全量视图**——拉 scope=all(user 全局 + 当前项目
 * project 组 + 全项目学习沉淀逐项目分组),逐卡 id+描述+**归属标**(卡片右上角 chip:有
 * project 归属显项目名,user 显「全局」;单色 hairline 语言)。工具栏(2026-10-29 用户裁定
 * 三件套入页,只读面:作用域下拉+搜索,无添加钮)——ScopeSelect 作用域下拉 + SearchBar
 * (200ms 防抖,弹性)+ 来源筛选(全部来源/项目/全局/学习沉淀)+ **项目筛选**(全部项目/各项目
 * 名,scope=all 的 project 维度),后两者叠加过滤(空查询/全部=不限)——过滤逻辑零变化。
 * 作用域下拉只上抛不重拉:本面 scope=all 跨项目全量视图是本面裁定,不随壳作用域收窄。
 * 跨源同 id 去重(装载序先者胜=遮蔽裁决生效源,ComposerPlusPanel 同口径)。
 * Task 25 遮蔽标注:行带 daemon 富化 shadowedBy(catalog listSkills 链上裁决——当前项目链中
 * 同 id 被更高优先来源遮蔽)→ 卡灰显 + 「被 <来源> 同名技能遮蔽」角标(sourceDir 随行,
 * id 悬停 tip;字段在场才渲染——gating 契约沿 T23,MCP/agents 遮蔽标同语言)。
 */
export interface SkillsPaneConn {
  skillsGroups(root?: string, all?: boolean): Promise<{ groups: SkillsGroup[] }>;
}


/** 来源筛选项值 */
type SourceFilter = 'all' | SkillsGroup['source'];

/** 来源筛选项(值恒定;标签渲染期 t() 求值——G14.213 设置面 i18n,模块常量不冻结文案) */
const SOURCE_FILTER_OPTIONS: ReadonlyArray<{ v: SourceFilter; en: string; zh: string }> = [
  { v: 'all', en: 'All sources', zh: '全部来源' },
  { v: 'project', en: 'Project', zh: '项目' },
  { v: 'user', en: 'Global', zh: '全局' },
  { v: 'learned', en: 'Learned', zh: '学习沉淀' },
];
const sourceFilterOptions = (): Array<{ v: SourceFilter; l: string }> =>
  SOURCE_FILTER_OPTIONS.map((o) => ({ v: o.v, l: t(o.en, o.zh) }));

interface SkillRow {
  readonly id: string;
  readonly desc: string;
  readonly source: SkillsGroup['source'];
  /** 项目归属显示名(scope=all 视图的 project/learned 行;user 行无) */
  readonly project?: string;
  /** T25 遮蔽标注(daemon 富化):同 id 被更高优先来源遮蔽的胜者来源名——字段在场才灰显+角标 */
  readonly shadowedBy?: string;
  /** T25 富化:条目落盘目录(id 悬停 tip;字段在场才带) */
  readonly sourceDir?: string;
}

export interface SkillsPaneProps {
  readonly conn: SkillsPaneConn;
  /** 项目上下文('' = 仅全局:project 组缺席,learned 仍跨项目枚举) */
  readonly root: string;
  /** 导航标题(aria-label/标题行) */
  readonly title: string;
  /** T21 设置壳注入:作用域(工具栏 ScopeSelect 回显)——本面 scope 意识沿既有过滤保持(scope=all
   *  跨项目全量视图是本面裁定,不随壳作用域收窄,切换不重拉;2026-10-29 起工具栏下拉消费回显+上抛) */
  readonly scope?: SettingsScope;
  /** 2026-10-29 工具栏 ScopeSelect 上抛口(状态留壳层):未接(直接渲染/桩测)时切换不回写 */
  readonly onScopeChange?: (scope: SettingsScope) => void;
  /** T21 config-changed 订阅 tick(skills 资源计数——外部改动信号,变化即重拉;未消费可忽略) */
  readonly refreshTick?: number;
}

export function SkillsPane({ conn, root, title, scope, onScopeChange, refreshTick }: SkillsPaneProps): JSX.Element {
  /** 平铺技能行(scope=all 全量;null = 加载中) */
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [projectFilter, setProjectFilter] = useState('all');
  /** 工具栏作用域回显:壳下发优先,缺省按 root 推断(壳缺省同款——无 root 强制 global;
   *  仅回显+上抛,不参与取参——本面恒 scope=all 全量视图) */
  const myScope: SettingsScope = scope ?? (root === '' ? 'global' : 'project');
  const r = root === '' ? undefined : root;

  useEffect(() => {
    let alive = true;
    conn.skillsGroups(r, true).then(
      (v) => {
        if (!alive) return;
        const seen = new Set<string>(); // 跨源/跨项目同 id 去重(先者=装载序生效源)
        const rows: SkillRow[] = [];
        for (const g of v.groups) {
          for (const s of g.skills) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            rows.push({
              id: s.id,
              desc: s.description ?? s.name ?? '',
              source: g.source,
              ...(g.project !== undefined ? { project: g.project } : {}),
              // T25 富化字段透传(字段在场才带——gating 契约沿 T23,无富化行零标注)
              ...(s.shadowedBy !== undefined ? { shadowedBy: s.shadowedBy } : {}),
              ...(s.sourceDir !== undefined ? { sourceDir: s.sourceDir } : {}),
            });
          }
        }
        setSkills(rows);
        setLoadError('');
      },
      (err: unknown) => {
        if (alive) setLoadError(errText(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, r, refreshTick]); // refreshTick 变化=外部改动信号 → 重拉(config-changed 订阅消费面)

  /** 项目筛选项:scope=all 行的去重归属名清单(码点序) */
  const projectOptions = useMemo(() => {
    const names = new Set<string>();
    for (const s of skills ?? []) if (s.project !== undefined) names.add(s.project);
    return ['all', ...[...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
  }, [skills]);

  /** 搜索+来源+项目三重叠加:id/描述大小写不敏感包含;空查询/全部=不限 */
  const filtered = useMemo(() => {
    if (skills === null) return null;
    const q = query.trim().toLowerCase();
    return skills.filter(
      (s) =>
        (sourceFilter === 'all' || s.source === sourceFilter) &&
        (projectFilter === 'all' || s.project === projectFilter) &&
        (q === '' || s.id.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q)),
    );
  }, [skills, query, sourceFilter, projectFilter]);

  return (
    <section className="sx-settings-form sx-settings-body" aria-label={`settings pane ${title}`}>
      <h2>{title}</h2>
      {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
      <div className="sx-res-toolbar">
        <ScopeSelect scope={myScope} projectAvailable={root !== ''} onScopeChange={(s) => onScopeChange?.(s)} />
        <SearchBar value={query} onChange={setQuery} placeholder={t('Search skills…', '搜索技能…')} />
        <div className="sx-skills-filter">
          <Select
            ariaLabel="skills source"
            value={sourceFilter}
            options={sourceFilterOptions()}
            onChange={(v) => setSourceFilter(v as SourceFilter)}
          />
        </div>
        <div className="sx-skills-filter project">
          <Select
            ariaLabel="skills project"
            value={projectFilter}
            options={projectOptions.map((p) => (p === 'all' ? { v: 'all', l: t('All projects', '全部项目') } : { v: p, l: p }))}
            onChange={(v) => setProjectFilter(v)}
          />
        </div>
      </div>
      {filtered === null && loadError === '' && <p className="home-loading">{t('Loading skills…', '加载技能清单…')}</p>}
      {filtered !== null && filtered.length === 0 && (
        <p className="home-loading">
          {query.trim() === '' && sourceFilter === 'all' && projectFilter === 'all' ? t('No skills loaded.', '无已装载技能。') : t('No matching skills.', '无匹配技能。')}
        </p>
      )}
      {filtered !== null && filtered.length > 0 && (
        <div className="sx-skill-grid">
          {filtered.map((s) => (
            <div key={s.id} className={`sx-card sx-skill-card${s.shadowedBy !== undefined ? ' shadowed' : ''}`}>
              <div className="sx-skill-head">
                <span className="sx-skill-id" data-tip={s.sourceDir}>{s.id}</span>
                {s.shadowedBy !== undefined && (
                  <span className="sx-shadow-tag">{t(`Shadowed by ${s.shadowedBy} skill`, `被 ${s.shadowedBy} 同名技能遮蔽`)}</span>
                )}
                <span className={`sx-skill-src sx-skill-src-${s.source}`} data-tip={s.project !== undefined ? t(`Belongs to project: ${s.project}`, `归属项目:${s.project}`) : t('Global skill', '全局技能')}>
                  {s.project !== undefined ? s.project : t('Global', '全局')}
                </span>
              </div>
              {s.desc !== '' && <span className="sx-skill-desc">{s.desc}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
