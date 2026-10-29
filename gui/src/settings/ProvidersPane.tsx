import { Fragment, useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { SettingsForm } from './SettingsForm';
import type { SettingsFormConn, SettingsPaneDef } from './SettingsForm';
import { EditorModal, EmptyState, ErrorBanner, ResourceCard, ScopeSelect, SearchBar, defaultScopeOptions } from './components';
import type { SettingsScope, ScopeOption } from './components';
import type { ProviderEntry, ProviderOpInput, SettingsView } from '../connection';

/**
 * Task 26 ProvidersPane 重构(2026-10-28 spec §15 GUI 面,T22-25 同款骨架):模型与提供方面板
 * 一屏式提供方 ResourceCard 卡片列表——写面全部走 PUT /settings/providers/op 单条目操作端点
 * (Task 16),原「嵌 SettingsForm 模型档位散键 Combo/baseUrl 行 + providers 只读卡列表」路径
 * 整体退役(spec §15 散键退役裁定:providers 列表唯一事实源,服务端恒切 choices[0] 为默认)。
 *
 * 结构(T21 共享组件 verbatim 消费):上=SettingsForm 表单引擎复用(仅「请求参数」卡——tier/
 * reasoningEffort 两闭集下拉;**2026-10-29 用户裁定豁免:请求参数卡恒全局**——root 恒 ''
 * (读仅全局、写恒 global 桶),卡片标题带「(global)/(全局)」注明,不随工具栏目标选择器;
 * 「API 地址」行与模型散键四 Combo 删除——baseUrl 归提供方卡、模型归 models 行编辑);下=
 * 提供方卡列表(GET /settings providers.entries 源级分组逐卡:名称/baseUrl 副行/密钥状态点
 * (绿=env 槽在场/灰=缺,tip=槽名)/models chips(choices[0] 所属模型加「Default」chip=生效默认,
 * 服务端恒切 choices[0]——T11 裁定)/编辑/删除)。工具栏三件套(2026-10-29 用户裁定入页):
 * ScopeSelect 目标选择器下拉(全局+全部注册项目按名)+SearchBar(200ms 防抖,过滤 name/baseUrl,
 * 弹性)+「+ Add provider」钮一行;添加/编辑 → EditorModal 居中模态(2026-10-29 用户裁定:弹窗
 * 替换右滑抽屉;名称/Base URL/API key password 输入——写走 setKey op、密钥零回显(编辑播种恒
 * 空串,留空=不动键)/models 行编辑(模型名/contextWindow/reasoningEffort/tier select/上移下移
 * 钮——上移下移=文件级手术即时提交 modelMove op,成功后重拉+行重播种:以文件真值为基底按模型
 * 名键合保留本地未保存行字段编辑——模型名是键,改名/新增未落盘的行无法键合随 fresh 丢弃(弹窗
 * 提示行言明);行字段=本地态,Save 经 update op 整组替换 models)。
 *
 * 测试按钮裁定:v1 GUI 无提供方连通测试钮——REST 无 providers test 端点(不造端点),前端直连
 * baseUrl 需携密钥(密钥不进前端,违 D6);测试能力=CLI/TUI 面(T19/T20 已交付)。
 *
 * 作用域语义(壳下发:scope + onScopeChange——工具栏 ScopeSelect 只上抛,状态留壳,T22 同款):scope='project'(缺省,有 root 时)读带 root
 * (两级遮蔽链视图)、写 op scope='project' 带 root;scope='global' 读省参(仅全局)、写 scope=
 * 'global' 省参 root。root='' 恒强制 global。2026-10-29 目标选择器:root 由壳按下拉目标换发
 * (全局+全部注册项目可选,不限当前打开会话项目),本面卡读写逻辑零改动(内嵌请求参数卡除外
 * ——恒全局,见结构段)。entries 无 source 归因字段(GET 投影不分级)——
 * 卡写作用域恒随壳,且**须知整键遮蔽后果**:loadProvidersFull 是 providers 键整键遮蔽,project
 * 作用域下编辑一条全局回落条目(项目档无 providers 键时)= 按 upsert 语义在项目档创建 providers
 * 键,该键一旦在场即取代全局——**其余所有全局提供方被遮出有效链与本面板**(遮蔽是装载语义,
 * 面板无从呈现被遮项)。GUI 无法以现有数据自修(无 source 归因):规避靠用户切全局作用域编辑,
 * 根治归 daemon REST 富化后续任务(与 agents 富化同批——透出行级 source/shadowed 再做标注门)。
 *
 * 读面 T9 拆分(daemon handler 注释口径):entries=文件显式值(编辑回显走此面)、生效值看
 * choices(条目级 > 源级缺省)——卡片默认标记走 choices,抽屉播种走 entries;密钥面
 * (apiKeyEnv/apiKeyPresent)直读 entries 行富化字段(catalog listProviders 单点——含 models
 * 全畸形被跳过、choices 无行的源,密钥点不因呈现面缺行误灰)。
 *
 * 错误面三分 + saving 门单点(T22 同款):loadError(读)/actionError(卡写面)/formError(抽屉
 * 校验与保存,409 hint 经 errText 呈现引流 raw 编辑面),均 ErrorBanner 行内;写面在途禁再发。
 * config-changed 订阅:壳下发 refreshTick(providers 资源计数)变化即重拉(外部改动信号,零轮询)。
 */

/** 模型与提供方面板连接面(SettingsFormConn 复用——请求参数卡走既有语义键写路径;putProviderOp=
 *  Task 16 op 端点写面。结构满足即收,App 传整只 Connection) */
export interface ProvidersPaneConn extends SettingsFormConn {
  putProviderOp(input: ProviderOpInput): Promise<void>;
}

/** 请求参数卡(SettingsForm 复用):仅 tier/effort 两闭集下拉——模型档位散键四 Combo 与 baseUrl
 *  行退役(spec §15);键名与 daemon SEMANTIC_KEYS 逐字对齐,写路径 PUT /settings 原样保留。
 *  2026-10-29 用户裁定豁免:卡恒全局(标题带「(global)/(全局)」注明+说明行;root 恒 '',
 *  不随工具栏目标选择器——模型档位/思考强度是全局请求面) */
const PROVIDERS_PANE: SettingsPaneDef = {
  id: 'providers',
  title: { en: 'Models & providers', zh: '模型与提供方' },
  groups: [
    {
      title: { en: 'Request parameters (global)', zh: '请求参数(全局)' },
      desc: { en: 'Pinned to global scope — not affected by the project selector', zh: '恒全局作用域——不随项目选择器' },
      fields: [
        {
          key: 'tier',
          control: 'select',
          options: [
            { v: 'small', l: 'small' },
            { v: 'medium', l: 'medium' },
            { v: 'large', l: 'large' },
          ],
        },
        {
          key: 'reasoningEffort',
          control: 'select',
          options: [
            { v: 'none', l: 'none' },
            { v: 'minimal', l: 'minimal' },
            { v: 'low', l: 'low' },
            { v: 'medium', l: 'medium' },
            { v: 'high', l: 'high' },
            { v: 'xhigh', l: 'xhigh' },
            { v: 'max', l: 'max' },
          ],
        },
      ],
    },
  ],
};

/** models 行表单态(受控;contextWindow 暂存字符串保存时化型;''=未设置。supportsImages=
 *  条目显式值透传保全位——行编辑不建模该键,update 整组替换时原样带回防丢) */
interface ModelRow {
  model: string;
  contextWindow: string;
  reasoningEffort: string;
  tier: string;
  supportsImages?: boolean;
}

/** 抽屉表单态(受控单对象;apiKey 仅写不读——恒空串起步,提交非空才发 setKey) */
interface DrawerForm {
  name: string;
  baseUrl: string;
  apiKey: string;
  rows: ModelRow[];
}

/** 抽屉会话态:add=新增;edit=编辑某卡(original=改名换键的旧名)。写作用域随壳(source)——
 *  entries 无 source 归因,见头注 */
type DrawerState = { mode: 'add'; source: SettingsScope } | { mode: 'edit'; source: SettingsScope; original: string };

const EMPTY_ROW: ModelRow = { model: '', contextWindow: '', reasoningEffort: '', tier: '' };
const EMPTY_FORM: DrawerForm = { name: '', baseUrl: '', apiKey: '', rows: [{ ...EMPTY_ROW }] };

/** entries 源级分组 → 抽屉 models 行播种(文件显式值——T9 拆分:编辑回显不走 choices) */
const rowsOfEntry = (e: ProviderEntry): ModelRow[] =>
  e.models.map((m) => ({
    model: m.model,
    contextWindow: m.contextWindow !== undefined ? String(m.contextWindow) : '',
    reasoningEffort: m.reasoningEffort ?? '',
    tier: m.tier ?? '',
    ...(m.supportsImages !== undefined ? { supportsImages: m.supportsImages } : {}),
  }));

/** 行重播种键合(modelMove 后行序回落文件真值,但**不静默丢弃本地未保存行编辑**):
 *  fresh(文件真值)为基底,本地行按模型名键合覆写 contextWindow/reasoningEffort/tier 三字段
 *  (model 名即键、supportsImages 是文件透传位随 fresh);未触碰字段本地值=播种值=fresh 值,
 *  覆写幂等。模型名改过/新增未落盘的行无法键合——随 fresh 丢弃(抽屉提示行言明该规则) */
const mergeReseedRows = (fresh: ProviderEntry, local: ModelRow[]): ModelRow[] => {
  const byModel = new Map<string, ModelRow>();
  for (const r of local) {
    const k = r.model.trim();
    if (k !== '') byModel.set(k, r);
  }
  return rowsOfEntry(fresh).map((fr) => {
    const l = byModel.get(fr.model);
    return l === undefined ? fr : { ...fr, contextWindow: l.contextWindow, reasoningEffort: l.reasoningEffort, tier: l.tier };
  });
};

export interface ProvidersPaneProps {
  readonly conn: ProvidersPaneConn;
  /** 作用域目标项目 root(壳下发 targetRoot——下拉选哪个项目即锚哪个;'' = 全局作用域) */
  readonly root: string;
  /** T21 设置壳注入:作用域(缺省按 root 推断——非空即 project,壳缺省同款) */
  readonly scope?: SettingsScope;
  /** 2026-10-29 工具栏 ScopeSelect 上抛口(目标选择器,状态留壳层):上抛新目标项目 root
   *  字符串('' = 全局);未接(直接渲染/桩测)时切换不回写 */
  readonly onScopeChange?: (targetRoot: string) => void;
  /** 2026-10-29 目标选择器选项面(壳下发:全局+全部注册项目按名;未接=直渲/桩测缺省 全局+当前 root) */
  readonly scopeOptions?: readonly ScopeOption[];
  /** T21 config-changed 订阅 tick(providers 资源计数——外部改动信号,变化即重拉) */
  readonly refreshTick?: number;
}

export function ProvidersPane({ conn, root, scope, onScopeChange, scopeOptions, refreshTick }: ProvidersPaneProps): JSX.Element {
  /** GET /settings 全视图(null = 加载中;providers 面消费 entries/choices/apiKeyPresent/warnings,
   *  keys 面归内嵌 SettingsForm 自管——同一应答两消费方,单端点单请求) */
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  /** 工具栏搜索(2026-10-29 三件套入页):200ms 防抖过滤 name/baseUrl(大小写不敏感包含) */
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [form, setForm] = useState<DrawerForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');

  /** 作用域裁定:壳下发优先,缺省按 root 推断(壳缺省同款——无 root 强制 global) */
  const myScope: SettingsScope = scope ?? (root === '' ? 'global' : 'project');
  /** 读面取参:project 作用域带 root(两级遮蔽链),global 作用域省参(仅全局) */
  const fetchRoot = myScope === 'project' && root !== '' ? root : undefined;

  const load = useCallback((): void => {
    conn.settings(fetchRoot).then(
      (v) => {
        setView(v);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn, fetchRoot]);

  useEffect(() => {
    load();
  }, [load, refreshTick]); // refreshTick 变化=外部改动信号 → 重拉(config-changed 订阅消费面)

  /** op 写作用域取参单点:project 带 root、global 省参(input 原文即请求体,不留空串伪参) */
  const opInput = (base: Omit<ProviderOpInput, 'scope' | 'root'>): ProviderOpInput => ({
    ...base,
    scope: myScope,
    ...(myScope === 'project' ? { root } : {}),
  });

  /** 卡写回收口单点(删除):saving 门 → op remove → 成功重拉(失败 saving 复位+行内错误条) */
  const runRemove = (name: string): void => {
    if (saving) return;
    setSaving(true);
    setActionError('');
    conn
      .putProviderOp(opInput({ op: 'remove', name }))
      .then(() => {
        setSaving(false);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setActionError(errText(err));
      });
  };

  /** 抽屉打开(添加=空表单单空行;编辑=entries 播种——baseUrl/models 回显,apiKey 恒空串不回显) */
  const openDrawer = (e: ProviderEntry | null): void => {
    setFormError('');
    if (e === null) {
      setForm({ ...EMPTY_FORM, rows: [{ ...EMPTY_ROW }] });
      setDrawer({ mode: 'add', source: myScope });
      return;
    }
    setForm({ name: e.name, baseUrl: e.baseUrl, apiKey: '', rows: rowsOfEntry(e) });
    setDrawer({ mode: 'edit', source: myScope, original: e.name });
  };

  /** models 行字段 → 写面条目(model trim 空行滤除;contextWindow 化型正数校验;''=未设置省键;
   *  supportsImages 透传保全)。返回 null=校验失败(错误已置 formError) */
  const buildModels = (): Array<Record<string, unknown>> | null => {
    const models: Array<Record<string, unknown>> = [];
    for (const r of form.rows) {
      const model = r.model.trim();
      if (model === '') continue;
      let contextWindow: number | undefined;
      if (r.contextWindow.trim() !== '') {
        const n = Number(r.contextWindow);
        if (!Number.isFinite(n) || n <= 0) {
          setFormError(t(`Context window for ${model} must be a positive number`, `${model} 的上下文窗口须为正数`));
          return null;
        }
        contextWindow = n;
      }
      models.push({
        model,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(r.reasoningEffort !== '' ? { reasoningEffort: r.reasoningEffort } : {}),
        ...(r.tier !== '' ? { tier: r.tier } : {}),
        ...(r.supportsImages !== undefined ? { supportsImages: r.supportsImages } : {}),
      });
    }
    if (models.length === 0) {
      setFormError(t('At least one model row is required', '至少需要一行非空模型名'));
      return null;
    }
    return models;
  };

  /** 抽屉保存:add=op add(baseUrl+非空 models 必备——写面同口径);edit=op update(models 整组
   *  替换,改名=patch.name 换键);apiKey 非空追加 setKey(键值仅入请求体,响应零回显)。成功
   *  关抽屉+表单复位(密钥输入框随之清空离场)+重拉 */
  const submitDrawer = (): void => {
    if (drawer === null || saving) return;
    const name = form.name.trim();
    if (name === '') {
      setFormError(t('Provider name must be non-empty', '提供方名不能为空'));
      return;
    }
    const baseUrl = form.baseUrl.trim();
    if (baseUrl === '') {
      setFormError(t('Base URL must be non-empty', 'Base URL 不能为空'));
      return;
    }
    const models = buildModels();
    if (models === null) return;
    const target = drawer.mode === 'edit' ? drawer.original : name;
    const patch: Record<string, unknown> = { baseUrl, models };
    if (drawer.mode === 'edit' && name !== drawer.original) patch.name = name; // 改名(update 语义;add 身份只来自 name 参数)
    setSaving(true);
    setFormError('');
    conn
      .putProviderOp(opInput({ op: drawer.mode === 'add' ? 'add' : 'update', name: target, provider: patch }))
      .then(() => {
        const key = form.apiKey.trim();
        return key === '' ? undefined : conn.putProviderOp(opInput({ op: 'setKey', name, apiKey: key })); // setKey 定位终名(改名后同)
      })
      .then(() => {
        setSaving(false);
        setForm(EMPTY_FORM); // 密钥输入框清空(关抽屉离场+失败重开不残键值)
        setDrawer(null);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setFormError(errText(err));
      });
  };

  /** models 行上移/下移:文件级手术即时提交 modelMove op(非本地排序——Save 不接管行序);
   *  成功重拉 + 行重播种=mergeReseedRows 键合(文件真值基底 + 本地未保存行字段编辑保留,
   *  文件外行丢弃——见 helper 注;name/baseUrl/apiKey 本地编辑天然保留) */
  const moveModel = (index: number, direction: 'up' | 'down'): void => {
    if (drawer === null || drawer.mode !== 'edit' || saving) return;
    const model = form.rows[index]?.model.trim() ?? '';
    if (model === '') {
      setFormError(t('Fill the model name before reordering', '请先填写模型名再排序'));
      return;
    }
    setSaving(true);
    setFormError('');
    conn
      .putProviderOp(opInput({ op: 'modelMove', name: drawer.original, model, direction }))
      .then(() => {
        setSaving(false);
        return conn.settings(fetchRoot).then((v) => {
          setView(v);
          setLoadError('');
          const fresh = (v.providers.entries ?? []).find((e) => e.name === drawer.original);
          if (fresh !== undefined) setForm((f) => (f === null ? f : { ...f, rows: mergeReseedRows(fresh, f.rows) }));
        });
      })
      .catch((err: unknown) => {
        setSaving(false);
        setFormError(errText(err));
      });
  };

  const setRow = (index: number, patch: Partial<ModelRow>): void => {
    setForm((f) => ({ ...f, rows: f.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));
  };

  const allEntries = view?.providers.entries ?? [];
  /** 搜索过滤(2026-10-29 三件套入页):name/baseUrl 大小写不敏感包含(空查询=不限);
   *  卡列表一行一个(sx-rc-list 纵向) */
  const needle = query.trim().toLowerCase();
  const entries = needle === '' ? allEntries : allEntries.filter((e) => `${e.name} ${e.baseUrl}`.toLowerCase().includes(needle));
  const loading = view === null && loadError === '';
  /** 生效默认模型 = choices[0](首源首模型;服务端恒切,T11 裁定)。choices 空=无默认标注 */
  const defaultId =
    view !== null && view.providers.choices.length > 0
      ? `${view.providers.choices[0]!.provider}/${view.providers.choices[0]!.model}`
      : '';
  return (
    <div className="sx-settings-complex">
      {/* 请求参数卡恒全局(2026-10-29 用户裁定豁免):root 恒 ''——读仅全局、写恒 global 桶,
          不随工具栏目标选择器(卡片标题已注明,见 PROVIDERS_PANE) */}
      <SettingsForm conn={conn} root="" pane={PROVIDERS_PANE} />
      <section className="sx-providers" aria-label="providers">
        <h3>{t('Providers', '提供方')}</h3>
        <div className="sx-res-toolbar">
          <ScopeSelect value={myScope === 'project' ? root : ''} options={scopeOptions ?? defaultScopeOptions(root)} onChange={(v) => onScopeChange?.(v)} />
          <SearchBar value={query} onChange={setQuery} placeholder={t('Search providers', '搜索提供方')} />
          <button type="button" className="sx-add-button" onClick={() => openDrawer(null)}>
            {t('+ Add provider', '+ 新增提供方')}
          </button>
        </div>
        {loadError !== '' && <ErrorBanner text={loadError} />}
        {actionError !== '' && <ErrorBanner text={actionError} />}
        {loading && <EmptyState text={t('Loading providers…', '加载提供方…')} />}
        {!loading && allEntries.length === 0 && <EmptyState text={t('No providers configured.', '尚未配置提供方。')} />}
        {!loading && allEntries.length > 0 && entries.length === 0 && <EmptyState text={t('No matches.', '无匹配结果。')} />}
        {entries.length > 0 && (
          <ul className="sx-rc-list">
            {entries.map((e) => {
              const present = e.apiKeyPresent;
              return (
                <ResourceCard
                  key={e.name}
                  icon={
                    <span
                      className={`sx-api-dot ${present ? 'present' : 'missing'}`}
                      data-tip={e.apiKeyEnv}
                      aria-hidden="true"
                    />
                  }
                  title={e.name}
                  subtitle={e.baseUrl}
                  chips={
                    <>
                      {e.models.map((m) => (
                        <Fragment key={m.model}>
                          <span className="sx-chip">{m.model}</span>
                          {`${e.name}/${m.model}` === defaultId && <span className="sx-chip sx-provider-default">{t('Default', '默认')}</span>}
                        </Fragment>
                      ))}
                    </>
                  }
                  actions={
                    <>
                      <button
                        type="button"
                        aria-label={`${t('Edit', '编辑')} ${e.name}`}
                        disabled={saving}
                        onClick={() => openDrawer(e)}
                      >
                        {t('Edit', '编辑')}
                      </button>
                      <button
                        type="button"
                        aria-label={`${t('Delete', '删除')} ${e.name}`}
                        disabled={saving}
                        onClick={() => runRemove(e.name)}
                      >
                        {t('Delete', '删除')}
                      </button>
                    </>
                  }
                />
              );
            })}
          </ul>
        )}
        {(view?.providers.warnings ?? []).map((w) => (
          <p key={w} className="sx-provider-warn" role="alert">
            {w}
          </p>
        ))}
      </section>
      {drawer !== null && (
        <EditorModal
          open
          title={drawer.mode === 'add' ? t('Add provider', '新增提供方') : t(`Edit ${drawer.original}`, `编辑 ${drawer.original}`)}
          onClose={() => setDrawer(null)}
          onSubmit={submitDrawer}
        >
          <p className="sx-mcp-hint">
            {t('API key is write-only — it is never displayed. Leave empty to keep the current key.', 'API 密钥仅写不显——留空保持现键不变。')}
          </p>
          {drawer.mode === 'edit' && (
            <p className="sx-mcp-hint">
              {t(
                'Reorder writes to the file immediately — row order resets to the file after each move. Unsaved field edits are kept for rows whose model name is already in the file; other unsaved rows are dropped.',
                '排序即时落盘——每次排序后行序回落文件真值。模型名已在文件中的行保留未保存的字段编辑，其余未保存行会被丢弃。',
              )}
            </p>
          )}
          <label className="sx-drawer-field">
            {t('Name', '名称')}
            <input aria-label={t('Name', '名称')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} spellCheck={false} />
          </label>
          <label className="sx-drawer-field">
            {t('Base URL', 'Base URL')}
            <input aria-label={t('Base URL', 'Base URL')} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} spellCheck={false} />
          </label>
          <label className="sx-drawer-field">
            {t('API key', 'API 密钥')}
            <input
              type="password"
              aria-label={t('API key', 'API 密钥')}
              value={form.apiKey}
              autoComplete="new-password"
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              spellCheck={false}
            />
          </label>
          <div className="sx-drawer-field">
            {t('Models (name / context window / effort / tier)', '模型(名称/上下文窗口/强度/档位)')}
            {form.rows.map((r, i) => (
              <div key={i} className="sx-mcp-envrow">
                <input
                  aria-label={t('Model name', '模型名')}
                  placeholder={t('Model name', '模型名')}
                  value={r.model}
                  onChange={(e) => setRow(i, { model: e.target.value })}
                  spellCheck={false}
                />
                <input
                  aria-label={t('Context window', '上下文窗口')}
                  placeholder={t('Context window', '上下文窗口')}
                  value={r.contextWindow}
                  onChange={(e) => setRow(i, { contextWindow: e.target.value })}
                  spellCheck={false}
                />
                <select aria-label={t('Effort', '强度')} value={r.reasoningEffort} onChange={(e) => setRow(i, { reasoningEffort: e.target.value })}>
                  <option value="">{t('Effort', '强度')}</option>
                  {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <select aria-label={t('Tier', '档位')} value={r.tier} onChange={(e) => setRow(i, { tier: e.target.value })}>
                  <option value="">{t('Tier', '档位')}</option>
                  {['small', 'medium', 'large'].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                {drawer.mode === 'edit' && (
                  <>
                    <button
                      type="button"
                      aria-label={`${t('Move up', '上移')} ${r.model.trim() !== '' ? r.model.trim() : i + 1}`}
                      disabled={saving || i === 0}
                      onClick={() => moveModel(i, 'up')}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`${t('Move down', '下移')} ${r.model.trim() !== '' ? r.model.trim() : i + 1}`}
                      disabled={saving || i === form.rows.length - 1}
                      onClick={() => moveModel(i, 'down')}
                    >
                      ↓
                    </button>
                  </>
                )}
                <button
                  type="button"
                  aria-label={`${t('Remove model row', '移除模型行')} ${i + 1}`}
                  onClick={() => setForm((f) => ({ ...f, rows: f.rows.filter((_, j) => j !== i) }))}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setForm((f) => ({ ...f, rows: [...f.rows, { ...EMPTY_ROW }] }))}>
              {t('+ Add model', '+ 添加模型')}
            </button>
          </div>
          {formError !== '' && <ErrorBanner text={formError} />}
        </EditorModal>
      )}
    </div>
  );
}
