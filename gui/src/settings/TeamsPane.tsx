import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { AgentsView, BuiltinRole, TeamEntryView, TeamFrontmatterInput, TeamsOpInput, TeamsView } from '../connection';
import { ConfirmDeleteButton, EditorModal, EmptyState, ErrorBanner, ModalField, ResourceCard, ScopeSelect, SearchBar, defaultScopeOptions } from './components';
import type { SettingsScope, ScopeOption } from './components';
import { Select } from './controls';
import { ClampBlock } from '../clamp-block';

/**
 * agents-teams P1 Task 3 TeamsPane（Settings 页「智能体团队」面，AgentsPane 逐件对应镜像）：
 * 一屏式卡片列表——写面统一走 PUT /settings/teams 的 op 四值（Task 2 serve 三端点：
 * GET 清单/PUT 表单增删改/GET body 章程全文，经 conn.teamsView/putTeamOp/teamBody）。
 *
 * 结构（Task 21 共享组件 verbatim 消费，AgentsPane 同款）：工具栏三件套（ScopeSelect 目标
 * 选择器+SearchBar（200ms 防抖过滤 id/name/description）+「+ New」钮一行）；主体 ul.sx-rc-list ×
 * ResourceCard（title=id 注册表键/subtitle=name/chips=成员逐个+shadowed 标注/badge=
 * SourceBadge/正文直显）；增改 → EditorModal 居中模态（id 编辑态锁定；写作用域随壳——无本地
 * scope select）。teams 无 builtins（serve 响应只设 view 键）——无 agents 面的内建只读段。
 *
 * 排序（ledger 裁定）：wire 序=global→project（catalog 清单序）——pane 侧排**显示副本**
 * project 先（仅显示序，不改 wire 数据语义；op 均按行 source 取参，不受显示序影响）。
 *
 * 成员编辑（ledger R3 裁定的组合形态）：已知 agent id 复选列表（=agentsView.builtins 四角色 +
 * agentsView.view.entries，行显 `id — name`——conn.agentsView 供数据源，读取失败静默降级空集，
 * 手输兜底仍在）+「额外 id（空格分隔）」文本输入（自由键入新 id）；提交时合并+逐项 trim+
 * 去重保首现；空集本地拦（daemon 400 同文案）。lead=Select，选项=当前合并 members；提交守卫
 * lead ∈ members——勾选变更致 lead 失效时不落键（catalog upsertTeam 同裁决，前端预守卫）。
 *
 * id 安全面（AMENDMENT 2026-11-04 口径）：新增态本地校验严格 kebab（daemon isValidTeamId 同款
 * 正则与文案——id 拼目录路径，大写/下划线/点开头/路径穿越一律行内拦）；编辑态锁定。
 *
 * 启停（REST 富化 gating 沿 T23 agents）：enabled 恒布尔契约的字段在场才渲染开关（daemon 缺键
 * 不渲染，无误导态）；切停=op disable、复启=op enable，新会话生效——teams 装配期语义。
 *
 * 编辑播种沿 G8d-T3 全文装载：编辑钮先以 bodyPreview 播种（即时开弹窗），再 conn.teamBody 拉
 * team.md 章程全文升级播种——成功则截断守卫对该弹窗退役；失败回退 bodyPreview+行内提示。截断
 * 守卫保留为兜底：播种面触 200 字截断帽且未改写 → 阻断保存行内示错（防截断文写盘毁余文）；
 * 已改写=有意重写放行。frontmatter 缺省键不落请求体（name/members 必填；description/version
 * 空串省略；lead 失效省略；enabled 恒显式落布尔——启停是 teams 的一等状态）。
 *
 * 错误面三分（agents 同款）：loadError=读面失败/actionError=op 写面失败（409 hint 经 errText
 * 呈现）/formError=弹窗校验与保存失败，均 ErrorBanner 行内。saving 门单点：写面在途禁再发。
 * config-changed 订阅：壳下发 refreshTick（teams 资源计数）变化即重拉（外部改动信号，零轮询）。
 */

/** 团队面连接面（结构满足即收，App 传整只 Connection）；putTeamOp=Task 2 op 端点写面；
 *  agentsView=成员多选数据源（辅助面） */
export interface TeamsPaneConn {
  teamsView(root?: string): Promise<{ view: TeamsView }>;
  putTeamOp(input: TeamsOpInput): Promise<void>;
  /** 章程正文全文（team.md frontmatter 后正文；编辑播种升级面） */
  teamBody(scope: 'project' | 'global', id: string, root?: string): Promise<{ body: string }>;
  /** 成员复选数据源（builtins 四角色+注册清单；读失败静默降级——teams 主面不受牵连） */
  agentsView(root?: string): Promise<{ builtins: BuiltinRole[]; view: AgentsView }>;
}

/** id 安全面（daemon isValidTeamId 严格 kebab 同款，AMENDMENT 2026-11-04：id 拼目录路径——
 *  大写/下划线/点开头/路径穿越一律拒；较 agents 的 permissive 词法收紧） */
const TEAM_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** daemon bodyPreview 截断帽（handleTeamsGet slice(0,200) 同款）：长度触帽即原文可能被截——编辑守卫判据 */
const BODY_PREVIEW_CAP = 200;

/** 弹窗表单态（受控单对象；edit=true 时 id 锁定。seededBody=编辑播种的章程原文——截断守卫
 *  比对基线；bodyFull=true 表示已升级全文装载，守卫对该弹窗退役）。成员=组合形态两件：
 *  members=已知 agent 复选勾选集（保勾选序），extraMembers=手输额外 id（空格分隔原文） */
interface TeamFormState {
  readonly editing: boolean;
  readonly id: string;
  name: string;
  description: string;
  version: string;
  members: string[];
  extraMembers: string;
  lead: string;
  enabled: boolean;
  body: string;
  /** 编辑播种的章程原文——save 守卫判「用户是否已改写」的基线 */
  readonly seededBody: string;
  /** true = 章程已升级为 team.md 全文（teamBody 成功）——无截断风险，守卫退役 */
  readonly bodyFull: boolean;
}

/** 弹窗会话态：add=新增（source=写作用域=壳 scope）；edit=编辑某卡（source=卡 source——可写卡
 *  的 source 与壳作用域一致，见 canWrite） */
type DrawerState = { mode: 'add' | 'edit'; source: 'project' | 'global'; id: string };

/** 成员合并单点（ledger R3）：已知勾选+手输 extra（空白分隔）→ 逐项 trim、去空、去重保首现 */
function mergeMembers(checked: string[], extraText: string): string[] {
  const merged: string[] = [];
  for (const raw of [...checked, ...extraText.split(/\s+/)]) {
    const id = raw.trim();
    if (id !== '' && !merged.includes(id)) merged.push(id);
  }
  return merged;
}

export interface TeamsPaneProps {
  readonly conn: TeamsPaneConn;
  /** 作用域目标项目 root（壳下发 targetRoot——下拉选哪个项目即锚哪个；'' = 全局作用域） */
  readonly root?: string;
  /** 作用域（缺省按 root 推断——非空即 project，壳缺省同款） */
  readonly scope?: SettingsScope;
  /** 工具栏 ScopeSelect 上抛口（目标选择器，状态留壳层）：上抛新目标项目 root 字符串
   *  （'' = 全局）；未接（直接渲染/桩测）时切换不回写 */
  readonly onScopeChange?: (targetRoot: string) => void;
  /** 目标选择器选项面（壳下发：全局+全部注册项目按名；未接=直渲/桩测缺省 全局+当前 root） */
  readonly scopeOptions?: readonly ScopeOption[];
  /** config-changed 订阅 tick（teams 资源计数——外部改动信号，变化即重拉） */
  readonly refreshTick?: number;
}

export function TeamsPane({ conn, root = '', scope, onScopeChange, scopeOptions, refreshTick }: TeamsPaneProps): JSX.Element {
  const [data, setData] = useState<TeamsView | null>(null);
  const [known, setKnown] = useState<{ builtins: BuiltinRole[]; view: AgentsView }>({ builtins: [], view: { entries: [], warnings: [] } });
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [form, setForm] = useState<TeamFormState | null>(null);
  const [formError, setFormError] = useState('');
  /** 卡面章程详情全文缓存(2026-11-05 用户裁定:详情展开=320px 固定高纵滚,编辑器同高)——
   *  key=`${source}:${id}`;展开首拍拉 teamBody 全文,失败回退 bodyPreview(防重拉循环) */
  const [bodyMap, setBodyMap] = useState<Record<string, string>>({});

  /** 作用域裁定：壳下发优先，缺省按 root 推断（壳缺省同款——无 root 强制 global） */
  const myScope: SettingsScope = scope ?? (root === '' ? 'global' : 'project');
  /** 读面取参：project 作用域带 root（两级清单），global 作用域省参（仅全局清单） */
  const fetchRoot = myScope === 'project' && root !== '' ? root : undefined;

  const load = useCallback((): void => {
    conn.teamsView(fetchRoot).then(
      (v) => {
        setData(v.view);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
    // 成员复选数据源（known agents）：选择器辅助面——读失败静默降级空集（teams 主面不受牵连，
    // 复选列表空、手输 extra id 兜底仍在）
    conn.agentsView(fetchRoot).then(setKnown, () => setKnown({ builtins: [], view: { entries: [], warnings: [] } }));
  }, [conn, fetchRoot]);

  useEffect(() => {
    load();
  }, [load, refreshTick]); // refreshTick 变化=外部改动信号 → 重拉（config-changed teams 键消费面）

  /** 已知 agent id 面（成员复选数据源，R3）：builtins 四角色先+注册清单后，按 id 去重保首现 */
  const seenKnown = new Set<string>();
  const knownAgents: Array<{ id: string; name: string }> = [];
  for (const b of known.builtins) {
    if (!seenKnown.has(b.role)) {
      seenKnown.add(b.role);
      knownAgents.push({ id: b.role, name: b.name });
    }
  }
  for (const e of known.view.entries) {
    if (!seenKnown.has(e.id)) {
      seenKnown.add(e.id);
      knownAgents.push({ id: e.id, name: e.name });
    }
  }

  /** 写作用域守卫（AgentsPane 同款）：project 卡=project 作用域且有 root；global 卡=global 作用域
   *  （被遮蔽卡只出现在 project 视图，天然不可写）。不可写卡：开关不下发+Edit/Delete disabled */
  const canWrite = (e: TeamEntryView): boolean =>
    e.source === 'project' ? myScope === 'project' && root !== '' : myScope === 'global';

  /** op 输入按卡作用域取参单点：project 带 root、global 省参（input 原文即请求体，不留空串伪参） */
  const opFor = (e: TeamEntryView, op: Extract<TeamsOpInput, { op: 'enable' | 'disable' | 'delete' }>['op']): TeamsOpInput => ({
    op,
    scope: e.source,
    ...(e.source === 'project' ? { root } : {}),
    id: e.id,
  });

  /** op 写回收口单点（runOp 同款）：saving 门 → putTeamOp → 成功重拉（失败 saving 复位+行内
   *  错误条；409 hint 由 errText 呈现 status 行） */
  const runOp = (input: TeamsOpInput): void => {
    if (saving) return;
    setSaving(true);
    setActionError('');
    conn
      .putTeamOp(input)
      .then(() => {
        setSaving(false);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setActionError(errText(err));
      });
  };

  /** 启停开关渲染判据（REST 富化 gating）：enabled 恒布尔契约的字段在场才出开关——daemon 缺键
   *  不渲染（无误导态）；可写性另乘 canWrite */
  const switchOf = (e: TeamEntryView): (() => void) | undefined => {
    if (typeof e.enabled !== 'boolean' || !canWrite(e)) return undefined;
    return () => runOp(opFor(e, e.enabled === false ? 'enable' : 'disable'));
  };

  /** 全文装载（G8d-T3 同款）：teamBody(source,id,root) 成功 → 章程升级全文（用户已动手改写则
   *  不覆盖，以其输入为准）；失败 → 回退预览态（bodyPreview 已播种）+ 行内提示（截断守卫兜底
   *  生效）。晚到的装载失败不覆盖其后已示出的保存面错误——仅空错误位时落 */
  const seedFullBody = (d: DrawerState): void => {
    conn.teamBody(d.source, d.id, root === '' ? undefined : root).then(
      ({ body }) => {
        setForm((f) =>
          f !== null && f.editing && f.id === d.id && f.body === f.seededBody
            ? { ...f, body, seededBody: body, bodyFull: true }
            : f,
        );
      },
      (err: unknown) => {
        const msg = t(`Failed to load full body; fell back to preview: ${errText(err)}`, `章程全文装载失败,已回退预览:${errText(err)}`);
        setFormError((prev) => (prev === '' ? msg : prev));
      },
    );
  };

  /** 弹窗打开：add=空表单（写作用域=壳 scope；enabled 缺省 true）；edit=卡字段播种（id 锁定；
   *  成员=已知集内勾选+集外落入 extra 手输）+全文装载升级 */
  const openDrawer = (e: TeamEntryView | null): void => {
    setFormError('');
    if (e === null) {
      setForm({ editing: false, id: '', name: '', description: '', version: '', members: [], extraMembers: '', lead: '', enabled: true, body: '', seededBody: '', bodyFull: false });
      setDrawer({ mode: 'add', source: myScope, id: '' });
      return;
    }
    const knownIds = new Set(knownAgents.map((k) => k.id));
    setForm({
      editing: true,
      id: e.id,
      name: e.name,
      description: e.description ?? '',
      version: e.version ?? '',
      members: e.members.filter((m) => knownIds.has(m)),
      extraMembers: e.members.filter((m) => !knownIds.has(m)).join(' '),
      lead: e.lead ?? '',
      enabled: e.enabled !== false,
      body: e.bodyPreview,
      seededBody: e.bodyPreview,
      bodyFull: false,
    });
    const d: DrawerState = { mode: 'edit', source: e.source, id: e.id };
    setDrawer(d);
    seedFullBody(d); // 全文装载升级（失败回退预览+行内提示）
  };

  /** 弹窗保存（op upsert 单点）：id kebab 词法（新增态）/name 必填/成员合并非空/截断守卫（全文
   *  装载失败兜底）→ putTeamOp → 成功关弹窗+重拉（失败 saving 复位+行内错误条）。缺省字段不落
   *  请求体：description/version 空串省略；lead 失效（∉ members）省略——lead ∈ members 提交守卫；
   *  enabled 恒显式落（启停是一等状态，非缺省省略键） */
  const submitDrawer = (): void => {
    if (drawer === null || form === null || saving) return;
    const id = form.id.trim();
    const name = form.name.trim();
    if (!form.editing && !TEAM_ID_RE.test(id)) {
      setFormError(t('id must match /^[a-z0-9]+(-[a-z0-9]+)*$/ (used as a directory name)', 'id 须匹配 /^[a-z0-9]+(-[a-z0-9]+)*$/(用作目录名)'));
      return;
    }
    if (name === '') {
      setFormError(t('name is required (first frontmatter key)', 'name 必填(frontmatter 首键)'));
      return;
    }
    const members = mergeMembers(form.members, form.extraMembers);
    if (members.length === 0) {
      setFormError(t('frontmatter.members required (non-empty array of agent ids)', 'members 必填(非空 agent id 数组)'));
      return;
    }
    /** 截断守卫（agents 同款兜底面）：播种面是 bodyPreview（200 字切片）时，长度触帽即原文可能
     *  被截，未改章程（仍=播种值）直接保存会把截断文写盘毁掉余文；用户已改写（≠播种值）=有意
     *  重写放行。bodyFull（全文装载成功）无截断风险——守卫退役。 */
    if (form.editing && !form.bodyFull && form.seededBody.length >= BODY_PREVIEW_CAP && form.body === form.seededBody) {
      setFormError(t(`Body may exceed ${BODY_PREVIEW_CAP} chars and was preview-truncated — rewrite the full body before saving, or edit teams/${id}/team.md directly`, `原文可能超过 ${BODY_PREVIEW_CAP} 字符已被预览截断——请改写完整章程后保存,或直接编辑 teams/${id}/team.md 文件`));
      return;
    }
    const frontmatter: TeamFrontmatterInput = { name, members, enabled: form.enabled };
    if (form.description.trim() !== '') frontmatter.description = form.description.trim();
    if (form.version.trim() !== '') frontmatter.version = form.version.trim();
    if (form.lead !== '' && members.includes(form.lead)) frontmatter.lead = form.lead; // 失效 lead 不落键
    setSaving(true);
    setFormError('');
    const scopeArg = drawer.source;
    conn
      .putTeamOp({ op: 'upsert', scope: scopeArg, ...(scopeArg === 'project' ? { root } : {}), id, frontmatter, body: form.body })
      .then(() => {
        setSaving(false);
        setDrawer(null);
        setForm(null);
        load(); // 保存后重拉（两级清单+遮蔽重算）
      })
      .catch((err: unknown) => {
        setSaving(false);
        setFormError(errText(err)); // 400 校验面/409 写面原文行内
      });
  };

  const scopeTag = (source: TeamEntryView['source']): string => (source === 'project' ? t('Project', '项目') : t('Global', '全局'));

  /** 过滤面：id/name/description 大小写不敏感包含 */
  const needle = query.trim().toLowerCase();
  const match = (text: string): boolean => needle === '' || text.toLowerCase().includes(needle);
  /** 显示副本排序（ledger 裁定）：wire 序 global→project → pane 排 project 先（仅显示序；
   *  op 按行 source 取参不受影响） */
  const ordered = [...(data?.entries ?? [])].sort((a, b) => (a.source === b.source ? 0 : a.source === 'project' ? -1 : 1));
  const visible = ordered.filter((e) => match(`${e.id} ${e.name} ${e.description ?? ''}`));

  /** 卡 chips：成员逐个（missing=不在 agents 生效集 → sx-chip-missing 警示描边）+遮蔽标注 */
  const chipsOf = (e: TeamEntryView): ReactNode => (
    <>
      {e.members.map((m) => (
        <span key={m} className={e.missing.includes(m) ? 'sx-chip sx-chip-missing' : 'sx-chip'}>{m}</span>
      ))}
      {e.shadowed && <span className="sx-shadow-tag">{t('Shadowed by project', '被项目遮蔽')}</span>}
    </>
  );

  /** lead Select 选项=当前合并 members（随勾选/手输实时变——失效选项即时消失） */
  const mergedPreview = form !== null ? mergeMembers(form.members, form.extraMembers) : [];

  return (
    <section className="sx-settings-form" aria-label="settings pane teams">
      <h2>{t('Agent Teams', '智能体团队')}</h2>
      <div className="sx-res-toolbar">
        <ScopeSelect value={myScope === 'project' ? root : ''} options={scopeOptions ?? defaultScopeOptions(root)} onChange={(v) => onScopeChange?.(v)} />
        <SearchBar value={query} onChange={setQuery} placeholder={t('Search teams', '搜索团队')} />
        <button type="button" className="sx-add-button" onClick={() => openDrawer(null)}>
          {t('+ New', '+ 新增')}
        </button>
      </div>
      {loadError !== '' && <ErrorBanner text={loadError} />}
      {actionError !== '' && <ErrorBanner text={actionError} />}
      {data === null && loadError === '' && <EmptyState text={t('Loading teams…', '加载团队清单…')} />}
      {data !== null && (
        <>
          {(data.entries.length === 0 || visible.length === 0) && (
            <EmptyState text={data.entries.length === 0 ? t('No teams.', '无团队。') : t('No matches.', '无匹配结果。')} />
          )}
          <ul className="sx-rc-list">
            {visible.map((e) => {
              const writable = canWrite(e);
              const toggle = switchOf(e);
              const globalTip = t('Switch to Global scope to edit', '切到全局作用域可编辑');
              return (
                <ResourceCard
                  key={`${e.source}:${e.id}`}
                  title={e.id}
                  subtitle={e.name}
                  chips={chipsOf(e)}
                  badge={{ source: e.source }}
                  enabled={typeof e.enabled === 'boolean' ? e.enabled : undefined}
                  onToggle={toggle}
                  actions={
                    <>
                      <button
                        type="button"
                        aria-label={`${t('Edit', '编辑')} ${e.id}(${scopeTag(e.source)})`}
                        disabled={!writable || saving}
                        data-tip={writable ? undefined : globalTip}
                        onClick={() => openDrawer(e)}
                      >
                        {t('Edit', '编辑')}
                      </button>
                      <ConfirmDeleteButton
                        ariaLabel={`${t('Delete', '删除')} ${e.id}(${scopeTag(e.source)})`}
                        disabled={!writable || saving}
                        dataTip={writable ? undefined : globalTip}
                        onConfirm={() => runOp(opFor(e, 'delete'))}
                      />
                      {/* 2026-11-07 用户裁定「详情按钮放删除同行最右侧;点击展开描述+章程」:
                          details 经 display:contents 入操作行,summary 推到行最右,展开面整行折下;
                          章程懒加载同前(320px 纵滚,失败回退预览) */}
                      <details
                        className="sx-team-body"
                        onToggle={(ev) => {
                          if (!(ev.target as HTMLDetailsElement).open) return;
                          const key = `${e.source}:${e.id}`;
                          if (bodyMap[key] !== undefined) return;
                          conn.teamBody(e.source, e.id, root === '' ? undefined : root).then(
                            (r) => setBodyMap((m) => ({ ...m, [key]: r.body })),
                            () => setBodyMap((m) => ({ ...m, [key]: e.bodyPreview })),
                          );
                        }}
                      >
                        <summary>
                          {t('Details', '详情')}
                          <ChevronDown size={16} strokeWidth={2} className="sx-disc-chev" aria-hidden="true" />
                        </summary>
                        <div className="sx-team-detail">
                          {e.description !== undefined && <p className="sx-agent-desc">{e.description}</p>}
                          <ClampBlock as="pre">{bodyMap[`${e.source}:${e.id}`] ?? e.bodyPreview}</ClampBlock>
                        </div>
                      </details>
                    </>
                  }
                />
              );
            })}
          </ul>
          {data.warnings.map((w) => (
            <ErrorBanner key={w} text={w} />
          ))}
        </>
      )}
      {drawer !== null && form !== null && (
        <EditorModal
          open
          title={drawer.mode === 'add' ? t('New team', '新增团队') : t(`Edit ${drawer.id}`, `编辑 ${drawer.id}`)}
          onClose={() => {
            setDrawer(null);
            setForm(null);
          }}
          onSubmit={submitDrawer}
        >
          <ModalField label="id">
            <input className="sx-setting-input" aria-label="team id" value={form.id} readOnly={form.editing} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="core-team" spellCheck={false} />
          </ModalField>
          <ModalField label="name">
            <input className="sx-setting-input" aria-label="team name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} spellCheck={false} />
          </ModalField>
          <ModalField label="description">
            <input className="sx-setting-input" aria-label="team description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} spellCheck={false} />
          </ModalField>
          <ModalField label={t('version (optional)', 'version(可选)')}>
            <input className="sx-setting-input" aria-label="team version" value={form.version} placeholder="0.1.0" onChange={(e) => setForm({ ...form, version: e.target.value })} spellCheck={false} />
          </ModalField>
          {/* R3 成员组合形态：已知 agent id 复选列表（builtins 四角色+注册清单，`id — name`）
              + 额外 id 手输（空格分隔）——提交合并去重保首现（submitDrawer 单点） */}
          <ModalField label={t('Members (known agents)', '成员(已知智能体)')}>
            <div className="sx-team-members">
              {knownAgents.map((k) => (
                <label key={k.id} className="sx-drawer-field sx-check-row">
                  <input
                    type="checkbox"
                    aria-label={`team member ${k.id}`}
                    checked={form.members.includes(k.id)}
                    onChange={(e) => setForm({ ...form, members: e.target.checked ? [...form.members, k.id] : form.members.filter((m) => m !== k.id) })}
                  />
                  {`${k.id} — ${k.name}`}
                </label>
              ))}
              {knownAgents.length === 0 && <span className="sx-agent-desc">{t('No known agents; type ids below.', '无已知智能体;请在下方手输 id。')}</span>}
            </div>
          </ModalField>
          <ModalField label={t('Extra members (space-separated)', '额外成员(空格分隔)')} hint={t('Agent ids not listed above', '上方未列出的 agent id')}>
            <input className="sx-setting-input" aria-label="team extra members" value={form.extraMembers} onChange={(e) => setForm({ ...form, extraMembers: e.target.value })} spellCheck={false} />
          </ModalField>
          <ModalField label={t('Team leader', '团队领导者')}>
            <Select
              ariaLabel="team lead"
              value={form.lead}
              options={[{ v: '', l: t('None', '无') }, ...mergedPreview.map((m) => ({ v: m, l: m }))]}
              onChange={(v) => setForm({ ...form, lead: v })}
            />
          </ModalField>
          <label className="sx-drawer-field sx-check-row">
            <input type="checkbox" aria-label="team enabled" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            {t('enabled (takes effect in new sessions)', 'enabled(新会话装配生效)')}
          </label>
          <ModalField label={t('Body (team.md charter)', '章程(team.md body)')}>
            <textarea aria-label="team body" className="sx-team-body-editor" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} spellCheck={false} />
          </ModalField>
          {formError !== '' && <ErrorBanner text={formError} />}
        </EditorModal>
      )}
    </section>
  );
}
