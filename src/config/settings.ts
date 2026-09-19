import * as fs from 'fs';
import * as path from 'path';
import { userConfigDir } from './env';

/**
 * 语义键 → SUNSHINEX_* 环境槽映射表（全仓唯一权威）。
 * - 只有 *API_KEY 不进本表（D6 + 用户裁决「env 块只承载敏感字段」）：密钥只走 env 透传块或环境变量，设置与凭据分离。
 * - 其余全部 SUNSHINEX_* 配置变量均语义化（含 shell 逃生口、全局约定覆盖与记忆管线参数）：settings.json 是配置的正名，环境变量不是配置的替代形态。
 */
export const SEMANTIC_KEYS: Readonly<Record<string, string>> = {
  model: 'SUNSHINEX_MODEL',
  modelSmall: 'SUNSHINEX_MODEL_SMALL',
  modelMedium: 'SUNSHINEX_MODEL_MEDIUM',
  modelLarge: 'SUNSHINEX_MODEL_LARGE',
  baseUrl: 'SUNSHINEX_BASE_URL',
  tier: 'SUNSHINEX_TIER',
  language: 'SUNSHINEX_LANGUAGE',
  contextWindow: 'SUNSHINEX_CONTEXT_WINDOW',
  structuredOutput: 'SUNSHINEX_STRUCTURED_OUTPUT',
  autoMemory: 'SUNSHINEX_AUTO_MEMORY',
  learnedSkills: 'SUNSHINEX_LEARNED_SKILLS',
  learnedSkillLimit: 'SUNSHINEX_LEARNED_SKILL_LIMIT',
  memoryIdleKickMs: 'SUNSHINEX_MEMORY_IDLE_KICK_MS',
  stepDigestMaxSteps: 'SUNSHINEX_MEMORY_STEP_DIGEST_MAX_STEPS',
  stepDigestItemChars: 'SUNSHINEX_MEMORY_STEP_DIGEST_ITEM_CHARS',
  stepDigestTotalChars: 'SUNSHINEX_MEMORY_STEP_DIGEST_TOTAL_CHARS',
  shell: 'SUNSHINEX_SHELL',
  globalSunshine: 'SUNSHINEX_GLOBAL_SUNSHINE',
  kbBackend: 'SUNSHINEX_KB_BACKEND',
  kbDataDir: 'SUNSHINEX_KB_DATA_DIR',
  dataDir: 'SUNSHINEX_DATA_DIR',
  userSkillsDir: 'SUNSHINEX_USER_SKILLS_DIR',
  embeddingBaseUrl: 'SUNSHINEX_EMBEDDING_BASE_URL',
  embeddingModel: 'SUNSHINEX_EMBEDDING_MODEL',
  websearchProvider: 'SUNSHINEX_WEBSEARCH_PROVIDER',
  websearchEndpoint: 'SUNSHINEX_WEBSEARCH_ENDPOINT',
};

/** settings.json 解析产物：semantic=根级语义键原始值（形状裁决留给 flattenSettings）；env=透传块（键名即 SUNSHINEX_* 原名） */
export interface SettingsDoc {
  semantic: Record<string, unknown>;
  env: Record<string, string>;
}

/**
 * 解析单个 settings.json（D7 容错三态 + D8 版本守卫）：
 * - 文件缺失返回 null 静默跳过（没配就是没配，不是错误）
 * - 畸形 JSON / 根非对象 / version 非 1 一律 fail-fast 抛错：静默降级会演变成「key 没生效」的排查泥潭，必须让用户看到
 * - 一切抛错 message 携带文件路径，入口层原样透出即可定位
 */
export function parseSettingsFile(filePath: string): SettingsDoc | null {
  if (!fs.existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`settings.json 解析失败（畸形 JSON）: ${filePath}: ${reason}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`settings.json 根必须是 JSON 对象: ${filePath}`);
  }
  const root = parsed as Record<string, unknown>;
  const version = root['version'] ?? 1;
  if (version !== 1) {
    throw new Error(`settings.json version 仅支持 1，收到 ${JSON.stringify(version)}，为未来 schema 演进拒载: ${filePath}`);
  }
  const semantic: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (key === 'version' || key === 'env') continue;
    semantic[key] = value;
  }
  const env: Record<string, string> = {};
  const envBlock = root['env'];
  if (envBlock !== undefined) {
    if (typeof envBlock !== 'object' || envBlock === null || Array.isArray(envBlock)) {
      throw new Error(`settings.json "env" 块必须是 JSON 对象: ${filePath}`);
    }
    for (const [key, value] of Object.entries(envBlock as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value;
      // 非字符串值静默忽略：env 块定位是环境变量透传，数字/布尔无对应语义
    }
  }
  return { semantic, env };
}

export interface FlattenResult {
  /** 展平后的 SUNSHINEX_* 槽值表（未落 process.env，仅数据） */
  slots: Record<string, string>;
  warnings: string[];
}

/**
 * 展平：语义键按映射表落槽 + env 块合并。
 * - 同槽语义键 > env 块（D3）：语义键是设置的正名，env 块只是兜底透传。
 * - 槽值统一 String() 归一：contextWindow 数字与数字字符串等价，process.env 是字符串世界。
 * - 未知语义键 / 值类型非 string|number：告警并忽略，不致命；stderr 输出属入口层职责，本层只产出数据。
 * - 空串（或纯空白）等价未配置：模板可用空串占位而不改变行为。
 */
export function flattenSettings(doc: SettingsDoc): FlattenResult {
  const slots: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(doc.semantic)) {
    const slot = SEMANTIC_KEYS[key];
    if (slot === undefined) {
      warnings.push(`settings: 未知语义键 "${key}"，已忽略`);
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      warnings.push(`settings: 语义键 "${key}" 值类型须为 string/number，收到 ${typeof value}，已忽略`);
      continue;
    }
    const normalized = String(value);
    if (normalized.trim() === '') continue; // 空串等价未配置（模板占位安全）
    slots[slot] = normalized;
  }
  for (const [key, value] of Object.entries(doc.env)) {
    if (value.trim() === '') continue; // 空串等价未配置
    if (slots[key] === undefined) slots[key] = value;
  }
  return { slots, warnings };
}

export interface ApplyResult {
  /** 实际写入 process.env 的槽位数（只填缺省语义下的真实写入计数） */
  loaded: number;
  warnings: string[];
}

/**
 * 装载：parse → flatten → 只填 process.env 未定义键（只填缺省语义）。
 * 已导出环境变量与先装层级（项目 settings）不被覆盖——装载顺序即优先级（D2）。
 * 库内零打印零退出：告警数据交入口层决定输出通道，process.exit 属入口层职责。
 */
export function applySettings(filePath: string): ApplyResult {
  const doc = parseSettingsFile(filePath);
  if (doc === null) return { loaded: 0, warnings: [] };
  const { slots, warnings } = flattenSettings(doc);
  let loaded = 0;
  for (const [slot, value] of Object.entries(slots)) {
    if (process.env[slot] === undefined) {
      process.env[slot] = value;
      loaded += 1;
    }
  }
  return { loaded, warnings };
}

/** 项目级 settings 路径：<root>/.sunshinex/settings.json（D4 两级层级；文件应入 .gitignore，env 块可含密钥） */
export function loadProjectSettings(root: string): string {
  return path.join(root, '.sunshinex', 'settings.json');
}

/** 全局 settings 路径：<userConfigDir>/settings.json（对标 ~/.claude/settings.json 惯例） */
export function loadGlobalSettings(): string {
  return path.join(userConfigDir(), 'settings.json');
}
