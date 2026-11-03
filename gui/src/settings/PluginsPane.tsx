import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { PluginRow } from '../connection';
import { Select } from './controls';
import { zhToolName } from '../pages/chat/ToolEntry';
import { EditorModal, EmptyState, ErrorBanner, ModalField, ModalTabs, ResourceCard, ScopeSelect, SearchBar, defaultScopeOptions } from './components';
import type { SettingsScope, ScopeOption } from './components';

/**
 * Task 24 PluginsPane 重构(Phase F 第三面板,2026-10-28):一屏式卡片列表——T21 共享组件
 * verbatim 消费(McpPane/T23 同款骨架)。工具栏三件套(2026-10-29 用户裁定入页):ScopeSelect
 * 作用域下拉+SearchBar(200ms 防抖过滤 id/name/description,弹性)——无新增钮(插件由目录
 * 扫描发现,安装=目录拷贝,非用户创建面,无新增 op 端点);主体 ul.sx-rc-list ×
 * ResourceCard(title=名/subtitle 无/chips=版本+平台不支持标/badge=SourceBadge(builtin|user)/
 * 开关=启停/折叠详情=ID·servers·skills 元信息+configSchema 键说明+config 原值只读——卡片详情
 * 折叠保留)。
 *
 * 「配置」钮 → EditorModal 居中模态(2026-10-29 用户裁定:弹窗替换右滑抽屉)。弹窗体同日
 * 再裁定改**顶部两 Tab**(ModalTabs 共享件,McpPane 同构):「配置」=configSchema 在场键值
 * 表单(逐键播种既有 config 值,type=boolean 复选框/number 数字校验/string 文本;schema 外
 * 既有键 rest 透传保全——T22 seedRest 同纪律),「源码」=JSON 文本域。纪律不变:「源码」
 * 非空保存整对象以 JSON 为准(parse+对象形状校验);**切 Tab 不清内容**(旧"收起清空"退役,
 * 清空源码方回表单组装)。默认 Tab:无 configSchema=「源码」(JSON 唯一编辑面,预填既有
 * config);有 schema 且存在 schema 外既有键(表单外隐藏键,沿现 rest 判断)=「源码」预填
 * 既有 config;其余=「配置」。提交统一 putPlugin(…, {config}) 整对象覆写——保存即
 * plugins.<id>.config 全量改写,弹窗提示行言明。
 *
 * 作用域语义(壳下发:scope + onScopeChange——工具栏 ScopeSelect 只上抛,状态留壳,McpPane/AgentsPane 同款):scope='project'(缺省,有 root
 * 时)读两级清单(GET 带 root)、写带 root(项目 settings.json plugins.<id> 覆写键);scope='global'
 * 读仅全局清单(GET 省参)、写省参 root(全局 settings)。root='' 恒强制 global——旧「写面恒项目级
 * (root='' 开关禁用)」写死门退役:全局作用域开关/配置可写。platformSupported=false 卡置灰+
 * 写面全禁(装载层只标记,装配面剔除)。开关变更「新会话生效」。
 *
 * 错误面三分(T22 同款):loadError=读面/actionError=开关写面/formError=抽屉校验与保存失败,
 * 均 ErrorBanner 行内。saving 门单点:写面在途禁再发。config-changed 订阅:壳下发 refreshTick
 * (plugins 资源计数)变化即重拉(外部改动信号,零轮询)。
 */

/** 插件行类型随本 pane 再导出(brief 产出面;本体在 connection-types——Connection.plugins 应答同源) */
export type { PluginRow };

/** 插件面连接面(结构满足即收,App 传整只 Connection);putPlugin=PUT /settings/plugins
 *  记录级写(T8/T16 交付):root 在场=项目级 <root>/.sunshinex/settings.json,缺省=全局 */
export interface PluginsPaneConn {
  plugins(root?: string): Promise<{ plugins: PluginRow[]; warnings?: string[] }>;
  putPlugin(root: string | undefined, id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): Promise<void>;
}

export interface PluginsPaneProps {
  readonly conn: PluginsPaneConn;
  /** 作用域目标项目 root(壳下发 targetRoot——下拉选哪个项目即锚哪个;'' = 全局作用域) */
  readonly root: string;
  /** T21 设置壳注入:作用域(缺省按 root 推断——非空即 project,壳缺省同款) */
  readonly scope?: SettingsScope;
  /** 2026-10-29 工具栏 ScopeSelect 上抛口(目标选择器,状态留壳层):上抛新目标项目 root
   *  字符串('' = 全局);未接(直接渲染/桩测)时切换不回写 */
  readonly onScopeChange?: (targetRoot: string) => void;
  /** 2026-10-29 目标选择器选项面(壳下发:全局+全部注册项目按名;未接=直渲/桩测缺省 全局+当前 root) */
  readonly scopeOptions?: readonly ScopeOption[];
  /** T21 config-changed 订阅 tick(plugins 资源计数——外部改动信号,变化即重拉) */
  readonly refreshTick?: number;
}

/** 枚举值显示 label(2026-11-01 用户裁定「枚举值即说明,用 label+i18n」):值名即键,t() 落中文;
 *  未命中映射原样显示(自定义值/其他插件枚举零破坏) */
function optLabelOf(key: string, o: string): string {
  const labels: Record<string, Record<string, string>> = {};
  return labels[key]?.[o] ?? o;
}

/** 弹窗 Tab 键(McpPane 同构):「配置」=schema 表单面;「工具」=缺省暴露工具开关面(2026-10-31,
 *  manifest.exposedTools 在场才渲染);「源码」=JSON 文本域(非空保存整对象以 JSON 为准) */
type ModalTab = 'config' | 'tools' | 'source';

/** 配置抽屉表单态(受控单对象):values=schema 键的字符串态播种;rest=config 中 schema 外
 *  既有键(表单不建模——提交透传保全;disabledTools 由工具开关页专管,不入 rest 防双源);
 *  disabled=停用工具短名集(2026-10-31 工具开关面);tab=顶部 Tab 当值;jsonText=「源码」文本 */
interface ConfigForm {
  values: Record<string, string>;
  rest: Record<string, unknown>;
  disabled: string[];
  tab: ModalTab;
  jsonText: string;
}

/** 表单字符串值 → config 片段(严格态):boolean 恒落 true/false;number 非空转数字(非有限
 *  数=校验失败);string 非空落值;空串=删键(显式清空语义) */
const buildValues = (
  values: Record<string, string>,
  schema: NonNullable<PluginRow['configSchema']>,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } => {
  const config: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(values)) {
    const type = schema[k]?.type;
    if (type === 'boolean') {
      config[k] = raw === 'true';
    } else if (type === 'number') {
      if (raw.trim() === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: t(`Invalid number for ${k}: ${raw}`, `${k} 不是合法数字: ${raw}`) };
      config[k] = n;
    } else {
      if (raw === '') continue;
      config[k] = raw;
    }
  }
  return { ok: true, config };
};

export function PluginsPane({ conn, root, scope, onScopeChange, scopeOptions, refreshTick }: PluginsPaneProps): JSX.Element {
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  /** 装载聚合警告(pane 尾展开;可选防旧 daemon——GET 载荷恒带,结构面留宽) */
  const [viewWarnings, setViewWarnings] = useState<string[]>([]);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  /** 写面在途门(saving 单点——开关/配置提交共用,在途禁再发) */
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState<PluginRow | null>(null);
  const [form, setForm] = useState<ConfigForm | null>(null);
  const [formError, setFormError] = useState('');

  /** 作用域裁定:壳下发优先,缺省按 root 推断(壳缺省同款——无 root 强制 global) */
  const myScope: SettingsScope = scope ?? (root === '' ? 'global' : 'project');
  /** 读面取参:project 作用域带 root(两级清单),global 作用域省参(仅全局清单) */
  const fetchRoot = myScope === 'project' && root !== '' ? root : undefined;
  /** 写面取参单点:project 带 root、global 省参(不留空串伪参) */
  const writeRoot = fetchRoot;

  const load = useCallback((): void => {
    conn.plugins(fetchRoot).then(
      (v) => {
        setRows(v.plugins);
        setViewWarnings(v.warnings ?? []);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn, fetchRoot]);

  useEffect(() => {
    load();
  }, [load, refreshTick]); // refreshTick 变化=外部改动信号 → 重拉(config-changed 订阅消费面)

  /** 开关切换:PUT 语义键(显式布尔)按作用域落位,成功后重拉(新会话生效);
   *  失败行内错误条(actionError,pane 顶) */
  const toggle = (p: PluginRow): void => {
    if (!p.platformSupported || saving) return;
    setSaving(true);
    setActionError('');
    conn.putPlugin(writeRoot, p.id, { enabled: !p.enabled }).then(
      () => {
        setSaving(false);
        load();
      },
      (err: unknown) => {
        setSaving(false);
        setActionError(errText(err));
      },
    );
  };

  /** 抽屉打开:schema 键逐键播种既有 config 值(String 化;缺省空串=未设);schema 外既有键
   *  收进 rest(提交透传保全——T22 seedRest 同纪律)。默认 Tab(2026-10-29 用户裁定,McpPane
   *  同构):无 schema=「源码」+预填既有 config(JSON 唯一编辑面);有 schema 且存在 schema
   *  外既有键(表单外隐藏键)=「源码」+预填既有 config;其余=「配置」(jsonText 空=表单组装
   *  生效) */
  const openDrawer = (p: PluginRow): void => {
    setFormError('');
    const schemaKeys = Object.keys(p.configSchema ?? {});
    const values: Record<string, string> = {};
    for (const k of schemaKeys) {
      const v = p.config?.[k];
      values[k] = v === undefined ? '' : String(v);
    }
    // rest=config 中 schema 外既有键(透传保全)——disabledTools 由工具开关页专管,不入 rest(防双源)
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p.config ?? {})) {
      if (!schemaKeys.includes(k) && k !== 'disabledTools') rest[k] = v;
    }
    const rawDisabled = p.config?.disabledTools;
    const disabled = Array.isArray(rawDisabled) ? rawDisabled.filter((x): x is string => typeof x === 'string') : [];
    const sourceDefault = schemaKeys.length === 0 || Object.keys(rest).length > 0;
    setForm({
      values,
      rest,
      disabled,
      tab: sourceDefault ? 'source' : 'config',
      jsonText: sourceDefault ? JSON.stringify(p.config ?? {}, null, 2) : '',
    });
    setDrawer(p);
  };

  /** 「源码」Tab 切换(T22 预填语义沿袭,**切 Tab 不清内容**——2026-10-29 用户裁定):
   *  入「源码」且文本空 → 按当前表单+rest 预填整对象(逐键按 schema type lenient 转换——
   *  非法数字回落原串,预览不篡改类型);源码非空留存=提交仍以 JSON 为准,清空方回表单组装 */
  const switchTab = (next: ModalTab): void => {
    setForm((f) => {
      if (f === null || f.tab === next) return f;
      if (next === 'source' && f.jsonText.trim() === '') {
        const seeded: Record<string, unknown> = { ...f.rest };
        for (const [k, raw] of Object.entries(f.values)) {
          if (raw === '') continue;
          const type = drawer?.configSchema?.[k]?.type;
          if (type === 'boolean') seeded[k] = raw === 'true';
          else if (type === 'number') {
            const n = Number(raw);
            seeded[k] = Number.isFinite(n) ? n : raw;
          } else seeded[k] = raw;
        }
        if (f.disabled.length > 0) seeded.disabledTools = f.disabled; // 工具停用并入源码预览
        return { ...f, tab: next, jsonText: JSON.stringify(seeded, null, 2) };
      }
      return { ...f, tab: next };
    });
  };

  /** 抽屉保存:「JSON 源码」非空 → 整对象以 JSON 为准(parse+对象形状门);否则表单组装
   *  (rest 透传+schema 键类型化值)→ putPlugin(…, {config}) 整对象覆写 → 成功关抽屉+重拉 */
  const submitDrawer = (): void => {
    if (drawer === null || form === null || saving) return;
    const schema = drawer.configSchema ?? {};
    let config: Record<string, unknown>;
    if (form.jsonText.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(form.jsonText);
      } catch (e) {
        setFormError(t(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, `JSON 非法: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setFormError(t('Config must be a JSON object', '配置必须是 JSON 对象'));
        return;
      }
      config = parsed as Record<string, unknown>;
    } else {
      const built = buildValues(form.values, schema);
      if (!built.ok) {
        setFormError(built.error);
        return;
      }
      config = { ...form.rest, ...built.config };
    }
    if (form.disabled.length > 0) config = { ...config, disabledTools: form.disabled }; // 工具停用随提交落 config(装配期 client 逐工具不注册)
    setSaving(true);
    setFormError('');
    conn.putPlugin(writeRoot, drawer.id, { config }).then(
      () => {
        setSaving(false);
        setDrawer(null);
        setForm(null);
        load();
      },
      (err: unknown) => {
        setSaving(false);
        setFormError(errText(err)); // 400 形状面/409 写面原文行内
      },
    );
  };

  /** 过滤面:id/name/description 大小写不敏感包含 */
  const needle = query.trim().toLowerCase();
  const visible = (rows ?? []).filter((p) => (needle === '' ? true : `${p.id} ${p.name} ${p.description}`.toLowerCase().includes(needle)));

  /** 卡副题行(2026-10-31 用户裁定「去掉这种标签,直接显示」):版本+工具计数纯文本,不再做
   *  chip 描边;来源徽章(内置/用户)整项去除——卡头名牌即足以辨识 */
  const chipsOf = (p: PluginRow): ReactNode => (
    <span className="sx-rc-subtitle">
      {t(`v${p.version}`, `v${p.version}`)}
      {p.exposedTools !== undefined && p.exposedTools.length > 0
        ? t(` · tools ×${p.exposedTools.length}`, ` · 工具 ×${p.exposedTools.length}`)
        : ''}
      {!p.platformSupported ? t(' · platform not supported', ' · 平台不支持') : ''}
    </span>
  );

  /** 卡面(2026-10-31 用户裁定「不用现在的详情显示等」):描述+逐插件 warnings 行内直出(罕见
   *  诊断面不再折叠藏详情),元信息 dl/configSchema 键说明/config 原值 dump 整体退役——
   *  配置与工具开关全部进「配置」弹窗 */
  const cardBodyOf = (p: PluginRow): ReactNode => (
    <>
      {p.description !== '' && <p className="sx-agent-desc">{p.description}</p>}
      {p.warnings.length > 0 && (
        <div role="alert">
          {p.warnings.map((w, i) => (
            <p key={i} className="sx-agent-warn">
              {w}
            </p>
          ))}
        </div>
      )}
    </>
  );

  return (
    <section className="sx-settings-form" aria-label="settings pane plugins">
      <h2>{t('Plugins', '插件')}</h2>
      <div className="sx-res-toolbar">
        <ScopeSelect value={myScope === 'project' ? root : ''} options={scopeOptions ?? defaultScopeOptions(root)} onChange={(v) => onScopeChange?.(v)} />
        <SearchBar value={query} onChange={setQuery} placeholder={t('Search plugins', '搜索插件')} />
      </div>
      {loadError !== '' && <ErrorBanner text={loadError} />}
      {actionError !== '' && <ErrorBanner text={actionError} />}
      {rows === null && loadError === '' && <EmptyState text={t('Loading plugins…', '加载插件清单…')} />}
      {rows !== null && rows.length === 0 && loadError === '' && <EmptyState text={t('No plugins.', '无已装载插件。')} />}
      {rows !== null && rows.length > 0 && visible.length === 0 && <EmptyState text={t('No matches.', '无匹配结果。')} />}
      {visible.length > 0 && (
        <ul className="sx-rc-list">
          {visible.map((p) => {
            const writable = p.platformSupported;
            return (
              <ResourceCard
                key={p.id}
                title={p.name}
                chips={chipsOf(p)}
                enabled={p.enabled}
                onToggle={writable ? () => toggle(p) : undefined}
                body={cardBodyOf(p)}
                // 内置插件只有开关(2026-11-03 用户裁定):不出「配置」入口
                actions={p.source === 'builtin' ? undefined : (
                  <button
                    type="button"
                    aria-label={`${t('Configure', '配置')} ${p.name}`}
                    disabled={!writable || saving}
                    data-tip={!writable ? t('Platform not supported', '平台不支持') : undefined}
                    onClick={() => openDrawer(p)}
                  >
                    {t('Configure', '配置')}
                  </button>
                )}
              />
            );
          })}
        </ul>
      )}
      {/* pane 尾聚合装载告警:整插件被跳过(manifest 非法等)在此展开原因——spec §6 异常可见性出口 */}
      {viewWarnings.length > 0 && (
        <details className="sx-mcp-probe">
          <summary>{t(`${viewWarnings.length} plugin load warning(s)`, `${viewWarnings.length} 条插件装载告警`)}</summary>
          {viewWarnings.map((w, i) => (
            <p key={i} className="sx-agent-warn">
              {w}
            </p>
          ))}
        </details>
      )}
      {drawer !== null && form !== null && (
        <EditorModal
          open
          title={t(`Configure ${drawer.name}`, `配置 ${drawer.name}`)}
          onClose={() => {
            setDrawer(null);
            setForm(null);
          }}
          onSubmit={submitDrawer}
        >
          <ModalTabs
            tabs={[
              { id: 'config', label: t('Config', '配置') },
              ...(drawer.exposedTools !== undefined && drawer.exposedTools.length > 0
                ? [{ id: 'tools' as const, label: t('Tools', '工具') }]
                : []),
              { id: 'source', label: t('Source', '源码') },
            ]}
            active={form.tab}
            onChange={(id) => switchTab(id === 'source' ? 'source' : id === 'tools' ? 'tools' : 'config')}
          />
          {form.tab === 'source' ? (
            <textarea
              aria-label={t('Config JSON', '配置 JSON')}
              className="sx-mcp-json"
              value={form.jsonText}
              onChange={(e) => setForm({ ...form, jsonText: e.target.value })}
              rows={10}
              spellCheck={false}
            />
          ) : form.tab === 'tools' ? (
            /* 工具开关页(2026-10-31 用户裁定「配置弹窗控制哪些工具可用」):manifest 缺省暴露清单
               逐具开关——开=注册进模型工具面,关=装配期不注册(模型不可见);落 config.disabledTools */
            <div className="sx-plugin-tools" role="group" aria-label={t('Tool toggles', '工具开关')}>
              {drawer.exposedTools!.map((name) => {
                const off = form.disabled.includes(name);
                return (
                  <div key={name} className="sx-plugin-tool-row">
                    <span className="sx-plugin-tool-name">{zhToolName(`mcp__${drawer.id}__${name}`)}</span>
                    <span className="sx-plugin-tool-id">{name}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!off}
                      aria-label={name}
                      className={`sx-mcp-switch${off ? '' : ' on'}`}
                      onClick={() =>
                        setForm((f) =>
                          f === null ? f : { ...f, disabled: off ? f.disabled.filter((x) => x !== name) : [...f.disabled, name] },
                        )
                      }
                    >
                      <span className="knob" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <>
          {/* 2026-10-30 用户裁定:schema 键值表单改 ModalField 表单行;2026-10-31 用户裁定
              「能用下拉的,不要用自由输入」——options 枚举键=下拉(单选)/勾选组(multi 逗号多选),
              仅无 options 键(自由路径等)保持文本输入;显示面按「生效默认」(config ?? configDefaults)
              —未设置的键勾选/下拉显示缺省态而非空白;提交形状零变化(未触碰=不落键) */}
          {Object.entries(drawer.configSchema ?? {}).map(([k, s]) => {
            const effDefault = drawer.configDefaults?.[k];
            const value = form.values[k] ?? '';
            const checked = value !== '' ? value === 'true' : effDefault === true;
            return s.type === 'boolean' ? (
              <label key={k} className="sx-drawer-field sx-check-row">
                <input
                  type="checkbox"
                  aria-label={k}
                  checked={checked}
                  onChange={(e) => setForm({ ...form, values: { ...form.values, [k]: e.target.checked ? 'true' : 'false' } })}
                />
                {k}
                {s.description !== undefined && <span className="sx-mcp-hint">{s.description}</span>}
              </label>
            ) : s.options !== undefined && s.options.length > 0 && s.multi === true ? (
              <ModalField key={k} label={k} hint={s.description}>
                <div className="sx-plugin-opt-row" role="group" aria-label={k}>
                  {s.options.map((o) => {
                    const picked = value.split(',').map((x) => x.trim()).filter((x) => x !== '');
                    const on = picked.includes(o);
                    return (
                      <label key={o} className="sx-drawer-field sx-check-row">
                        <input
                          type="checkbox"
                          aria-label={`${k}:${o}`}
                          checked={on}
                          onChange={(e) => {
                            const next = e.target.checked ? [...picked, o] : picked.filter((x) => x !== o);
                            setForm({ ...form, values: { ...form.values, [k]: next.join(',') } });
                          }}
                        />
                        {optLabelOf(k, o)}
                      </label>
                    );
                  })}
                </div>
              </ModalField>
            ) : s.options !== undefined && s.options.length > 0 ? (
              <ModalField key={k} label={k} hint={s.description}>
                <Select
                  ariaLabel={k}
                  value={value !== '' ? value : typeof effDefault === 'string' && effDefault !== '' ? effDefault : ''}
                  /* 无独立「默认」项(2026-11-01 用户裁定「直接显示成对应实际值」):未设置时直接选中
                     schema 缺省值实际项;无缺省才落空选 */
                  options={s.options.map((o) => ({ v: o, l: optLabelOf(k, o) }))}
                  onChange={(v) => setForm({ ...form, values: { ...form.values, [k]: v } })}
                />
              </ModalField>
            ) : (
              <ModalField key={k} label={k} hint={s.description}>
                <input
                  className="sx-setting-input"
                  aria-label={k}
                  value={value}
                  spellCheck={false}
                  onChange={(e) => setForm({ ...form, values: { ...form.values, [k]: e.target.value } })}
                />
              </ModalField>
            );
          })}
            </>
          )}
          {formError !== '' && <ErrorBanner text={formError} />}
        </EditorModal>
      )}
    </section>
  );
}
