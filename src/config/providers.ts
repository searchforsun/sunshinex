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
import type { ReasoningEffort } from '../types';

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

export interface LoadedProviders {
  choices: ModelChoice[];
  warnings: string[];
}

/**
 * 单级 providers 键解析：`[{ "name", "baseUrl", "contextWindow?", "reasoningEffort?", "models": ["m" | { "model", "contextWindow?", "reasoningEffort?" }] }]`
 * 逐源展开为 ModelChoice 列表。models 条目两形态：字符串（模型名）与对象（模型名 + 每模型覆盖）；
 * 逐项两级优先级 = 条目级 > 源级缺省（contextWindow / reasoningEffort 同口径，缺省回全局链）。
 * 非法形态（非数组 / 条目非对象 / 缺 name / 缺 baseUrl / models 空 or 条目形态坏）→ warning 后跳过
 * （装配面宁可少配不可错配）；contextWindow / reasoningEffort 值非法 → warning 后忽略该值、模型保留
 * （窗口与强度只是预算/请求参数，跳过整个模型反而过罚）；同源同模型重复登记幂等去重。
 */
export function parseProvidersSpec(raw: unknown, origin: string): LoadedProviders {
  const warnings: string[] = [];
  const choices: ModelChoice[] = [];
  if (raw === undefined) return { choices, warnings };
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw)) {
    warnings.push(`settings.json providers 须为数组（${origin}），该键已忽略`);
    return { choices, warnings };
  }
  const seen = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push(`settings.json providers 条目须为对象（${origin}），已跳过`);
      continue;
    }
    const e = entry as { name?: unknown; baseUrl?: unknown; contextWindow?: unknown; reasoningEffort?: unknown; models?: unknown };
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
    for (const item of e.models as unknown[]) {
      let model: string | undefined;
      let itemWindow: number | undefined;
      let itemEffort: ReasoningEffort | undefined;
      if (typeof item === 'string') {
        model = item.trim();
      } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const o = item as { model?: unknown; contextWindow?: unknown; reasoningEffort?: unknown };
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
      }
      if (model === undefined || model === '') {
        warnings.push(`settings.json providers.${name} models 条目须为模型名字符串或 { model, contextWindow?, reasoningEffort? } 对象（${origin}），已跳过`);
        continue;
      }
      const id = `${name}/${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      choices.push({
        id,
        provider: name,
        model,
        baseUrl,
        apiKeyEnv: providerApiKeyEnv(name),
        ...(itemWindow !== undefined ? { contextWindow: itemWindow } : providerWindow !== undefined ? { contextWindow: providerWindow } : {}),
        ...(itemEffort !== undefined ? { reasoningEffort: itemEffort } : providerEffort !== undefined ? { reasoningEffort: providerEffort } : {}),
      });
    }
  }
  return { choices, warnings };
}

/** 两级装载：项目 providers 键在场即整键遮蔽全局；返回展开后的可选模型清单与告警单 */
export function loadProviders(projectRoot: string): LoadedProviders {
  const projectPath = loadProjectSettings(projectRoot);
  const read = (filePath: string): unknown => {
    try {
      const doc = parseSettingsFile(filePath);
      return doc === null ? undefined : doc.providers;
    } catch {
      return undefined; // 畸形 JSON 由 settings 装载链统一上报；此处按缺级处理
    }
  };
  const project = read(projectPath);
  if (project !== undefined) return parseProvidersSpec(project, projectPath);
  const globalPath = loadGlobalSettings();
  return parseProvidersSpec(read(globalPath), globalPath);
}
