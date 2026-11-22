import { Pencil, PlugZap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { SettingsForm } from './SettingsForm';
import type { SettingsFormConn, SettingsPaneDef } from './SettingsForm';
import { ConfirmDeleteButton, EditorModal, EmptyState, ErrorBanner, ModalField, Switch } from './components';
import { SecretInput, Select } from './controls';
import { sanitizeRequestParams } from '../../../src/model/request-params';
import type { ProviderEntry, ProviderEntryModel, ProviderOpInput, SettingsView } from '../connection';

/**
 * Task 26 ProvidersPane 重构(2026-10-28 spec §15 GUI 面,T22-25 同款骨架):模型与提供方面板
 * 一屏式提供方 ResourceCard 卡片列表——写面全部走 PUT /settings/providers/op 单条目操作端点
 * (Task 16),原「嵌 SettingsForm 模型档位散键 Combo/baseUrl 行 + providers 只读卡列表」路径
 * 整体退役(spec §15 散键退役裁定:providers 列表唯一事实源,服务端恒切 choices[0] 为默认)。
 *
 * 结构(T21 共享组件 verbatim 消费):上=SettingsForm 表单引擎复用(仅「请求参数」卡——tier/
 * reasoningEffort 两闭集下拉;**2026-10-29 用户裁定豁免:请求参数卡恒全局**——root 恒 ''
 * (读仅全局、写恒 global 桶);标题注明「(global)/(全局)」已于 2026-10-30 用户裁定去除——
 * 多余说明;「API 地址」行与模型散键
 * 四 Combo 删除——baseUrl 归提供方卡、模型归 models 行编辑);下=提供方卡列表(GET /settings
 * providers.entries 源级分组逐卡:名称/baseUrl 副行/密钥状态点(绿=env 槽在场/灰=缺,tip=槽名)/
 * models chips(choices[0] 所属模型加「Default」chip=生效默认,服务端恒切 choices[0]——T11 裁定)/
 * 编辑/删除)。**页面即全局**(2026-10-29 用户裁定:模型/提供方全局豁免——工具栏 ScopeSelect
 * 与 SearchBar 撤除,只留「+ 新增提供方」钮;页面不再提供项目切换,项目级 providers 整键遮蔽
 * 语义仍在存储层但 GUI 不再触达);读恒省参(仅全局清单),新增/编辑/删除恒写全局(op scope=
 * 'global' 省参 root)。添加/编辑 → EditorModal 居中模态(2026-10-29 用户裁定:弹窗替换右滑
 * 抽屉;名称/Base URL/API key password 输入——写走 setKey op(2026-11-22 内联裁定:密钥随 providers 条目 apiKey 存放,读面回显——编辑播种已存值,
 * 留空=不动键)/models 行编辑(模型名/contextWindow/reasoningEffort/tier select/自定义请求参数
 * 键值对/上移下移钮
 * ——上移下移=文件级手术即时提交 modelMove op,成功后重拉+行重播种:以文件真值为基底按模型
 * 名键合保留本地未保存行字段编辑——模型名是键,改名/新增未落盘的行无法键合随 fresh 丢弃(弹窗
 * 提示行言明);行字段=本地态,Save 经 update op 整组替换 models)。
 * 2026-10-30 用户裁定(弹窗对齐主设置面风格):字段面改 ModalField 表单行;模型行重排——
 * 模型名独占行+(窗口/强度/档位)参数行+(上移/下移/删除)右对齐行,块间分隔线;强度/档位
 * 原生 select 换共享 Select('' 显式项=未设置,与原空值 option 同形)。提交形状/aria-label
 * 零变化。
 *
 * 测试按钮裁定:v1 GUI 无提供方连通测试钮——REST 无 providers test 端点(不造端点),前端直连
 * baseUrl 需携密钥(密钥不进前端,违 D6);测试能力=CLI/TUI 面(T19/T20 已交付)。
 *
 * 读面 T9 拆分(daemon handler 注释口径):entries=文件显式值(编辑回显走此面)、生效值看
 * choices(条目级 > 源级缺省)——卡片默认标记走 choices,抽屉播种走 entries;密钥面
 * (apiKeyEnv/apiKeyPresent)直读 entries 行富化字段(catalog listProviders 单点——含 models
 * 全畸形被跳过、choices 无行的源,密钥点不因呈现面缺行误灰)。
 *
 * 错误面三分 + saving 门单点(T22 同款):loadError(读)/actionError(卡写面)/formError(抽屉
 * 校验与保存,409 error/hint 经 connection 层透出+errText 行内呈现引流 raw 编辑面),均
 * ErrorBanner 行内;写面在途禁再发。config-changed 订阅:壳下发 refreshTick(providers 资源
 * 计数)变化即重拉(外部改动信号,零轮询)。
 */

/** 模型与提供方面板连接面(SettingsFormConn 复用——请求参数卡走既有语义键写路径;putProviderOp=
 *  Task 16 op 端点写面。结构满足即收,App 传整只 Connection) */
export interface ProvidersPaneConn extends SettingsFormConn {
  putProviderOp(input: ProviderOpInput): Promise<void>;
  /** 提供方连通探测(2026-11-17 模型列表测试钮):GET {baseUrl}/models,零 token */
  probeProvider(name: string): Promise<{ ok: boolean; status?: number; count?: number; error?: string }>;
}

/** models 行 effort/tier 闭集(单源:请求参数卡选项与模型行 Select 共用;daemon 语义键同域) */
const MODEL_EFFORTS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_TIERS: readonly string[] = ['small', 'medium', 'large'];
/* 档位/强度双语对(2026-10-30 用户澄清「label 走 i18n,不是改成中文」):l/lz 双语对形态——
 *  请求参数卡字段走 lz 管线(renderControl 渲染期 t 求值),模型行 Select 渲染期 t() 求值;
 *  值本身(none/medium/small 等语义键)不随语言变 */
const EFFORT_PAIRS: Record<string, { en: string; zh: string }> = { none: { en: 'None', zh: '无' }, minimal: { en: 'Minimal', zh: '极低' }, low: { en: 'Low', zh: '低' }, medium: { en: 'Medium', zh: '中' }, high: { en: 'High', zh: '高' }, xhigh: { en: 'XHigh', zh: '极高' }, max: { en: 'Max', zh: '最大' } };
const TIER_PAIRS: Record<string, { en: string; zh: string }> = { small: { en: 'Small', zh: '小' }, medium: { en: 'Medium', zh: '中' }, large: { en: 'Large', zh: '大' } };

/** 请求参数卡(SettingsForm 复用):仅 tier/effort 两闭集下拉——模型档位散键四 Combo 与 baseUrl
 *  行退役(spec §15);键名与 daemon SEMANTIC_KEYS 逐字对齐,写路径 PUT /settings 原样保留。
 *  卡恒全局豁免不变(2026-10-29 用户裁定:root 恒 '',模型档位/思考强度是全局请求面);
 *  标题「(global)/(全局)」注明退役(2026-10-30 用户裁定:多余说明) */
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
          options: MODEL_TIERS.map((v) => ({ v, l: TIER_PAIRS[v].en, lz: TIER_PAIRS[v].zh })),
        },
        {
          key: 'reasoningEffort',
          control: 'select',
          options: MODEL_EFFORTS.map((v) => ({ v, l: EFFORT_PAIRS[v].en, lz: EFFORT_PAIRS[v].zh })),
        },
      ],
    },
  ],
};

/** 上下文窗口展示(1M/128K 档;整数原样) */
const fmtWindow = (n: number): string => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));

/** 提供方弹窗表单(2026-11-17 用户裁定「新建 provide 和新建模型分开显示」):源级只留身份与密钥 */
interface ProviderForm {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** 模型弹窗表单(纵向字段):名称/上下文/最大输出/输入类型/思考强度/推理等级/更多参数(JSON) */
interface ModelForm {
  model: string;
  /** 显示名称(2026-11-17):仅展示;空=列表回退 model */
  displayName: string;
  enabled: boolean;
  contextWindow: string;
  maxOutputTokens: string;
  supportsImages: boolean;
  supportsVideo: boolean;
  reasoningEffort: string;
  tier: string;
  /** 更多参数:JSON 对象文本(不同模型不同形态,原样并入请求体) */
  paramsText: string;
}

const EMPTY_PROVIDER: ProviderForm = { name: '', baseUrl: '', apiKey: '' };
const EMPTY_MODEL: ModelForm = { model: '', displayName: '', enabled: true, contextWindow: '', maxOutputTokens: '', supportsImages: false, supportsVideo: false, reasoningEffort: '', tier: '', paramsText: '' };

/** 模型条目 → 弹窗表单(编辑播种;params 对象 → 格式化 JSON 文本) */
const modelFormOf = (m: ProviderEntryModel): ModelForm => ({
  model: m.model,
  displayName: m.displayName ?? '',
  enabled: m.enabled !== false,
  contextWindow: m.contextWindow !== undefined ? String(m.contextWindow) : '',
  maxOutputTokens: m.maxOutputTokens !== undefined ? String(m.maxOutputTokens) : '',
  supportsImages: m.supportsImages === true,
  supportsVideo: m.supportsVideo === true,
  reasoningEffort: m.reasoningEffort ?? '',
  tier: m.tier ?? '',
  paramsText: m.params !== undefined && Object.keys(m.params).length > 0 ? JSON.stringify(m.params, null, 2) : '',
});


interface ProvidersPaneProps {
  readonly conn: ProvidersPaneConn;
  /** T21 config-changed 订阅 tick(providers 资源计数——外部改动信号,变化即重拉) */
  readonly refreshTick?: number;
}

export function ProvidersPane({ conn, refreshTick }: ProvidersPaneProps): JSX.Element {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  /** 提供方弹窗(2026-11-17 拆分):add=新增源;edit=编辑源(original=改名换键旧名) */
  const [providerModal, setProviderModal] = useState<{ mode: 'add' | 'edit'; original?: string } | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm>(EMPTY_PROVIDER);
  const [modelModal, setModelModal] = useState<{ provider: string; mode: 'add' | 'edit'; original?: string } | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm>(EMPTY_MODEL);
  const [formError, setFormError] = useState('');
  /** 连通探测结果(2026-11-17 用户裁定「提示显示在下面弹出提示层」):sx-toast 底部浮出 3s 自隐 */
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [testing, setTesting] = useState('');
  const showToast = (text: string): void => {
    setToast(text);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3_000);
  };
  useEffect(() => () => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
  }, []);

  const load = useCallback((): void => {
    conn.settings(undefined).then(
      (v) => {
        setView(v);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn]);

  useEffect(() => {
    load();
  }, [load, refreshTick]);

  /** op 写作用域取参单点:恒 global 省参 root(页面即全局裁定) */
  const opInput = (base: Omit<ProviderOpInput, 'scope' | 'root'>): ProviderOpInput => ({
    ...base,
    scope: 'global',
  });

  /** 写面收口:统一 saving 门 + 错误行内 + 成功重拉 */
  const runOp = (input: Omit<ProviderOpInput, 'scope' | 'root'>): void => {
    if (saving) return;
    setSaving(true);
    setActionError('');
    conn
      .putProviderOp(opInput(input))
      .then(() => {
        setSaving(false);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setActionError(errText(err));
      });
  };

  const entries = view?.providers.entries ?? [];

  /** 源启停(provider 卡右上开关) */
  const toggleProvider = (e: ProviderEntry): void => runOp({ op: 'setEnabled', name: e.name, enabled: e.enabled === false });

  /** 拖拽态(2026-11-17 用户裁定「模型列表支持拖拽调整上下位置」):provider+model 双键,跨源拖不放 */
  const [dragModel, setDragModel] = useState<{ provider: string; model: string } | null>(null);

  /** 模型行序调整(拖拽):整组 models 按新序回写(行序=默认模型选序 choices[0]) */
  const reorderModels = (e: ProviderEntry, from: number, to: number): void => {
    const next = [...e.models];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    runOp({ op: 'update', name: e.name, provider: { models: next.map((m) => ({ ...m } as Record<string, unknown>)) } });
  };

  /** 模型启停(2026-11-17 用户裁定「模型单独禁用,开关放外面」):整组 models 回写,只翻目标条目 */
  const toggleModel = (e: ProviderEntry, model: ProviderEntryModel): void => {
    const models = e.models.map((m) => {
      if (m.model !== model.model) return { ...m } as Record<string, unknown>;
      const next = { ...m } as Record<string, unknown>;
      if (m.enabled === false) delete next['enabled'];
      else next['enabled'] = false;
      return next;
    });
    runOp({ op: 'update', name: e.name, provider: { models } });
  };

  /** 连通探测(测试链接图标):daemon 侧 GET {baseUrl}/models,零 token */
  const probe = (name: string): void => {
    if (testing !== '') return;
    setTesting(name);
    conn
      .probeProvider(name)
      .then((r) => {
        setTesting('');
        showToast(
          r.ok
            ? t(`${name} connected${r.count !== undefined ? ` · ${r.count} models` : ''}`, `${name} 连通${r.count !== undefined ? ` · ${r.count} 个模型` : ''}`)
            : t(`${name} failed${r.status !== undefined ? ` (${r.status})` : ''}${r.error !== undefined ? `: ${r.error}` : ''}`, `${name} 失败${r.status !== undefined ? ` (${r.status})` : ''}${r.error !== undefined ? `: ${r.error}` : ''}`),
        );
      })
      .catch((err: unknown) => {
        setTesting('');
        showToast(`${name}: ${errText(err)}`);
      });
  };

  /** 编辑播种的原始密钥(按键值变化判定是否发 setKey——未改动零 setKey,2026-11-22 回显裁定配套) */
  const originalKeyRef = useRef('');
  /** 打开提供方弹窗 */
  const openProviderModal = (e: ProviderEntry | null): void => {
    setFormError('');
    if (e === null) {
      originalKeyRef.current = '';
      setProviderForm(EMPTY_PROVIDER);
      setProviderModal({ mode: 'add' });
      return;
    }
    originalKeyRef.current = e.apiKey ?? '';
    setProviderForm({ name: e.name, baseUrl: e.baseUrl, apiKey: e.apiKey ?? '' });
    setProviderModal({ mode: 'edit', original: e.name });
  };

  /** 保存提供方:add=op add(models 空起点)+apiKey 非空 setKey;edit=op update(改名带 patch.name)
   *  +**键值变化才 setKey**(2026-11-22 内联可回显:空串=清条目字段,未改动零 setKey) */
  const submitProvider = (): void => {
    if (providerModal === null || saving) return;
    const name = providerForm.name.trim();
    if (name === '') {
      setFormError(t('Provider name must be non-empty', '提供方名不能为空'));
      return;
    }
    const baseUrl = providerForm.baseUrl.trim();
    if (baseUrl === '') {
      setFormError(t('Base URL must be non-empty', 'Base URL 不能为空'));
      return;
    }
    const target = providerModal.mode === 'edit' ? providerModal.original ?? name : name;
    const patch: Record<string, unknown> = { baseUrl }; // 启停只由卡片开关控制(2026-11-17 用户裁定),弹窗保存不触碰
    if (providerModal.mode === 'edit' && name !== target) patch.name = name;
    setSaving(true);
    setFormError('');
    const first =
      providerModal.mode === 'add'
        ? conn.putProviderOp(opInput({ op: 'add', name, provider: { ...patch, models: [] } }))
        : conn.putProviderOp(opInput({ op: 'update', name: target, provider: patch }));
    first
      .then(() => {
        const key = providerForm.apiKey.trim();
        return key === originalKeyRef.current ? undefined : conn.putProviderOp(opInput({ op: 'setKey', name, apiKey: key }));
      })
      .then(() => {
        setSaving(false);
        setProviderModal(null);
        setProviderForm(EMPTY_PROVIDER);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setFormError(errText(err));
      });
  };

  /** 打开模型弹窗(添加/编辑) */
  const openModelModal = (provider: string, m: ProviderEntryModel | null): void => {
    setFormError('');
    if (m === null) {
      setModelForm(EMPTY_MODEL);
      setModelModal({ provider, mode: 'add' });
      return;
    }
    setModelForm(modelFormOf(m));
    setModelModal({ provider, mode: 'edit', original: m.model });
  };

  /** 模型表单 → 写面条目(数字化型/JSON 参数校验;''=未设置省键) */
  const buildModelEntry = (): Record<string, unknown> | null => {
    const model = modelForm.model.trim();
    if (model === '') {
      setFormError(t('Model name must be non-empty', '模型名不能为空'));
      return null;
    }
    const num = (raw: string, label: string): number | undefined | null => {
      const text = raw.trim();
      if (text === '') return undefined;
      const n = Number(text);
      if (!Number.isFinite(n) || n <= 0) {
        setFormError(t(`${label} must be a positive number`, `${label} 须为正数`));
        return null;
      }
      return n;
    };
    const contextWindow = num(modelForm.contextWindow, t('Context window', '上下文窗口'));
    if (contextWindow === null) return null;
    const maxOutputTokens = num(modelForm.maxOutputTokens, t('Max output tokens', '最大输出 tokens'));
    if (maxOutputTokens === null) return null;
    let params: Record<string, unknown> | undefined;
    if (modelForm.paramsText.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(modelForm.paramsText);
      } catch {
        setFormError(t('Additional parameters must be valid JSON', '更多参数须为合法 JSON'));
        return null;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setFormError(t('Additional parameters must be a JSON object', '更多参数须为 JSON 对象'));
        return null;
      }
      const sanitized = sanitizeRequestParams(parsed as Record<string, unknown>);
      if (sanitized.problems.length > 0) {
        setFormError(sanitized.problems.join('; '));
        return null;
      }
      if (Object.keys(sanitized.params).length > 0) params = sanitized.params;
    }
    return {
      model,
      ...(modelForm.displayName.trim() !== '' ? { displayName: modelForm.displayName.trim() } : {}),
      ...(modelForm.enabled ? {} : { enabled: false }),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(modelForm.supportsImages ? { supportsImages: true } : {}),
      ...(modelForm.supportsVideo ? { supportsVideo: true } : {}),
      ...(modelForm.reasoningEffort !== '' ? { reasoningEffort: modelForm.reasoningEffort } : {}),
      ...(modelForm.tier !== '' ? { tier: modelForm.tier } : {}),
      ...(params !== undefined ? { params } : {}),
    };
  };

  /** 保存模型:add=modelAdd(entry);edit=update 整组 models 回写(原位替换) */
  const submitModel = (): void => {
    if (modelModal === null || saving) return;
    const entry = buildModelEntry();
    if (entry === null) return;
    const host = entries.find((e) => e.name === modelModal.provider);
    if (host === undefined) {
      setFormError(t('Provider not found', '提供方不存在'));
      return;
    }
    setSaving(true);
    setFormError('');
    const done = (): void => {
      setSaving(false);
      setModelModal(null);
      setModelForm(EMPTY_MODEL);
      load();
    };
    if (modelModal.mode === 'add') {
      conn.putProviderOp(opInput({ op: 'modelAdd', name: host.name, entry })).then(done, (err: unknown) => {
        setSaving(false);
        setFormError(errText(err));
      });
      return;
    }
    const models = host.models.map((m) => (m.model === modelModal.original ? entry : ({ ...m } as Record<string, unknown>)));
    conn.putProviderOp(opInput({ op: 'update', name: host.name, provider: { models } })).then(done, (err: unknown) => {
      setSaving(false);
      setFormError(errText(err));
    });
  };

  const loading = view === null && loadError === '';
  return (
    <div className="sx-settings-complex">
      <SettingsForm conn={conn} root="" pane={PROVIDERS_PANE} />
      <section className="sx-providers" aria-label="providers">
        <h3>{t('Providers', '提供方')}</h3>
        <div className="sx-res-toolbar">
          <button type="button" className="sx-add-button" onClick={() => openProviderModal(null)}>
            {t('+ Add provider', '+ 新增提供方')}
          </button>
        </div>
        {loadError !== '' && <ErrorBanner text={loadError} />}
        {actionError !== '' && <ErrorBanner text={actionError} />}
        {loading && <EmptyState text={t('Loading providers…', '加载提供方…')} />}
        {!loading && entries.length === 0 && <EmptyState text={t('No providers configured.', '尚未配置提供方。')} />}
        {entries.length > 0 && (
          <ul className="sx-rc-list">
            {entries.map((e) => (
              <li key={e.name} className="sx-rc">
                <div className="sx-rc-head">
                  <span className={`sx-api-dot ${e.apiKeyPresent ? 'present' : 'missing'}`} data-tip={e.apiKeyEnv} aria-hidden="true" />
                  <span className="sx-rc-title">{e.name}</span>
                  <span className="sx-rc-subtitle">{e.baseUrl}</span>
                  {/* 操作簇(2026-11-17 用户裁定「删除放第一个位置,贴右侧编辑/开关」):删除→编辑→启用开关 */}
                  <span className="sx-rc-head-acts">
                    <ConfirmDeleteButton icon ariaLabel={`${t('Delete', '删除')} ${e.name}`} disabled={saving} onConfirm={() => runOp({ op: 'remove', name: e.name })} />
                    <button
                      type="button"
                      className="sx-iconbtn"
                      aria-label={`${t('Edit', '编辑')} ${e.name}`}
                      data-tip={t('Edit', '编辑')}
                      disabled={saving}
                      onClick={() => openProviderModal(e)}
                    >
                      <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                    <Switch on={e.enabled !== false} onToggle={() => toggleProvider(e)} ariaLabel={`${t('Enable', '启用')} ${e.name}`} />
                  </span>
                </div>
                {/* 模型列表(2026-11-17 用户裁定「卡片里面添加模型」):名称+特点 chips+测试/编辑/开关 */}
                <div className="sx-provider-models-head">
                  <span className="sx-provider-models-title">{t('Models', '模型列表')}</span>
                  <button type="button" className="sx-add-button" onClick={() => openModelModal(e.name, null)}>
                    {t('+ Add model', '+ 添加模型')}
                  </button>
                </div>
                {e.models.length === 0 ? (
                  <p className="sx-provider-hint">{t('No models yet.', '暂无模型。')}</p>
                ) : (
                  <ul className="sx-provider-modellist">
                    {e.models.map((m, mi) => (
                      <li
                        key={m.model}
                        className={`sx-provider-modelitem${m.enabled === false ? ' off' : ''}${dragModel?.model === m.model && dragModel.provider === e.name ? ' dragging' : ''}`}
                        draggable
                        onDragStart={(ev) => {
                          setDragModel({ provider: e.name, model: m.model });
                          ev.dataTransfer.effectAllowed = 'move';
                          ev.dataTransfer.setData('text/plain', m.model);
                        }}
                        onDragOver={(ev) => {
                          if (dragModel?.provider === e.name) ev.preventDefault();
                        }}
                        onDrop={(ev) => {
                          ev.preventDefault();
                          if (dragModel === null || dragModel.provider !== e.name || dragModel.model === m.model) return;
                          const from = e.models.findIndex((x) => x.model === dragModel.model);
                          const to = mi;
                          setDragModel(null);
                          if (from < 0 || from === to) return;
                          reorderModels(e, from, to);
                        }}
                        onDragEnd={() => setDragModel(null)}
                      >
                        <span className="sx-provider-modelname">{m.displayName ?? m.model}</span>
                        <span className="sx-provider-chips">
                          {m.contextWindow !== undefined && <span className="sx-provider-chip">{fmtWindow(m.contextWindow)}</span>}
                          {m.supportsImages === true && <span className="sx-provider-chip">{t('Vision', '视觉')}</span>}
                          {m.supportsVideo === true && <span className="sx-provider-chip">{t('Video', '视频')}</span>}
                        </span>
                        <ConfirmDeleteButton
                          icon
                          ariaLabel={`${t('Delete model', '删除模型')} ${m.model}`}
                          disabled={saving}
                          onConfirm={() => runOp({ op: 'modelRemove', name: e.name, model: m.model })}
                        />
                        <button
                          type="button"
                          className="sx-iconbtn"
                          aria-label={`${t('Test connection', '测试连接')} ${m.model}`}
                          data-tip={t('Test connection', '测试连接')}
                          disabled={testing !== ''}
                          onClick={() => probe(e.name)}
                        >
                          <PlugZap size={14} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="sx-iconbtn"
                          aria-label={`${t('Edit model', '编辑模型')} ${m.model}`}
                          data-tip={t('Edit model', '编辑模型')}
                          onClick={() => openModelModal(e.name, m)}
                        >
                          <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                        <Switch on={m.enabled !== false} onToggle={() => toggleModel(e, m)} ariaLabel={`${t('Enable model', '启用模型')} ${m.model}`} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        {(view?.providers.warnings ?? []).map((w) => (
          <p key={w} className="sx-provider-warn" role="alert">
            {w}
          </p>
        ))}
      </section>
      {/* 提供方弹窗:只建源(2026-11-17 用户裁定「新建 provide 和新建模型分开显示」) */}
      {providerModal !== null && (
        <EditorModal
          open
          title={providerModal.mode === 'add' ? t('New provider', '新增提供方') : t(`Edit ${providerModal.original ?? ''}`, `编辑 ${providerModal.original ?? ''}`)}
          onClose={() => setProviderModal(null)}
          onSubmit={submitProvider}
        >
          <ModalField label={t('Name', '名称')}>
            <input className="sx-setting-input" aria-label={t('Name', '名称')} value={providerForm.name} onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })} spellCheck={false} />
          </ModalField>
          <ModalField label={t('Base URL', 'Base URL')}>
            <input className="sx-setting-input" aria-label={t('Base URL', 'Base URL')} value={providerForm.baseUrl} onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })} spellCheck={false} />
          </ModalField>
          <ModalField label={t('API key', 'API 密钥')}>
            <SecretInput ariaLabel={t('API key', 'API 密钥')} value={providerForm.apiKey} autoComplete="new-password" onChange={(v) => setProviderForm({ ...providerForm, apiKey: v })} />
            <a className="sx-provider-hint" href={providerForm.baseUrl || '#'} target="_blank" rel="noreferrer">
              {t('Get API key', '获取 API Key')}
            </a>
          </ModalField>
          {formError !== '' && <ErrorBanner text={formError} />}
        </EditorModal>
      )}
      {/* 模型弹窗:纵向字段(名称/上下文/最大输出/输入类型/思考强度/推理等级/更多参数 JSON) */}
      {modelModal !== null && (
        <EditorModal
          open
          title={modelModal.mode === 'add' ? t('New model', '新建模型') : t(`Edit ${modelModal.original ?? ''}`, `编辑 ${modelModal.original ?? ''}`)}
          onClose={() => setModelModal(null)}
          onSubmit={submitModel}
        >
          <ModalField label={t('Model ID', '模型标识')} hint={t('Sent to the API as the model parameter', '作为 model 参数传给 API')}>
            <input className="sx-setting-input" aria-label={t('Model ID', '模型标识')} value={modelForm.model} onChange={(e) => setModelForm({ ...modelForm, model: e.target.value })} spellCheck={false} />
          </ModalField>
          <ModalField label={t('Display name', '显示名称')} hint={t('Shown in lists; falls back to the model ID', '列表展示用，缺省显示模型标识')}>
            <input className="sx-setting-input" aria-label={t('Display name', '显示名称')} value={modelForm.displayName} onChange={(e) => setModelForm({ ...modelForm, displayName: e.target.value })} spellCheck={false} />
          </ModalField>
          <ModalField label={t('Context tokens', '上下文 tokens')}>
            <input className="sx-setting-input" aria-label={t('Context tokens', '上下文 tokens')} value={modelForm.contextWindow} onChange={(e) => setModelForm({ ...modelForm, contextWindow: e.target.value })} spellCheck={false} />
          </ModalField>
          <ModalField label={t('Max output tokens', '最大输出 tokens')}>
            <input className="sx-setting-input" aria-label={t('Max output tokens', '最大输出 tokens')} value={modelForm.maxOutputTokens} onChange={(e) => setModelForm({ ...modelForm, maxOutputTokens: e.target.value })} spellCheck={false} />
          </ModalField>
          <ModalField label={t('Input types', '支持输入类型')}>
            <div className="sx-model-inputtypes">
              <label>
                <input type="checkbox" checked readOnly /> {t('Text', '文本')}
              </label>
              <label>
                <input type="checkbox" aria-label={t('Image input', '图片输入')} checked={modelForm.supportsImages} onChange={(e) => setModelForm({ ...modelForm, supportsImages: e.target.checked })} /> {t('Image', '图片')}
              </label>
              <label>
                <input type="checkbox" aria-label={t('Video input', '视频输入')} checked={modelForm.supportsVideo} onChange={(e) => setModelForm({ ...modelForm, supportsVideo: e.target.checked })} /> {t('Video', '视频')}
              </label>
            </div>
          </ModalField>
          <ModalField label={t('Default reasoning effort', '默认思考强度')}>
            <Select
              ariaLabel={t('Default reasoning effort', '默认思考强度')}
              value={modelForm.reasoningEffort}
              options={[{ v: '', l: t('Default', '默认') }, ...MODEL_EFFORTS.map((v) => ({ v, l: t(EFFORT_PAIRS[v].en, EFFORT_PAIRS[v].zh) }))]}
              onChange={(v) => setModelForm({ ...modelForm, reasoningEffort: v })}
            />
          </ModalField>
          <ModalField label={t('Default reasoning level', '默认推理等级')}>
            <Select
              ariaLabel={t('Default reasoning level', '默认推理等级')}
              value={modelForm.tier}
              options={[{ v: '', l: t('Default', '默认') }, ...MODEL_TIERS.map((v) => ({ v, l: t(TIER_PAIRS[v].en, TIER_PAIRS[v].zh) }))]}
              onChange={(v) => setModelForm({ ...modelForm, tier: v })}
            />
          </ModalField>
          <ModalField label={t('More parameters (JSON)', '更多参数（JSON）')}>
            <textarea
              aria-label={t('More parameters', '更多参数')}
              className="sx-model-params-json"
              rows={6}
              value={modelForm.paramsText}
              onChange={(e) => setModelForm({ ...modelForm, paramsText: e.target.value })}
              spellCheck={false}
            />
          </ModalField>
          {formError !== '' && <ErrorBanner text={formError} />}
        </EditorModal>
      )}
      {toast !== '' && (
        <div className="sx-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
