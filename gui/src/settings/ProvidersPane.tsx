import { Fragment, useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { SettingsForm } from './SettingsForm';
import type { SettingsFormConn, SettingsPaneDef } from './SettingsForm';
import { EditorDrawer, EmptyState, ErrorBanner, ResourceCard } from './components';
import type { SettingsScope } from './components';
import type { ProviderEntry, ProviderOpInput, SettingsView } from '../connection';

/**
 * Task 26 ProvidersPane 重构(2026-10-28 spec §15 GUI 面,T22-25 同款骨架):模型与提供方面板
 * 一屏式提供方 ResourceCard 卡片列表——写面全部走 PUT /settings/providers/op 单条目操作端点
 * (Task 16),原「嵌 SettingsForm 模型档位散键 Combo/baseUrl 行 + providers 只读卡列表」路径
 * 整体退役(spec §15 散键退役裁定:providers 列表唯一事实源,服务端恒切 choices[0] 为默认)。
 *
 * 结构(T21 共享组件 verbatim 消费):上=SettingsForm 表单引擎复用(仅「请求参数」卡——tier/
 * reasoningEffort 两闭集下拉,语义键写路径 PUT /settings 原样保留;「API 地址」行与模型散键
 * 四 Combo 删除——baseUrl 归提供方卡、模型归 models 行编辑);下=提供方卡列表(GET /settings
 * providers.entries 源级分组逐卡:名称/baseUrl 副行/密钥状态点(绿=env 槽在场/灰=缺,tip=槽名)/
 * models chips(choices[0] 所属模型加「Default」chip=生效默认,服务端恒切 choices[0]——T11 裁定)/
 * 编辑/删除)+「+ Add provider」钮;添加/编辑 → EditorDrawer 右滑抽屉(名称/Base URL/API key
 * password 输入——写走 setKey op、密钥零回显(编辑播种恒空串,留空=不动键)/models 行编辑
 * (模型名/contextWindow/reasoningEffort/tier select/上移下移钮——上移下移=文件级手术即时提交
 * modelMove op,成功后重拉+行重播种回落文件真值;行字段=本地态,Save 经 update op 整组替换
 * models)。
 *
 * 测试按钮裁定:v1 GUI 无提供方连通测试钮——REST 无 providers test 端点(不造端点),前端直连
 * baseUrl 需携密钥(密钥不进前端,违 D6);测试能力=CLI/TUI 面(T19/T20 已交付)。
 *
 * 作用域语义(壳 ScopeSwitcher 下发,T22 同款):scope='project'(缺省,有 root 时)读带 root
 * (两级遮蔽链视图)、写 op scope='project' 带 root;scope='global' 读省参(仅全局)、写 scope=
 * 'global' 省参 root。root='' 恒强制 global。entries 无 source 归因字段(GET 投影不分级)——
 * 卡写作用域恒随壳:project 作用域下编辑一条全局回落条目 = 按 upsert 语义落项目档(add 路径,
 * baseUrl+非空 models 必备,抽屉校验同口径)。
 *
 * 读面 T9 拆分(daemon handler 注释口径):entries=文件显式值(编辑回显走此面)、生效值看
 * choices(条目级 > 源级缺省)——卡片呈现/默认标记走 choices,抽屉播种走 entries。
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
 *  行退役(spec §15);键名与 daemon SEMANTIC_KEYS 逐字对齐,写路径 PUT /settings 原样保留 */
const PROVIDERS_PANE: SettingsPaneDef = {
  id: 'providers',
  title: { en: 'Models & providers', zh: '模型与提供方' },
  groups: [
    {
      title: { en: 'Request parameters', zh: '请求参数' },
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

/** 专用密钥槽名(daemon providerApiKeyEnv 同式镜像——choices 无该源行时的 data-tip 回退;
 *  单源在 src/config/providers.ts,此处仅呈现面兜底) */
const apiKeyEnvOf = (name: string): string => `SUNSHINEX_API_KEY_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/** entries 源级分组 → 抽屉 models 行播种(文件显式值——T9 拆分:编辑回显不走 choices) */
const rowsOfEntry = (e: ProviderEntry): ModelRow[] =>
  e.models.map((m) => ({
    model: m.model,
    contextWindow: m.contextWindow !== undefined ? String(m.contextWindow) : '',
    reasoningEffort: m.reasoningEffort ?? '',
    tier: m.tier ?? '',
    ...(m.supportsImages !== undefined ? { supportsImages: m.supportsImages } : {}),
  }));

export interface ProvidersPaneProps {
  readonly conn: ProvidersPaneConn;
  /** 项目上下文('' = 无项目上下文——恒全局作用域) */
  readonly root: string;
  /** T21 设置壳注入:作用域(缺省按 root 推断——有 root 即 project,壳缺省同款) */
  readonly scope?: SettingsScope;
  /** T21 config-changed 订阅 tick(providers 资源计数——外部改动信号,变化即重拉) */
  readonly refreshTick?: number;
}

export function ProvidersPane({ conn, root, scope, refreshTick }: ProvidersPaneProps): JSX.Element {
  /** GET /settings 全视图(null = 加载中;providers 面消费 entries/choices/apiKeyPresent/warnings,
   *  keys 面归内嵌 SettingsForm 自管——同一应答两消费方,单端点单请求) */
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
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
   *  成功重拉 + 行重播种回落文件真值(name/baseUrl/apiKey 本地编辑保留;行序字段让位文件真相) */
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
          if (fresh !== undefined) setForm((f) => (f === null ? f : { ...f, rows: rowsOfEntry(fresh) }));
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

  const entries = view?.providers.entries ?? [];
  const loading = view === null && loadError === '';
  /** 生效默认模型 = choices[0](首源首模型;服务端恒切,T11 裁定)。choices 空=无默认标注 */
  const defaultId =
    view !== null && view.providers.choices.length > 0
      ? `${view.providers.choices[0]!.provider}/${view.providers.choices[0]!.model}`
      : '';
  /** 专用密钥槽名:choices 行携 apiKeyEnv(单点);choices 缺该源行(条目全坏)回退本地镜像式 */
  const envOf = (name: string): string => view?.providers.choices.find((c) => c.provider === name)?.apiKeyEnv ?? apiKeyEnvOf(name);

  return (
    <div className="sx-settings-complex">
      <SettingsForm conn={conn} root={root} pane={PROVIDERS_PANE} />
      <section className="sx-providers" aria-label="providers">
        <div className="sx-mcp-toolbar">
          <h3>{t('Providers', '提供方')}</h3>
          <button type="button" className="sx-add-button" onClick={() => openDrawer(null)}>
            {t('+ Add provider', '+ 新增提供方')}
          </button>
        </div>
        {loadError !== '' && <ErrorBanner text={loadError} />}
        {actionError !== '' && <ErrorBanner text={actionError} />}
        {loading && <EmptyState text={t('Loading providers…', '加载提供方…')} />}
        {!loading && entries.length === 0 && <EmptyState text={t('No providers configured.', '尚未配置提供方。')} />}
        {entries.length > 0 && (
          <ul className="sx-rc-list">
            {entries.map((e) => {
              const present = view?.providers.apiKeyPresent[e.name] === true;
              return (
                <ResourceCard
                  key={e.name}
                  icon={
                    <span
                      className={`sx-api-dot ${present ? 'present' : 'missing'}`}
                      data-tip={envOf(e.name)}
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
        <EditorDrawer
          open
          title={drawer.mode === 'add' ? t('Add provider', '新增提供方') : t(`Edit ${drawer.original}`, `编辑 ${drawer.original}`)}
          onClose={() => setDrawer(null)}
          onSubmit={submitDrawer}
        >
          <p className="sx-mcp-hint">
            {t('API key is write-only — it is never displayed. Leave empty to keep the current key.', 'API 密钥仅写不显——留空保持现键不变。')}
          </p>
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
        </EditorDrawer>
      )}
    </div>
  );
}
