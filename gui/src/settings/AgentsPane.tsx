import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { AgentEntryView, AgentFrontmatterInput, AgentsOpInput, AgentsView, BuiltinRole } from '../connection';
import { ConfirmDeleteButton, EditorModal, EmptyState, ErrorBanner, ModalField, ResourceCard, ScopeSelect, SearchBar, defaultScopeOptions } from './components';
import type { SettingsScope, ScopeOption } from './components';
import { Select } from './controls';

/**
 * Task 23 AgentsPane 重构（Phase F 第二面板，2026-10-28）：一屏式卡片列表——写面统一走
 * PUT /settings/agents 的 op 四值（T15 在既有 handleAgentsPut 端点扩 enable|disable；
 * agents 面无 mcp 式独立 /op 端点，经 conn.putAgentOp），原「内联 <form> 表单」路径退役。
 *
 * 结构（T21 共享组件 verbatim 消费，McpPane 参照实现同款）：工具栏三件套（2026-10-29 用户
 * 裁定入页：ScopeSelect 作用域下拉+SearchBar（200ms 防抖过滤
 * id/name/description，弹性）+「+ New」钮一行）；主体 ul.sx-rc-list × ResourceCard（title=id 注册表键/
 * subtitle=name/chips=memory·isolation·executor 属性+shadowed 标注/badge=
 * SourceBadge/折叠详情=bodyPreview）；增改 → EditorModal 居中模态（2026-10-29 用户裁定：
 * 弹窗替换右滑抽屉；id 编辑态锁定——id 是
 * 目录名/name/description/memory checkbox/isolation/executor/body textarea，无本地 scope
 * select——写作用域随壳）。2026-10-30 用户裁定（弹窗对齐主设置面风格）：字段面改 ModalField
 * 表单行（标签行+控件行纵向）；isolation/executor 自由输入换共享 Select（闭集=daemon 写面
 * 枚举守卫同域：isolation 仅 worktree、executor 仅 internal-team|external-cli，''=Unset
 * 显式项保「空即键不落」提交形状零变化）。
 *
 * 作用域语义（壳下发：scope + onScopeChange——工具栏 ScopeSelect 只上抛，状态留壳，McpPane 同款）：scope='project'（缺省，有 root 时）读
 * 两级清单（GET 带 root，项目先全局后）；scope='global' 读仅全局清单（GET 省参）。root=''
 * 恒强制 global。卡可写判据（McpPane canWrite 同款）：project 卡=project 作用域且有 root，
 * global 卡=global 作用域（被遮蔽卡只出现在 project 视图，天然不可写）。
 *
 * 启停（Task 15 op 面，REST 富化 gating）：daemon GET 尚未透出 enabled
 * （subagent.ts loadAgentsView「GUI 富化属后续 REST 改面」预留），GUI 侧契约就绪、字段在场
 * 才渲染——enabled 恒布尔（缺省 true 由富化 daemon 显式化）的行出启停开关（切停=op disable、
 * 复启=op enable，新会话生效——agents 装配期语义）。现 daemon（缺键）不渲染：无误导态，
 * 富化落地 GUI 零改动自动点亮。
 *
 * 编辑播种沿 G8d-T3 全文装载：编辑钮先以 bodyPreview 播种（即时开抽屉），再 conn.agentBody
 * 拉 agent.md 正文全文升级播种——成功则截断守卫对该抽屉退役；失败回退 bodyPreview+行内提示。
 * 截断守卫（G8c 终审 A）保留为兜底：播种面触 200 字截断帽且未改写 → 阻断保存行内示错（防
 * 截断文写盘毁余文）；已改写=有意重写放行。frontmatter 缺省键不落请求体（name 必填；空串
 * 可选键省略；memory 仅 true 落）——与 daemon「input 原文即请求体」契约对齐。
 *
 * 错误面三分：loadError=读面失败/actionError=op 写面失败（含 409 hint 经 errText 呈现）/
 * formError=抽屉校验与保存失败，均 ErrorBanner 行内。saving 门单点：写面在途禁再发。
 * config-changed 订阅：壳下发 refreshTick（agents 资源计数）变化即重拉（外部改动信号，零轮询）。
 */

/** 智能体面连接面（结构满足即收，App 传整只 Connection）；putAgentOp=T15 op 端点写面 */
export interface AgentsPaneConn {
  agentsView(root?: string): Promise<{ builtins: BuiltinRole[]; view: AgentsView }>;
  putAgentOp(input: AgentsOpInput): Promise<void>;
  /** G8d-T3 正文全文（agent.md frontmatter 后正文；编辑播种升级面） */
  agentBody(scope: 'project' | 'global', id: string, root?: string): Promise<{ body: string }>;
}

/** id 安全面（daemon AGENT_ID_RE 同款：id 拼目录路径——路径分隔/点开头一律拒） */
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** daemon bodyPreview 截断帽（subagent.ts slice(0,200) 同款）：长度触帽即原文可能被截——编辑守卫判据 */
const BODY_PREVIEW_CAP = 200;

/** 抽屉表单态（受控单对象；edit=true 时 id 锁定。seededBody=编辑播种的正文原文——截断守卫
 *  比对基线；bodyFull=true 表示已升级全文装载，守卫对该抽屉退役） */
interface AgentFormState {
  readonly editing: boolean;
  readonly id: string;
  name: string;
  description: string;
  memory: boolean;
  isolation: string;
  executor: string;
  body: string;
  /** 编辑播种的正文原文——save 守卫判「用户是否已改写」的基线 */
  readonly seededBody: string;
  /** true = 正文已升级为 agent.md 全文（agentBody 成功）——无截断风险，守卫退役 */
  readonly bodyFull: boolean;
}

/** 抽屉会话态：add=新增（source=写作用域=壳 scope）；edit=编辑某卡（source=卡 source——可写卡
 *  的 source 与壳作用域一致，见 canWrite） */
type DrawerState = { mode: 'add' | 'edit'; source: 'project' | 'global'; id: string };

export interface AgentsPaneProps {
  readonly conn: AgentsPaneConn;
  /** 作用域目标项目 root（壳下发 targetRoot——下拉选哪个项目即锚哪个；'' = 全局作用域） */
  readonly root: string;
  /** T21 设置壳注入：作用域（缺省按 root 推断——非空即 project，壳缺省同款） */
  readonly scope?: SettingsScope;
  /** 2026-10-29 工具栏 ScopeSelect 上抛口（目标选择器，状态留壳层）：上抛新目标项目 root
   *  字符串（'' = 全局）；未接（直接渲染/桩测）时切换不回写 */
  readonly onScopeChange?: (targetRoot: string) => void;
  /** 2026-10-29 目标选择器选项面（壳下发：全局+全部注册项目按名；未接=直渲/桩测缺省 全局+当前 root） */
  readonly scopeOptions?: readonly ScopeOption[];
  /** T21 config-changed 订阅 tick（agents 资源计数——外部改动信号，变化即重拉） */
  readonly refreshTick?: number;
}

export function AgentsPane({ conn, root, scope, onScopeChange, scopeOptions, refreshTick }: AgentsPaneProps): JSX.Element {
  const [data, setData] = useState<{ builtins: BuiltinRole[]; view: AgentsView } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [form, setForm] = useState<AgentFormState | null>(null);
  const [formError, setFormError] = useState('');

  /** 作用域裁定：壳下发优先，缺省按 root 推断（壳缺省同款——无 root 强制 global） */
  const myScope: SettingsScope = scope ?? (root === '' ? 'global' : 'project');
  /** 读面取参：project 作用域带 root（两级清单），global 作用域省参（仅全局清单） */
  const fetchRoot = myScope === 'project' && root !== '' ? root : undefined;

  const load = useCallback((): void => {
    conn.agentsView(fetchRoot).then(
      (v) => {
        setData(v);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn, fetchRoot]);

  useEffect(() => {
    load();
  }, [load, refreshTick]); // refreshTick 变化=外部改动信号 → 重拉（config-changed 订阅消费面）

  /** 写作用域守卫（McpPane 同款）：project 卡=project 作用域且有 root；global 卡=global 作用域
   *  （被遮蔽卡只出现在 project 视图，天然不可写）。不可写卡：开关不下发+Edit/Delete disabled */
  const canWrite = (e: AgentEntryView): boolean =>
    e.source === 'project' ? myScope === 'project' && root !== '' : myScope === 'global';

  /** op 输入按卡作用域取参单点：project 带 root、global 省参（input 原文即请求体，不留空串伪参） */
  const opFor = (e: AgentEntryView, op: Extract<AgentsOpInput, { op: 'enable' | 'disable' | 'delete' }>['op']): AgentsOpInput =>
    op === 'delete'
      ? { op: 'delete', scope: e.source, ...(e.source === 'project' ? { root } : {}), id: e.id }
      : { op, scope: e.source, ...(e.source === 'project' ? { root } : {}), id: e.id };

  /** op 写回收口单点（McpPane runOp 同款）：saving 门 → putAgentOp → 成功重拉（失败 saving
   *  复位+行内错误条；409 hint 由 errText 呈现 status 行） */
  const runOp = (input: AgentsOpInput): void => {
    if (saving) return;
    setSaving(true);
    setActionError('');
    conn
      .putAgentOp(input)
      .then(() => {
        setSaving(false);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setActionError(errText(err));
      });
  };

  /** 启停开关渲染判据（REST 富化 gating）：enabled 恒布尔契约的字段在场才出开关——现 daemon
   *  （缺键）不渲染（无误导态），富化 daemon 落地即自动点亮；可写性另乘 canWrite */
  const switchOf = (e: AgentEntryView): (() => void) | undefined => {
    if (typeof e.enabled !== 'boolean' || !canWrite(e)) return undefined;
    return () => runOp(opFor(e, e.enabled === false ? 'enable' : 'disable'));
  };

  /** G8d-T3 全文装载：agentBody(source,id,root) 成功 → 正文升级全文（用户已动手改写则不覆盖，
   *  以其输入为准）；失败 → 回退预览态（bodyPreview 已播种）+ 行内提示（截断守卫兜底生效）。 */
  const seedFullBody = (d: DrawerState): void => {
    conn.agentBody(d.source, d.id, root === '' ? undefined : root).then(
      ({ body }) => {
        setForm((f) =>
          f !== null && f.editing && f.id === d.id && f.body === f.seededBody
            ? { ...f, body, seededBody: body, bodyFull: true }
            : f,
        );
      },
      (err: unknown) => {
        // 晚到的装载失败不覆盖其后已示出的保存面错误（截断守卫/服务端 400）——仅空错误位时落
        const msg = t(`Failed to load full body; fell back to preview: ${errText(err)}`, `正文全文装载失败,已回退预览:${errText(err)}`);
        setFormError((prev) => (prev === '' ? msg : prev));
      },
    );
  };

  /** 抽屉打开：add=空表单（写作用域=壳 scope）；edit=卡字段播种（id 锁定）+全文装载升级 */
  const openDrawer = (e: AgentEntryView | null): void => {
    setFormError('');
    if (e === null) {
      setForm({ editing: false, id: '', name: '', description: '', memory: false, isolation: '', executor: '', body: '', seededBody: '', bodyFull: false });
      setDrawer({ mode: 'add', source: myScope, id: '' });
      return;
    }
    setForm({
      editing: true,
      id: e.id,
      name: e.name,
      description: e.description ?? '',
      memory: e.memory === true,
      isolation: e.isolation ?? '',
      executor: e.executor ?? '',
      body: e.bodyPreview,
      seededBody: e.bodyPreview,
      bodyFull: false,
    });
    const d: DrawerState = { mode: 'edit', source: e.source, id: e.id };
    setDrawer(d);
    seedFullBody(d); // G8d-T3：全文装载升级（失败回退预览+行内提示）
  };

  /** 抽屉保存（op upsert 单点）：id 安全面（新增态）/name 必填/截断守卫（全文装载失败兜底）→
   *  putAgentOp → 成功关抽屉+重拉（失败 saving 复位+行内错误条）。缺省字段不落请求体：可选键
   *  空串省略、memory 仅 true 落（daemon 单行 KV 词法约束） */
  const submitDrawer = (): void => {
    if (drawer === null || form === null || saving) return;
    const id = form.id.trim();
    const name = form.name.trim();
    if (!form.editing && !AGENT_ID_RE.test(id)) {
      setFormError(t('id must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/ (used as directory name)', 'id 须匹配 /^[A-Za-z0-9][A-Za-z0-9_-]*$/(用作目录名)'));
      return;
    }
    if (name === '') {
      setFormError(t('name is required (first frontmatter key)', 'name 必填(frontmatter 首键)'));
      return;
    }
    /** G8c 终审 A 截断守卫（全文装载失败的兜底面）：播种面是 bodyPreview（200 字切片）时，长度
     *  触帽即原文可能被截，未改正文（仍=播种值）直接保存会把截断文写盘毁掉余文；用户已改写
     *  （≠播种值）=有意重写放行。bodyFull（全文装载成功）无截断风险——守卫退役。 */
    if (form.editing && !form.bodyFull && form.seededBody.length >= BODY_PREVIEW_CAP && form.body === form.seededBody) {
      setFormError(t(`Body may exceed ${BODY_PREVIEW_CAP} chars and was preview-truncated — rewrite the full body before saving, or edit agents/${id}/agent.md directly`, `原文可能超过 ${BODY_PREVIEW_CAP} 字符已被预览截断——请改写完整正文后保存,或直接编辑 agents/${id}/agent.md 文件`));
      return;
    }
    const frontmatter: AgentFrontmatterInput = { name };
    if (form.description.trim() !== '') frontmatter.description = form.description.trim();
    if (form.memory) frontmatter.memory = true;
    if (form.isolation.trim() !== '') frontmatter.isolation = form.isolation.trim();
    if (form.executor.trim() !== '') frontmatter.executor = form.executor.trim();
    setSaving(true);
    setFormError('');
    const scopeArg = drawer.source;
    conn
      .putAgentOp({ op: 'upsert', scope: scopeArg, ...(scopeArg === 'project' ? { root } : {}), id, frontmatter, body: form.body })
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

  const scopeTag = (source: AgentEntryView['source']): string => (source === 'project' ? t('Project', '项目') : t('Global', '全局'));

  /** 过滤面：id/name/description 大小写不敏感包含（builtins 按 role/name 同径过滤） */
  const needle = query.trim().toLowerCase();
  const match = (text: string): boolean => needle === '' || text.toLowerCase().includes(needle);
  const builtins = (data?.builtins ?? []).filter((b) => match(`${b.role} ${b.name}`));
  const visible = (data?.view.entries ?? []).filter((e) => match(`${e.id} ${e.name} ${e.description ?? ''}`));

  /** 卡 chips：memory/isolation/executor 属性 + 遮蔽标注（shadowed 沿现数据） */
  const chipsOf = (e: AgentEntryView): ReactNode => (
    <>
      {e.memory === true && <span className="sx-chip">memory</span>}
      {e.isolation !== undefined && <span className="sx-chip">{`isolation:${e.isolation}`}</span>}
      {e.executor !== undefined && <span className="sx-chip">{`executor:${e.executor}`}</span>}
      {e.shadowed && <span className="sx-shadow-tag">{t('Shadowed by project', '被项目遮蔽')}</span>}
    </>
  );

  return (
    <section className="sx-settings-form" aria-label="settings pane agents">
      <h2>{t('Agents', '智能体')}</h2>
      <div className="sx-res-toolbar">
        <ScopeSelect value={myScope === 'project' ? root : ''} options={scopeOptions ?? defaultScopeOptions(root)} onChange={(v) => onScopeChange?.(v)} />
        <SearchBar value={query} onChange={setQuery} placeholder={t('Search agents', '搜索智能体')} />
        <button type="button" className="sx-add-button" onClick={() => openDrawer(null)}>
          {t('+ New', '+ 新增')}
        </button>
      </div>
      {loadError !== '' && <ErrorBanner text={loadError} />}
      {actionError !== '' && <ErrorBanner text={actionError} />}
      {data === null && loadError === '' && <EmptyState text={t('Loading agents…', '加载智能体清单…')} />}
      {data !== null && (
        <>
          <h3>{t('Built-in roles (read-only)', '内建角色(只读)')}</h3>
          {builtins.length === 0 && <EmptyState text={t('No built-in roles match.', '无匹配的内建角色。')} />}
          <ul className="sx-agent-builtins">
            {builtins.map((b) => (
              <li key={b.role} className="sx-agent-builtin">
                <div className="sx-agent-head">
                  <span className="sx-agent-id">{b.role}</span>
                  <span className="sx-agent-name">{b.name}</span>
                </div>
                <p className="sx-agent-desc">{b.framing}</p>
              </li>
            ))}
          </ul>
          <h3>{t('Registered (agents directory)', '已注册(agents 目录)')}</h3>
          {(data.view.entries.length === 0 || visible.length === 0) && (
            <EmptyState text={data.view.entries.length === 0 ? t('No custom agents.', '无自定义智能体。') : t('No matches.', '无匹配结果。')} />
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
                    </>
                  }
                >
                  {e.description !== undefined && <p className="sx-agent-desc">{e.description}</p>}
                  <pre>{e.bodyPreview}</pre>
                </ResourceCard>
              );
            })}
          </ul>
        {data.view.warnings.map((w) => (
            <ErrorBanner key={w} text={w} />
          ))}
        </>
      )}
      {drawer !== null && form !== null && (
        <EditorModal
          open
          title={drawer.mode === 'add' ? t('New agent', '新增智能体') : t(`Edit ${drawer.id}`, `编辑 ${drawer.id}`)}
          onClose={() => {
            setDrawer(null);
            setForm(null);
          }}
          onSubmit={submitDrawer}
        >
          {/* 2026-10-30 用户裁定:弹窗字段面改 ModalField 表单行(标签行+控件行纵向,对齐主设置面);
              isolation/executor 原生自由输入换共享 Select(闭集=daemon 写面枚举守卫同域:
              isolation 仅 worktree、executor 仅 internal-team|external-cli——catalog/agents.ts
              写面即拒越型值;''=Unset 显式项保「清空即键不落」提交形状零变化) */}
          <ModalField label="id">
            <input className="sx-setting-input" aria-label="agent id" value={form.id} readOnly={form.editing} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="writer" spellCheck={false} />
          </ModalField>
          <ModalField label="name">
            <input className="sx-setting-input" aria-label="agent name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} spellCheck={false} />
          </ModalField>
          <ModalField label="description">
            <input className="sx-setting-input" aria-label="agent description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} spellCheck={false} />
          </ModalField>
          <label className="sx-drawer-field sx-check-row">
            <input type="checkbox" aria-label="agent memory" checked={form.memory} onChange={(e) => setForm({ ...form, memory: e.target.checked })} />
            {t('memory (own memory)', 'memory(自有记忆)')}
          </label>
          <ModalField label="isolation">
            <Select
              ariaLabel="agent isolation"
              value={form.isolation}
              options={[
                { v: '', l: t('Default', '默认') },
                { v: 'worktree', l: 'worktree' },
              ]}
              onChange={(v) => setForm({ ...form, isolation: v })}
            />
          </ModalField>
          <ModalField label="executor">
            <Select
              ariaLabel="agent executor"
              value={form.executor}
              options={[
                { v: '', l: t('Default', '默认') },
                { v: 'internal-team', l: 'internal-team' },
                { v: 'external-cli', l: 'external-cli' },
              ]}
              onChange={(v) => setForm({ ...form, executor: v })}
            />
          </ModalField>
          <ModalField label={t('Body (agent.md body)', '正文(agent.md body)')}>
            <textarea aria-label="agent body" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={4} spellCheck={false} />
          </ModalField>
          {formError !== '' && <ErrorBanner text={formError} />}
        </EditorModal>
      )}
    </section>
  );
}
