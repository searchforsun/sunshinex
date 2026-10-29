/**
 * providers 结构化语义键装载（多源多模型清单，/model 选择卡数据源）：
 * - 两级装载整键遮蔽：项目 .sunshinex/settings.json 的 providers 键在场（含空数组）即取代全局
 *   （对标 settings 标量键「项目级覆盖全局级」，MANUAL 第二节）；两级都缺 = 无可切换模型。
 * - 单级形状非法 → 该级 warning 跳过、不致命（对标 permissions/mcp.json 非法条目跳过语义）；
 *   畸形 JSON 由 settings 装载链统一 fail-fast，此处按缺级处理。
 * - 密钥不进本键（D6 用户裁决「env 块只承载敏感字段」延续）：每个源按名取
 *   SUNSHINEX_API_KEY_<大写源名> 槽，缺省回退主槽 SUNSHINEX_API_KEY——多源密钥仍是
 *   「密钥只走 env 透传块或环境变量」，settings 与凭据分离的口径不变。
 */
import { parseSettingsFile, loadProjectSettings, loadGlobalSettings } from './settings';
import { EFFORT_ORDER, parseEffort } from '../model/effort';
import type { ModelTier, ReasoningEffort } from '../types';

/** 单个可选模型（源 × 模型展开条目）：id = `<name>/<model>`，是 /model 选择卡与 journal modelId 的稳定标识 */
export interface ModelChoice {
  id: string;
  provider: string;
  model: string;
  baseUrl: string;
  /** 该源的专用密钥槽名（SUNSHINEX_API_KEY_<大写源名>，解析时查 process.env） */
  apiKeyEnv: string;
  /** 该模型最大上下文 tokens（models 条目对象形态 contextWindow > 源级 contextWindow 缺省；
   *  undefined = 回退全局 SUNSHINEX_CONTEXT_WINDOW / 内置 200k） */
  contextWindow?: number;
  /** 该模型缺省思考强度（同两级优先级；undefined = 回退全局 reasoningEffort 键 / 端点缺省）。
   *  会话内 /model-effort 覆盖仍最高（请求级参数压适配器缺省） */
  reasoningEffort?: ReasoningEffort;
  /** 该模型是否支持图片输入（models 条目对象形态 supportsImages > 源级 supportsImages 缺省；
   *  undefined = 未声明按支持处理——乐观缺省，未声明端点由服务端自然报错） */
  supportsImages?: boolean;
  /** 该模型档位标注（models 条目对象形态声明，无源级缺省；
   *  undefined = 未标注，档位路由按缺省处理——§15 档位路由消费面） */
  tier?: ModelTier;
}

/** 源名 → 专用密钥槽名：非字母数字段折叠为单下划线（"my-provider" → SUNSHINEX_API_KEY_MY_PROVIDER） */
export function providerApiKeyEnv(name: string): string {
  return 'SUNSHINEX_API_KEY_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** 源密钥解析：专用槽 > 主槽 SUNSHINEX_API_KEY（settings env 块装载后均落 process.env）；
 *  都缺 = 未配置（与单模型口径一致：调用时由适配器报 SUNSHINEX_API_KEY is not configured） */
export function resolveProviderApiKey(name: string): string | undefined {
  const specific = process.env[providerApiKeyEnv(name)];
  if (specific !== undefined && specific !== '') return specific;
  const main = process.env.SUNSHINEX_API_KEY;
  return main !== undefined && main !== '' ? main : undefined;
}

interface LoadedProviders {
  choices: ModelChoice[];
  warnings: string[];
}

/**
 * 源级分组条目（catalog/providers 读面的数据基座，settings.json providers 键的文件结构镜像）：
 * 源级字段 = 源级显式值（非法值已被告警忽略）；models 条目 = 条目级显式值。与 ModelChoice（生效值 = 条目级 > 源级缺省）分工：本面供设置页渲染/编辑
 * 文件结构（源级缺省与逐模型覆盖的分野须保真），choices 供运行面。
 */
export interface ParsedProviderEntry {
  name: string;
  baseUrl: string;
  contextWindow?: number;
  reasoningEffort?: ReasoningEffort;
  supportsImages?: boolean;
  models: Array<{ model: string; contextWindow?: number; reasoningEffort?: ReasoningEffort; supportsImages?: boolean; tier?: ModelTier }>;
  /** 来源级归因（Task 27.5 富化，控制器 T26 评审裁定——全键遮蔽陷阱的观察面）：loadProvidersFull
   *  两级整键遮蔽裁决——项目 providers 键在场（含空数组）即整键遮蔽 → 该面全部条目 origin='project'
   *  （全局条目不可能混列）；否则（含 root:null 仅全局面）origin='global'。单级解析面（parseProvidersAll）
   *  无两级语义不盖章，由 loadProvidersFull 投影处统一 stamp（零行为变化） */
  origin: 'project' | 'global';
}

/** 单次解析全量产物（parseProvidersAll 中间形）：providers 条目尚无来源归因——单级解析不知道自己
 *  装的是哪一级（两级裁决在 loadProvidersFull），盖章后才是 ParsedProviders */
interface ParsedProvidersRaw {
  providers: Array<Omit<ParsedProviderEntry, 'origin'>>;
  choices: ModelChoice[];
  warnings: string[];
}

/** 单次解析全量产物：providers=源级分组（文件结构镜像 + origin 来源归因）、choices=展平生效值（providers 序 × models 序） */
interface ParsedProviders {
  providers: ParsedProviderEntry[];
  choices: ModelChoice[];
  warnings: string[];
}

/**
 * 单级 providers 键解析（全量内点）：`[{ "name", "baseUrl", "contextWindow?", "reasoningEffort?", "supportsImages?", "models": [{ "model", "contextWindow?", "reasoningEffort?", "supportsImages?", "tier?" }] }]`
 * 一次遍历同产源级分组（ParsedProviderEntry 去 origin 的中间形——两级来源归因由 loadProvidersFull
 * 盖章，见 stampOrigin；文件结构镜像）与展平 choices（生效值），序同为
 * providers 数组序 × models 数组序。models 条目标准形态 = 对象（2026-10-29 去兼容清理：字符串简写
 * 退役，遇之告警跳过）；逐项两级优先级 = 条目级 > 源级缺省（contextWindow / reasoningEffort /
 * supportsImages 同口径，缺省回全局链）；
 * tier 仅条目对象形态可声明（无源级缺省），非法值告警忽略档位、模型保留
 * （沿 contextWindow 同款纪律：标注值坏不连坐模型本体）。
 * 非法形态（非数组 / 条目非对象 / 缺 name / 缺 baseUrl / models 空 or 条目形态坏）→ warning 后跳过
 * （装配面宁可少配不可错配）；contextWindow / reasoningEffort 值非法 → warning 后忽略该值、模型保留
 * （窗口与强度只是预算/请求参数，跳过整个模型反而过罚）；同源同模型重复登记幂等去重。
 */
function parseProvidersAll(raw: unknown, origin: string): ParsedProvidersRaw {
  const warnings: string[] = [];
  const choices: ModelChoice[] = [];
  const providers: ParsedProvidersRaw['providers'] = [];
  if (raw === undefined) return { providers, choices, warnings };
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw)) {
    warnings.push(`settings.json providers 须为数组（${origin}），该键已忽略`);
    return { providers, choices, warnings };
  }
  const seen = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push(`settings.json providers 条目须为对象（${origin}），已跳过`);
      continue;
    }
    const e = entry as { name?: unknown; baseUrl?: unknown; contextWindow?: unknown; reasoningEffort?: unknown; supportsImages?: unknown; models?: unknown };
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (name === '') {
      warnings.push(`settings.json providers 条目缺 name（${origin}），已跳过`);
      continue;
    }
    const baseUrl = typeof e.baseUrl === 'string' ? e.baseUrl.trim() : '';
    if (baseUrl === '') {
      warnings.push(`settings.json providers.${name} 缺 baseUrl（${origin}），该源已跳过`);
      continue;
    }
    if (!Array.isArray(e.models) || e.models.length === 0) {
      warnings.push(`settings.json providers.${name} models 须为非空数组（${origin}），该源已跳过`);
      continue;
    }
    // 源级缺省（该源各模型的回退值）：非法值告警忽略
    let providerWindow: number | undefined;
    if (e.contextWindow !== undefined) {
      if (typeof e.contextWindow === 'number' && Number.isFinite(e.contextWindow) && e.contextWindow > 0) {
        providerWindow = e.contextWindow;
      } else {
        warnings.push(`settings.json providers.${name} contextWindow 须为正数（${origin}），已忽略`);
      }
    }
    let providerEffort: ReasoningEffort | undefined;
    if (e.reasoningEffort !== undefined) {
      const parsed = parseEffort(typeof e.reasoningEffort === 'string' ? e.reasoningEffort : undefined);
      if (parsed !== undefined) {
        providerEffort = parsed;
      } else {
        warnings.push(`settings.json providers.${name} reasoningEffort 须为 ${EFFORT_ORDER.join('|')}（${origin}），已忽略`);
      }
    }
    let providerImages: boolean | undefined;
    if (e.supportsImages !== undefined) {
      if (typeof e.supportsImages === 'boolean') {
        providerImages = e.supportsImages;
      } else {
        warnings.push(`settings.json providers.${name} supportsImages 须为布尔（${origin}），已忽略`);
      }
    }
    // 源级分组先于 models 遍历入列（引用共享）：条目全坏该源仍以 models:[] 留列（文件结构如实镜像）
    const models: ParsedProviderEntry['models'] = [];
    providers.push({
      name,
      baseUrl,
      models,
      ...(providerWindow !== undefined ? { contextWindow: providerWindow } : {}),
      ...(providerEffort !== undefined ? { reasoningEffort: providerEffort } : {}),
      ...(providerImages !== undefined ? { supportsImages: providerImages } : {}),
    });
    for (const item of e.models as unknown[]) {
      let model: string | undefined;
      let itemWindow: number | undefined;
      let itemEffort: ReasoningEffort | undefined;
      let itemImages: boolean | undefined;
      let itemTier: ModelTier | undefined;
      // 字符串简写退役（2026-10-29 去兼容清理）：models 条目须为对象形态，遇字符串告警跳过
      if (typeof item === 'string') {
        warnings.push(`settings.json providers.${name} models 条目须为对象形态（${origin}），已跳过`);
        continue;
      }
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const o = item as { model?: unknown; contextWindow?: unknown; reasoningEffort?: unknown; supportsImages?: unknown; tier?: unknown };
        model = typeof o.model === 'string' ? o.model.trim() : undefined;
        if (o.contextWindow !== undefined) {
          if (typeof o.contextWindow === 'number' && Number.isFinite(o.contextWindow) && o.contextWindow > 0) {
            itemWindow = o.contextWindow;
          } else {
            warnings.push(`settings.json providers.${name} models 条目 contextWindow 须为正数（${origin}），该窗口已忽略`);
          }
        }
        if (o.reasoningEffort !== undefined) {
          const parsedEffort = parseEffort(typeof o.reasoningEffort === 'string' ? o.reasoningEffort : undefined);
          if (parsedEffort !== undefined) {
            itemEffort = parsedEffort;
          } else {
            warnings.push(`settings.json providers.${name} models 条目 reasoningEffort 须为 ${EFFORT_ORDER.join('|')}（${origin}），该强度已忽略`);
          }
        }
        if (o.supportsImages !== undefined) {
          if (typeof o.supportsImages === 'boolean') {
            itemImages = o.supportsImages;
          } else {
            warnings.push(`settings.json providers.${name} models 条目 supportsImages 须为布尔（${origin}），已忽略`);
          }
        }
        if (o.tier !== undefined) {
          if (o.tier === 'small' || o.tier === 'medium' || o.tier === 'large') {
            itemTier = o.tier;
          } else {
            warnings.push(`settings.json providers.${name} models 条目 tier 须为 small|medium|large（${origin}），该档位已忽略`);
          }
        }
      }
      if (model === undefined || model === '') {
        warnings.push(`settings.json providers.${name} models 条目须为 { model, contextWindow?, reasoningEffort? } 对象（${origin}），已跳过`);
        continue;
      }
      const id = `${name}/${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({
        model,
        ...(itemWindow !== undefined ? { contextWindow: itemWindow } : {}),
        ...(itemEffort !== undefined ? { reasoningEffort: itemEffort } : {}),
        ...(itemImages !== undefined ? { supportsImages: itemImages } : {}),
        ...(itemTier !== undefined ? { tier: itemTier } : {}),
      });
      choices.push({
        id,
        provider: name,
        model,
        baseUrl,
        apiKeyEnv: providerApiKeyEnv(name),
        ...(itemWindow !== undefined ? { contextWindow: itemWindow } : providerWindow !== undefined ? { contextWindow: providerWindow } : {}),
        ...(itemEffort !== undefined ? { reasoningEffort: itemEffort } : providerEffort !== undefined ? { reasoningEffort: providerEffort } : {}),
        ...(itemImages !== undefined ? { supportsImages: itemImages } : providerImages !== undefined ? { supportsImages: providerImages } : {}),
        ...(itemTier !== undefined ? { tier: itemTier } : {}),
      });
    }
  }
  return { providers, choices, warnings };
}

/**
 * 单级 providers 键解析（既有 API 面）：展平 choices + 告警单。返回形状被既有钉子用例
 * 整体 deepEqual 锁定（恒恰 {choices, warnings} 两键），全量产物（源级分组）走 parseProvidersAll /
 * loadProvidersFull 单点——本函数只是投影，零独立解析逻辑。
 */
export function parseProvidersSpec(raw: unknown, origin: string): LoadedProviders {
  const full = parseProvidersAll(raw, origin);
  return { choices: full.choices, warnings: full.warnings };
}

/**
 * 来源归因盖章（Task 27.5 投影单点）：两级整键遮蔽裁决出的单一级别整批盖章——项目键在场全部条目
 * origin='project'（整键遮蔽下全局条目不可能混列，T26 观察面），否则 'global'。choices/warnings
 * 原样透传，条目仅增一枚来源键（零行为变化）。
 */
function stampOrigin(parsed: ParsedProvidersRaw, origin: 'project' | 'global'): ParsedProviders {
  return { providers: parsed.providers.map((e) => ({ ...e, origin })), choices: parsed.choices, warnings: parsed.warnings };
}

/**
 * 两级装载全量单点（catalog/providers 读面入口）：项目 providers 键在场即整键遮蔽全局（现状语义）；
 * root:null 仅全局（serve globalProvidersOnly 先例——缺项目上下文不伪造 cwd 相对读取）。
 * 返回源级分组（+origin 来源归因）+ 展平 choices + 告警单，一次装载同产两视图。
 */
export function loadProvidersFull(projectRoot: string | null): ParsedProviders {
  const read = (filePath: string): unknown => {
    try {
      const doc = parseSettingsFile(filePath);
      return doc === null ? undefined : doc.providers;
    } catch {
      return undefined; // 畸形 JSON 由 settings 装载链统一上报；此处按缺级处理
    }
  };
  if (projectRoot !== null) {
    const projectPath = loadProjectSettings(projectRoot);
    const project = read(projectPath);
    if (project !== undefined) return stampOrigin(parseProvidersAll(project, projectPath), 'project');
  }
  const globalPath = loadGlobalSettings();
  return stampOrigin(parseProvidersAll(read(globalPath), globalPath), 'global');
}

/** 两级装载（既有 API 面）：返回展开后的可选模型清单与告警单。投影自 loadProvidersFull，零独立装载逻辑 */
export function loadProviders(projectRoot: string | null): LoadedProviders {
  const full = loadProvidersFull(projectRoot);
  return { choices: full.choices, warnings: full.warnings };
}
