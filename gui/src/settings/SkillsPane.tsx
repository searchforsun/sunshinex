import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { SkillsGroup } from '../connection';
import { Select } from './controls';
import { SearchBar, defaultScopeOptions } from './components';
import type { ScopeOption } from './components';

/**
 * G8c T9 技能面板(设置·技能页):技能清单视图——工具栏(2026-10-29 用户裁定两件套)前端
 * **项目下拉**(定宽 sx-dd-fixed)+搜索(200ms 防抖,弹性)+ 来源筛选(全部来源/项目/全局/
 * 学习沉淀)。项目下拉(同日裁定:原「作用域下拉+项目筛选」语义重复合并为一个,提到最前):
 * 选项=「全部项目」(跨项目视图)+'全局'+各注册项目(scopeOptions=壳 GET /workspaces 注册表,
 * 未接=缺省 全局+当前 root)。target 数据面三分:
 * - 'all'(缺省,即原 scope=all 跨项目全量视图):`skillsGroups(undefined, true)`——**壳层不下发
 *   root**,本面自持 scope=all 拉取(user 全局 + 注册项目域逐项目分组);拉取不带 root=无锚链,
 *   user 组遮蔽富化省字段(daemon enrichSkillsGroups 裁定:无项目上下文无从遮蔽)。
 * - ''(全局):`skillsGroups(undefined)`——仅 user 组(userSkillsDir 全局可扫)。
 * - 项目 root:`skillsGroups(root)`——该 root 链三组(project/user/learned)+遮蔽富化。
 * 切换即重拉(本面只读,无写面);'all' 态**不上抛壳层**(targetRoot 模型无 'all' 值——壳层
 * 不感知,其他页目标不受影响);'全局'/项目两态经 onScopeChange 上抛同步壳 targetRoot。
 * 跨源同 id 去重(装载序先者胜=遮蔽裁决生效源,ComposerPlusPanel 同口径;'all' 视图跨项目
 * 同 id 亦由先者胜收一张卡)。
 * Task 25 遮蔽标注:行带 daemon 富化 shadowedBy(catalog listSkills 链上裁决)→ 卡灰显 +
 * 「被 <来源> 同名技能遮蔽」角标(sourceDir 随行,id 悬停 tip;字段在场才渲染——gating 契约
 * 沿 T23,MCP/agents 遮蔽标同语言;'all' 态省字段即零标注)。
 */
export interface SkillsPaneConn {
  skillsGroups(root?: string, all?: boolean): Promise<{ groups: SkillsGroup[] }>;
}

/** 项目下拉 target:'all'=跨项目视图(原 scope=all 数据面);''=全局;其余=项目 root */
type SkillsTarget = 'all' | '' | string;

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
  /** 项目归属显示名('all' 视图的 project/learned 行;user 行无) */
  readonly project?: string;
  /** T25 遮蔽标注(daemon 富化):同 id 被更高优先来源遮蔽的胜者来源名——字段在场才灰显+角标 */
  readonly shadowedBy?: string;
  /** T25 富化:条目落盘目录(id 悬停 tip;字段在场才带) */
  readonly sourceDir?: string;
}

export interface SkillsPaneProps {
  readonly conn: SkillsPaneConn;
  /** 快照项目上下文(缺省选项面兜底——scopeOptions 未接时缺省 全局+当前 root;数据面不消费:
   *  target 三态各走各的取参,见头注) */
  readonly root: string;
  /** 导航标题(aria-label/标题行) */
  readonly title: string;
  /** 2026-10-29 项目下拉上抛口('全局'/项目两态同步壳 targetRoot;'all' 态不上抛——壳层
   *  targetRoot 无 'all' 值,本面自持;未接(直接渲染/桩测)时切换不回写) */
  readonly onScopeChange?: (targetRoot: string) => void;
  /** 目标选择器选项面(壳下发:全局+全部注册项目按名;未接=直渲/桩测缺省 全局+当前 root) */
  readonly scopeOptions?: readonly ScopeOption[];
  /** T21 config-changed 订阅 tick(skills 资源计数——外部改动信号,变化即重拉;未消费可忽略) */
  readonly refreshTick?: number;
}

export function SkillsPane({ conn, root, title, onScopeChange, scopeOptions, refreshTick }: SkillsPaneProps): JSX.Element {
  /** 平铺技能行(null = 加载中) */
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  /** 项目下拉 target(本面自持;'all'=缺省跨项目视图,即原 scope=all 数据面。壳 targetRoot
   *  不感知 'all'——切到 全局/项目 才上抛同步壳状态) */
  const [target, setTarget] = useState<SkillsTarget>('all');

  useEffect(() => {
    let alive = true;
    // target 数据面三分(头注):'all'=scope=all 不带 root(壳层不下发 root,本面自持拉取);
    // ''=仅全局;项目 root=该链三组
    const fetchRoot = target === 'all' || target === '' ? undefined : target;
    conn.skillsGroups(fetchRoot, target === 'all' ? true : undefined).then(
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
  }, [conn, target, refreshTick]); // refreshTick 变化=外部改动信号 → 重拉(config-changed 订阅消费面)

  /** 项目下拉选项面:'全部项目' 恒首(跨项目视图)+ 壳装配清单(全局+注册项目;未接=缺省面) */
  const targetOptions = useMemo(() => {
    const opts = [{ v: 'all', l: t('All projects', '全部项目') }];
    for (const o of scopeOptions ?? defaultScopeOptions(root)) opts.push({ v: o.value, l: o.label });
    return opts;
  }, [scopeOptions, root]);

  /** 搜索+来源叠加:id/描述大小写不敏感包含;空查询/全部=不限(项目维度已由 target 收窄) */
  const filtered = useMemo(() => {
    if (skills === null) return null;
    const q = query.trim().toLowerCase();
    return skills.filter(
      (s) => (sourceFilter === 'all' || s.source === sourceFilter) && (q === '' || s.id.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q)),
    );
  }, [skills, query, sourceFilter]);

  /** 项目下拉选择:'all' 只落本面(壳层不下发 root);其余上抛同步壳 targetRoot */
  const pickTarget = (v: string): void => {
    setTarget(v);
    if (v !== 'all') onScopeChange?.(v);
  };

  return (
    <section className="sx-settings-form sx-settings-body" aria-label={`settings pane ${title}`}>
      <h2>{title}</h2>
      {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
      <div className="sx-res-toolbar">
        {/* 项目下拉(2026-10-29 合并裁定,提到最前;定宽 sx-dd-fixed——超长项目名 ellipsis,
            data-tip 全名):全部项目|全局|各注册项目 */}
        <Select
          className="sx-dd-fixed"
          ariaLabel={t('Project', '项目')}
          value={target}
          options={targetOptions}
          title={targetOptions.find((o) => o.v === target)?.l}
          onChange={pickTarget}
        />
        <SearchBar value={query} onChange={setQuery} placeholder={t('Search skills…', '搜索技能…')} />
        <div className="sx-skills-filter">
          <Select
            ariaLabel="skills source"
            value={sourceFilter}
            options={sourceFilterOptions()}
            onChange={(v) => setSourceFilter(v as SourceFilter)}
          />
        </div>
      </div>
      {filtered === null && loadError === '' && <p className="home-loading">{t('Loading skills…', '加载技能清单…')}</p>}
      {filtered !== null && filtered.length === 0 && (
        <p className="home-loading">
          {query.trim() === '' && sourceFilter === 'all' ? t('No skills loaded.', '无已装载技能。') : t('No matching skills.', '无匹配技能。')}
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
