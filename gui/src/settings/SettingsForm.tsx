import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsKeyRow, SettingsView } from '../connection';
import { SourceBadge } from './SourceBadge';
import { Combo, Select } from './controls';
import type { SelectOption } from './controls';
import { relTime, errText } from '../ui-util';
import { parseLanguage, setLanguage, t } from '../i18n';
import { applyTheme, readThemePref, watchSystemTheme } from '../theme';
import type { ThemePref } from '../theme';
import { applyZoom, readZoomPref } from '../ui-zoom';
import type { UiZoom } from '../ui-zoom';
import { applyFontPreset, FONT_PRESET_CHOICES, presetVars, readFontPreset } from '../font-preset';
import type { FontPreset } from '../font-preset';

/**
 * G8c T8 通用键值表单引擎(设置自动保存轮):mount/effect 拉 conn.settings(root)→按 pane 分组
 * 卡片渲染(组=盒子卡,行=标题+描述+右控件;外观主题行随 general 首组)。控件三形——text/number
 * 自由输入、select 闭集自绘弹层、combo 自由文本+动态建议(模型 id 自 providers.choices 动态
 * 来,自由键入恒合法);envOverride 行禁编+title「env 覆盖中,改文件不生效」。
 * 自动生效(本轮;「添加类」表单——MCP 服务器/智能体/高级原文——仍显式保存,不在此列):
 * 无保存钮——text/number/combo 失焦(Enter 即提交)落值,select 换项即存;逐字段写回来源
 * 文件(行 source='project' → putSettings('project', root);global/default → putSettings
 * ('global'))。逐字段写经串行队列排队(两字段连跳=两笔 PUT,链式防同文件读改写竞态);
 * 未变更字段不写。成功 toast「已生效:新建会话起」+重拉;失败行内错误条原文示出,行值保持
 * 脏(可改后再触发)。重拉保脏合并:在途未保存编辑(输入值≠服务端值)不被重拉 clobber。
 * root 归一:''(仅全局)→ settings/memoryStats 省参;此时 source='project' 行不可写(无项目
 * 定位)——触发时报错提示自项目内打开。数字键保存时 number 化;清空值存 null(=delete)。
 * 记忆面板概览行(pane.memoryOverview):conn.memoryStats 只读展示「N 条记忆·最近 X」。
 */

export interface SettingsFieldDef {
  readonly key: string;
  /** text/number=自由输入;select=闭集弹层;combo=自由文本+动态建议 */
  readonly control: 'text' | 'number' | 'select' | 'combo';
  /** select 选项集;combo 建议集。函数形 = 动态源(入参 models=providers 现配模型去重集) */
  readonly options?:
    | readonly SelectOption[]
    | ((ctx: { models: readonly string[] }) => readonly SelectOption[]);
  readonly placeholder?: string;
}

/** 分组卡(设置重构轮):一卡一语义盒——标题+可选描述+字段行;themeRow/zoomRow=组首渲染
 *  外观/界面放缩行(GUI 本地偏好,非 settings 键)。标题双语对(G14.213):渲染期 t() 求值,
 *  模块常量只存数据不冻结文案(语言切换即翻) */
export interface SettingsGroupDef {
  readonly title: { readonly en: string; readonly zh: string };
  readonly desc?: { readonly en: string; readonly zh: string };
  readonly fields: readonly SettingsFieldDef[];
  readonly themeRow?: boolean;
  readonly zoomRow?: boolean;
  readonly fontRow?: boolean;
}

/** 面板配置:id(导航/重挂键)+title(导航项与面板标题双语对)+groups(分组卡列)+记忆概览行开关 */
export interface SettingsPaneDef {
  readonly id: string;
  readonly title: { readonly en: string; readonly zh: string };
  readonly groups: readonly SettingsGroupDef[];
  /** 记忆面板:true = 顶部概览行(memoryStats 只读) */
  readonly memoryOverview?: boolean;
}

/** 表单引擎连接面(结构满足即收,App 传整只 Connection) */
export interface SettingsFormConn {
  settings(root?: string): Promise<SettingsView>;
  putSettings(scope: 'project' | 'global', root: string | undefined, updates: Record<string, string | number | null>): Promise<void>;
  memoryStats(root?: string): Promise<{ entries: number; lastWriteAt: number | null }>;
}

/** 键描述(标题=键名,描述=双语一句;未登记键只显键名) */
const KEY_DESCRIPTIONS: Record<string, { en: string; zh: string }> = {
  language: { en: 'Language for the app UI', zh: '界面语言' },
  shell: { en: 'Shell used for command execution', zh: '命令执行所用 shell' },
  projectsDir: { en: 'Root directory of workspace registry', zh: '工作区注册表根目录' },
  userSkillsDir: { en: 'Global user skills directory', zh: '全局用户技能目录' },
  globalSunshine: { en: 'Global SUNSHINE.md path', zh: '全局 SUNSHINE.md 路径' },
  model: { en: 'Default model id', zh: '缺省模型 id' },
  modelSmall: { en: 'Model bound to small tier', zh: 'small 档绑定模型' },
  modelMedium: { en: 'Model bound to medium tier', zh: 'medium 档绑定模型' },
  modelLarge: { en: 'Model bound to large tier', zh: 'large 档绑定模型' },
  tier: { en: 'Default model tier', zh: '缺省模型档位' },
  reasoningEffort: { en: 'Reasoning effort for requests', zh: '请求思考强度' },
  baseUrl: { en: 'OpenAI-compatible API base URL', zh: 'OpenAI 兼容 API 地址' },
  contextWindow: { en: 'Model context window (tokens)', zh: '模型上下文窗口(tokens)' },
  maxTokens: { en: 'Hard cap on tokens per request', zh: '单请求 token 硬顶' },
  subagentTokenCap: { en: 'Token cap for subagents', zh: '子智能体 token 上限' },
  teamTokenCap: { en: 'Token cap for the team registry', zh: '团队注册表 token 上限' },
  maxSteps: { en: 'Max reactor steps per run', zh: '单 run 最大 reactor 步数' },
  maxLoopIterations: { en: 'Max verify-fix loop iterations', zh: '验收修正环最大轮数' },
  maxGraphNodes: { en: 'Max graph nodes per pipeline', zh: '全链路最大节点步数' },
  readFence: { en: 'Read-approval fence mode', zh: '读审批围栏模式' },
  sandbox: { en: 'Command sandbox policy', zh: '命令沙箱策略' },
  isolation: { en: 'Isolation backend', zh: '隔离后端' },
  autoMemory: { en: 'Persistent memory pipeline', zh: '持久记忆管线' },
  learnedSkills: { en: 'Learned skills pipeline', zh: '学习技能沉淀管线' },
  learnedSkillLimit: { en: 'Learned skill capacity', zh: '学习技能容量上限' },
  memoryIdleKickMs: { en: 'Idle kick for memory pipeline (ms)', zh: '记忆管线空闲触发(ms)' },
  stepDigestMaxSteps: { en: 'Digest: max steps summarized', zh: '摘要:最大归纳步数' },
  stepDigestItemChars: { en: 'Digest: per-item char budget', zh: '摘要:单条字符预算' },
  stepDigestTotalChars: { en: 'Digest: total char budget', zh: '摘要:总字符预算' },
  kbBackend: { en: 'Knowledge-base vector backend', zh: '知识库向量后端' },
  kbDataDir: { en: 'Knowledge-base data directory', zh: '知识库数据目录' },
  embeddingBaseUrl: { en: 'Embedding API base URL', zh: 'Embedding API 地址' },
  embeddingModel: { en: 'Embedding model id', zh: 'Embedding 模型 id' },
  websearchProvider: { en: 'Web search provider', zh: '网页搜索提供方' },
  websearchEndpoint: { en: 'Web search endpoint', zh: '网页搜索端点' },
};

/** on/off 二态闭集(on/off 字符串键,daemon 口径) */
const ON_OFF: readonly SelectOption[] = [
  { v: 'on', l: 'on' },
  { v: 'off', l: 'off' },
];

/** providers 现配模型去重集(动态建议/选项源的 ctx;choices 缺面=空集) */
const modelsOf = (view: SettingsView): string[] => [...new Set(view.providers.choices.map((c) => c.model))].filter((m) => m !== '');

/** select 未设置项(置顶;清值=存 null 删键,与 text 行空串同语义) */
const text = (key: string, placeholder?: string): SettingsFieldDef => ({ key, control: 'text', ...(placeholder !== undefined ? { placeholder } : {}) });
const num = (key: string): SettingsFieldDef => ({ key, control: 'number' });
const sel = (key: string, options: readonly SelectOption[]): SettingsFieldDef => ({ key, control: 'select', options });
const modelCombo = (key: string): SettingsFieldDef => ({ key, control: 'combo' });

/** 四简单面板(SETTINGS_PANES):键名与 daemon SEMANTIC_KEYS 逐字对齐;分组卡=语义盒。
 *  标题双语对(G14.213 设置面 i18n):渲染期 t() 求值——此前裸中文字面量,设置页永不随语言切换 */
export const SETTINGS_PANES: readonly SettingsPaneDef[] = [
  {
    id: 'general',
    title: { en: 'General', zh: '通用' },
    groups: [
      { title: { en: 'Appearance', zh: '界面与外观' }, themeRow: true, zoomRow: true, fontRow: true, fields: [sel('language', [
        { v: 'en', l: 'English' },
        { v: 'zh-CN', l: '简体中文' },
      ])] },
      {
        title: { en: 'Paths', zh: '路径' },
        fields: [text('projectsDir'), text('userSkillsDir'), text('globalSunshine')],
      },
      { title: { en: 'Command execution', zh: '命令执行' }, fields: [text('shell')] },
    ],
  },
  {
    id: 'limits',
    title: { en: 'Context & limits', zh: '上下文与限额' },
    groups: [
      { title: { en: 'Context window', zh: '上下文窗口' }, fields: [num('contextWindow'), num('maxTokens')] },
      { title: { en: 'Subagents & team', zh: '子智能体与团队' }, fields: [num('subagentTokenCap'), num('teamTokenCap')] },
      { title: { en: 'Steps & loops', zh: '步数与循环' }, fields: [num('maxSteps'), num('maxLoopIterations'), num('maxGraphNodes')] },
      {
        title: { en: 'Safety fences', zh: '安全围栏' },
        fields: [
          sel('readFence', [
            { v: 'off', l: 'off' },
            { v: 'sensitive', l: 'sensitive' },
            { v: 'all', l: 'all' },
          ]),
          sel('sandbox', ON_OFF),
          sel('isolation', [
            { v: 'auto', l: 'auto' },
            { v: 'landlock', l: 'landlock' },
            { v: 'container', l: 'container' },
            { v: 'host', l: 'host' },
          ]),
        ],
      },
    ],
  },
  {
    id: 'memory',
    title: { en: 'Memory', zh: '记忆' },
    memoryOverview: true,
    groups: [
      { title: { en: 'Pipeline switches', zh: '管线开关' }, fields: [sel('autoMemory', ON_OFF), sel('learnedSkills', ON_OFF)] },
      { title: { en: 'Capacity & triggers', zh: '容量与触发' }, fields: [num('learnedSkillLimit'), num('memoryIdleKickMs')] },
      { title: { en: 'Turn digests', zh: '轮次摘要' }, fields: [num('stepDigestMaxSteps'), num('stepDigestItemChars'), num('stepDigestTotalChars')] },
    ],
  },
  {
    id: 'kb',
    title: { en: 'Knowledge & search', zh: '知识库与搜索' },
    groups: [
      {
        title: { en: 'Knowledge base', zh: '知识库' },
        fields: [
          sel('kbBackend', [
            { v: 'local-json', l: 'local-json' },
            { v: 'sqlite-vec', l: 'sqlite-vec' },
          ]),
          text('kbDataDir'),
        ],
      },
      { title: { en: 'Embedding', zh: 'Embedding' }, fields: [text('embeddingBaseUrl'), modelCombo('embeddingModel')] },
      {
        title: { en: 'Web search', zh: '网页搜索' },
        fields: [
          sel('websearchProvider', [
            { v: 'duckduckgo', l: 'duckduckgo' },
            { v: 'tavily', l: 'tavily' },
          ]),
          text('websearchEndpoint'),
        ],
      },
    ],
  },
];

/** 字体预设行(2026-10-26 用户裁定):四预设卡片,每卡内嵌迷你实时预览(正文行/工具行/代码行
 *  按该预设的字号行高内联渲染),点击即全局生效并持久化(theme/ui-zoom 同通路)。GUI 本地偏好,
 *  非 settings 键。名单单源在 font-preset.ts FONT_PRESET_CHOICES(D55② 收敛,加预设只改彼处) */

function FontRow(): JSX.Element {
  const [pref, setPref] = useState<FontPreset>(readFontPreset);
  return (
    <div className="sx-setting-row sx-font-row">
      <div className="sx-setting-main">
        <div className="sx-setting-title">
          <span className="sx-setting-label">{t('Font preset', '字体预设')}</span>
        </div>
        <p className="sx-setting-desc">{t('Body / thinking / tool / code typography — click a preset to apply', '正文/思考/工具/代码的字体排版——点击卡片即生效')}</p>
      </div>
      <div className="sx-setting-ctl sx-font-ctl">
        {FONT_PRESET_CHOICES.map((p) => {
          const v = presetVars(p.v);
          return (
            <button
              key={p.v}
              type="button"
              className={`sx-font-preset-card${pref === p.v ? ' active' : ''}`}
              aria-pressed={pref === p.v}
              aria-label={t(p.l.en, p.l.zh)}
              onClick={() => {
                setPref(p.v);
                applyFontPreset(p.v);
              }}
            >
              <span className="sx-font-preset-name">{t(p.l.en, p.l.zh)}</span>
              <span
                className="sx-font-pv"
                style={{ lineHeight: v['--f-body-lh'] ?? '1.6', fontSize: v['--f-base-size'], fontFamily: v['--font-ui'] }}
              >
                {t('Body text reads here. 正文预览。', 'Body text reads here. 正文预览。')}
              </span>
              <span className="sx-font-pv-tool" style={{ fontSize: v['--f-tool'] ?? '11px', lineHeight: v['--f-tool-lh'] ?? 'normal' }}>
                <span style={v['--font-mono'] !== undefined ? { fontFamily: v['--font-mono'] } : undefined}>run pnpm test --filter gui</span>
              </span>
              <span
                className="sx-font-pv-code"
                style={{
                  fontSize: v['--f-code'] ?? '11px',
                  lineHeight: v['--f-code-lh'] ?? 'normal',
                  padding: v['--f-code-pad'] ?? '6px 8px',
                  fontFamily: v['--font-mono'],
                }}
              >
                {'const x = 1;'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 外观主题行(GUI 本地偏好,非 settings 键;G9 三态持久,system 跟随系统) */
function ThemeRow(): JSX.Element {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  useEffect(() => watchSystemTheme(pref), [pref]);
  return (
    <div className="sx-setting-row">
      <div className="sx-setting-main">
        <div className="sx-setting-title">
          <span className="sx-setting-label">{t('Appearance', '外观')}</span>
        </div>
        <p className="sx-setting-desc">{t('UI theme: system / light / dark', '界面主题:跟随系统/亮色/暗色')}</p>
      </div>
      <div className="sx-setting-ctl">
      <Select
        ariaLabel="theme"
        value={pref}
        options={[
          { v: 'system', l: t('System', '跟随系统') },
          { v: 'light', l: t('Light', '亮色') },
          { v: 'dark', l: t('Dark', '暗色') },
        ]}
        onChange={(v) => {
          setPref(v as ThemePref);
          applyTheme(v as ThemePref);
        }}
      />
      </div>
    </div>
  );
}

/** 界面放缩行(GUI 本地偏好;根 zoom 全域等比——字体/图标/布局一体,见 ui-zoom.ts) */
function ZoomRow(): JSX.Element {
  const [pref, setPref] = useState<UiZoom>(readZoomPref);
  return (
    <div className="sx-setting-row">
      <div className="sx-setting-main">
        <div className="sx-setting-title">
          <span className="sx-setting-label">{t('UI zoom', '界面放缩')}</span>
        </div>
        <p className="sx-setting-desc">{t('Global zoom for fonts / icons / layout', '全局放缩字体/图标/布局')}</p>
      </div>
      <div className="sx-setting-ctl">
        <Select
          ariaLabel="ui zoom"
          value={pref}
          options={[
            { v: '0.9', l: '90%' },
            { v: '1', l: '100%' },
            { v: '1.1', l: '110%' },
            { v: '1.25', l: '125%' },
            { v: '1.5', l: '150%' },
          ]}
          onChange={(v) => {
            setPref(v as UiZoom);
            applyZoom(v as UiZoom);
          }}
        />
      </div>
    </div>
  );
}

/** 相对时间与错误文案归一:G8e-T2 抽共享 ui-util(三处本地复制收敛) */

export interface SettingsFormProps {
  readonly conn: SettingsFormConn;
  /** 项目上下文('' = 仅全局;读面归一为省参;source='project' 行的写回锚) */
  readonly root: string;
  readonly pane: SettingsPaneDef;
  /** G14.213 语言键保存后上抛(壳层 tick 重渲染——t 非响应式,本组件外的 t() 面才需要) */
  readonly onLanguageChanged?: () => void;
}

/** 改动桶(逐项写回来源文件):source='project' → project;global/default → global */

export function SettingsForm({ conn, root, pane, onLanguageChanged }: SettingsFormProps): JSX.Element {
  /** 键行表(pane 键过滤后;null = 加载中) */
  const [rows, setRows] = useState<Record<string, SettingsKeyRow> | null>(null);
  /** 输入当前值(键→字符串面;number 输入亦暂存字符串,保存时化型) */
  const [values, setValues] = useState<Record<string, string>>({});
  /** providers 现配模型去重集(combo 动态建议源;视图应答即定格) */
  const [models, setModels] = useState<string[]>([]);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [toast, setToast] = useState('');
  /** 记忆概览行数据(memoryOverview 面板拉取;null = 无/未落定) */
  const [stats, setStats] = useState<{ entries: number; lastWriteAt: number | null } | null>(null);
  /** toast 3s 自隐句柄(连续保存重置;卸载兜底清) */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** load 代计数(竞态守卫):每次发起新拉即递增;应答到达时代不齐 = 陈旧——弃,不覆写行表 */
  const loadGenRef = useRef(0);
  /** 行/值镜像(重拉保脏合并读前一态;渲染期同步——事件回调读当帧值) */
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const valuesRef = useRef(values);
  valuesRef.current = values;
  /** 自动保存串行队列:逐字段触发连发时链式排队(同文件读改写不并发交错) */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  /** 拉取:settings(root)+ 记忆面板附 memoryStats;成功落行表与输入值——**保脏合并**(自动
   *  保存轮):输入值≠前一服务端值的字段(在途未保存编辑)保留本地值,其余回落服务端值,
   *  重拉不 clobber 正在输入的行;代守卫:root 快切/保存重拉时旧应答迟到弃(终态=最新代) */
  const load = useCallback((): void => {
    const gen = ++loadGenRef.current;
    const r = root === '' ? undefined : root; // 仅全局 = 省参(空串 root 服务端不可靠)
    conn.settings(r).then(
      (view) => {
        if (loadGenRef.current !== gen) return; // 陈旧代:root 已切走,弃
        const byKey = new Map(view.keys.map((k) => [k.key, k]));
        const nextRows: Record<string, SettingsKeyRow> = {};
        const nextValues: Record<string, string> = {};
        const prevRows = rowsRef.current;
        const prevValues = valuesRef.current;
        for (const g of pane.groups) {
          for (const fd of g.fields) {
            const row = byKey.get(fd.key);
            if (row === undefined) continue; // daemon 未报键(旧版缺面)——行省略
            nextRows[fd.key] = row;
            const prevRow = prevRows?.[fd.key];
            const dirty = prevRow !== undefined && prevValues[fd.key] !== undefined && prevValues[fd.key] !== (prevRow.value ?? '');
            nextValues[fd.key] = dirty ? prevValues[fd.key] : (row.value ?? ''); // 脏字段保本地,余回落服务端
          }
        }
        setRows(nextRows);
        setValues(nextValues);
        setModels(modelsOf(view));
        setLoadError('');
      },
      (err: unknown) => {
        if (loadGenRef.current !== gen) return; // 陈旧代:错误也不落(新代在途/已落)
        setLoadError(errText(err));
      },
    );
    if (pane.memoryOverview)
      conn.memoryStats(r).then(
        (v) => {
          if (loadGenRef.current === gen) setStats(v);
        },
        () => {
          if (loadGenRef.current === gen) setStats(null);
        },
      );
  }, [conn, root, pane]);

  useEffect(() => {
    load();
  }, [load]);

  /** 卸载兜底:在途 toast 计时器不泄漏 */
  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    },
    [],
  );

  /** 单字段自动保存(入队串行):值与来源文件行相同即跳过;空值→null=delete,数字键 number 化;
   *  按行 source 归桶写回('project' → 项目档需 root;余 → 全局档)。成功 toast+重拉(保脏合并),
   *  失败错误条示出、行值保持脏(改后再触发可重试) */
  const persistField = (fd: SettingsFieldDef, raw: string): void => {
    const row = rowsRef.current?.[fd.key];
    if (row === undefined || row === null || row.envOverride) return;
    if (raw === (row.value ?? '')) return; // 未变更不写
    const v = raw === '' ? null : fd.control === 'number' ? Number(raw) : raw;
    const isProject = row.source === 'project';
    setSaveError('');
    saveChainRef.current = saveChainRef.current
      .then(() =>
        isProject
          ? root === ''
            ? Promise.reject(new Error(t('Project-level settings need a project context — open settings inside a project', '项目级配置需项目上下文——请在项目内打开设置再修改')))
            : conn.putSettings('project', root, { [fd.key]: v })
          : conn.putSettings('global', undefined, { [fd.key]: v }),
      )
      .then(() => {
        // 语言键保存即热切换 GUI chrome 双语(G10-C3c;其余键新建会话起);onLanguageChanged 上抛
        // 重渲染壳(G14.213——t 非响应式,导航/标题等本组件外的 t() 面不重拉不翻面)
        if (fd.key === 'language' && typeof v === 'string') {
          const p = parseLanguage(v);
          if (p !== undefined) {
            setLanguage(p);
            onLanguageChanged?.();
          }
        }
        setToast(t('Applied — takes effect for new sessions', '已生效：新建会话起'));
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 3_000);
        load(); // 重拉:来源徽标重归因(保脏合并——在途编辑不被 clobber)
      })
      .catch((err: unknown) => {
        setSaveError(errText(err)); // 400/409 原文行内示出;行值保持脏,可改后再触发
      });
  };

  /** 行控件装配(select 当值不在闭集内→前插现实值项保回显;combo 建议=providers 动态集) */
  const renderControl = (fd: SettingsFieldDef, row: SettingsKeyRow): JSX.Element => {
    const value = values[fd.key] ?? '';
    const disabled = row.envOverride;
    const title = row.envOverride ? t('Overridden by env — read-only', 'env 覆盖中,改文件不生效') : undefined;
    if (fd.control === 'select') {
      const base = typeof fd.options === 'function' ? fd.options({ models }) : (fd.options ?? []);
      const opts = base.some((o) => o.v === value) || value === '' ? base : [{ v: value, l: value }, ...base];
      return (
        <Select
          ariaLabel={fd.key}
          value={value}
          options={opts}
          disabled={disabled}
          title={title}
          placeholder={t('Unset', '未设置')}
          onChange={(v) => {
            setValues((vals) => ({ ...vals, [fd.key]: v }));
            persistField(fd, v); // 换项即存(自动生效轮)
          }}
        />
      );
    }
    if (fd.control === 'combo') {
      return (
        <Combo
          ariaLabel={fd.key}
          value={value}
          suggestions={models}
          disabled={disabled}
          title={title}
          placeholder={fd.placeholder}
          onChange={(v) => setValues((vals) => ({ ...vals, [fd.key]: v }))}
          onCommit={(v) => persistField(fd, v)}
        />
      );
    }
    return (
      <input
        type={fd.control === 'number' ? 'number' : 'text'}
        className="sx-setting-input"
        aria-label={fd.key}
        value={value}
        placeholder={fd.placeholder}
        disabled={disabled}
        data-tip={title}
        onChange={(e) => setValues((vals) => ({ ...vals, [fd.key]: e.target.value }))}
        onBlur={(e) => persistField(fd, e.target.value)} // 失焦即存(自动生效轮)
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); // Enter=提交(同失焦)
        }}
      />
    );
  };

  return (
    <section className="sx-settings-form sx-settings-body" aria-label={`settings pane ${pane.id}`}>
      <h2>{t(pane.title.en, pane.title.zh)}</h2>
      {pane.memoryOverview && stats !== null && (
        <div className="sx-card sx-memory-card">
          <p className="sx-memory-stats" aria-label="memory stats">
            {t(`${stats.entries} memories`, `${stats.entries} 条记忆`)}
            {stats.lastWriteAt !== null ? t(` · last write ${relTime(stats.lastWriteAt)}`, ` · 最近 ${relTime(stats.lastWriteAt)}`) : ''}
          </p>
        </div>
      )}
      {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
      {rows === null && loadError === '' && <p className="home-loading">{t('Loading settings…', '加载设置…')}</p>}
      {rows !== null &&
        pane.groups.map((g) => {
          const visible = g.fields.filter((fd) => rows[fd.key] !== undefined);
          if (!g.themeRow && visible.length === 0) return null; // daemon 未报键的组整卡省略
          return (
            <div key={g.title.en} className="sx-card sx-settings-card">
              <div className="sx-card-head">
                <span className="sx-card-title">{t(g.title.en, g.title.zh)}</span>
                {g.desc !== undefined && <span className="sx-card-desc">{t(g.desc.en, g.desc.zh)}</span>}
              </div>
              <div className="sx-card-rows">
                {g.themeRow && <ThemeRow />}
                {g.zoomRow && <ZoomRow />}
                {g.fontRow && <FontRow />}
                {visible.map((fd) => {
                  const row = rows[fd.key]!;
                  const desc = KEY_DESCRIPTIONS[fd.key];
                  return (
                    <div key={fd.key} className="sx-setting-row">
                      <div className="sx-setting-main">
                        <div className="sx-setting-title">
                          <span className="sx-setting-label">{fd.key}</span>
                          <SourceBadge source={row.source} />
                        </div>
                        {desc !== undefined && <p className="sx-setting-desc">{t(desc.en, desc.zh)}</p>}
                      </div>
                      <div className="sx-setting-ctl">{renderControl(fd, row)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      {saveError !== '' && <p className="home-error" role="alert">{saveError}</p>}
      {toast !== '' && (
        <div className="sx-toast" role="status">
          {toast}
        </div>
      )}
    </section>
  );
}
