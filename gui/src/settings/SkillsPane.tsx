import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import type { SkillsGroup } from '../connection';
import { Select } from './controls';

/**
 * G8c T9 技能面板(设置·技能页):**跨项目全量视图**——拉 scope=all(user 全局 + 当前项目
 * project 组 + 全项目学习沉淀逐项目分组),逐卡 id+描述+**归属标**(卡片右上角 chip:有
 * project 归属显项目名,user 显「全局」;单色 hairline 语言)。工具行三控件占满一行——
 * 搜索框(弹性) + 来源筛选(全部来源/项目/全局/学习沉淀) + **项目筛选**(全部项目/各项目
 * 名,scope=all 的 project 维度),两者叠加过滤(空查询/全部=不限)。
 * 跨源同 id 去重(装载序先者胜=遮蔽裁决生效源,ComposerPlusPanel 同口径)。
 */
export interface SkillsPaneConn {
  skillsGroups(root?: string, all?: boolean): Promise<{ groups: SkillsGroup[] }>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
}

export interface SkillsPaneProps {
  readonly conn: SkillsPaneConn;
  /** 项目上下文('' = 仅全局:project 组缺席,learned 仍跨项目枚举) */
  readonly root: string;
  /** 导航标题(aria-label/标题行) */
  readonly title: string;
}

export function SkillsPane({ conn, root, title }: SkillsPaneProps): JSX.Element {
  /** 平铺技能行(scope=all 全量;null = 加载中) */
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [projectFilter, setProjectFilter] = useState('all');
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
            rows.push({ id: s.id, desc: s.description ?? s.name ?? '', source: g.source, ...(g.project !== undefined ? { project: g.project } : {}) });
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
  }, [conn, r]);

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
      <div className="sx-skills-toolbar">
        <input
          type="text"
          className="sx-setting-input sx-skills-search"
          aria-label="skills search"
          placeholder={t('Search skills…', '搜索技能…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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
            <div key={s.id} className="sx-card sx-skill-card">
              <div className="sx-skill-head">
                <span className="sx-skill-id">{s.id}</span>
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
