import * as fs from 'fs';
import * as path from 'path';
import { userConfigDir } from './env';

/**
 * 语义键 → SUNSHINEX_* 环境槽映射表（全仓唯一权威）。
 * - 只有 *API_KEY 不进本表（D6 + 用户裁决「env 块只承载敏感字段」）：密钥只走 env 透传块或环境变量，设置与凭据分离。
 * - SUNSHINEX_DATA_DIR 亦不进本表（用户裁决 2026-09-19）：它是「整目录直指、不按工作区隔离」的口子，
 *   留在用户配置面即诱导误用（多工作区共用一份 sessions/memory/runs/skills，记忆索引还会跨项目注入提示词），
 *   故只作测试与多实例口保留在环境变量面，见 RETIRED_KEYS；用户级换盘一律走 projectsDir。
 * - 其余全部 SUNSHINEX_* 配置变量均语义化（含 shell 逃生口、全局约定覆盖与记忆管线参数）：settings.json 是配置的正名，环境变量不是配置的替代形态。
 */
export const SEMANTIC_KEYS: Readonly<Record<string, string>> = {
  model: 'SUNSHINEX_MODEL',
  modelSmall: 'SUNSHINEX_MODEL_SMALL',
  modelMedium: 'SUNSHINEX_MODEL_MEDIUM',
  modelLarge: 'SUNSHINEX_MODEL_LARGE',
  baseUrl: 'SUNSHINEX_BASE_URL',
  tier: 'SUNSHINEX_TIER',
  reasoningEffort: 'SUNSHINEX_REASONING_EFFORT',
  language: 'SUNSHINEX_LANGUAGE',
  contextWindow: 'SUNSHINEX_CONTEXT_WINDOW',
  autoMemory: 'SUNSHINEX_AUTO_MEMORY',
  learnedSkills: 'SUNSHINEX_LEARNED_SKILLS',
  learnedSkillLimit: 'SUNSHINEX_LEARNED_SKILL_LIMIT',
  memoryIdleKickMs: 'SUNSHINEX_MEMORY_IDLE_KICK_MS',
  stepDigestMaxSteps: 'SUNSHINEX_MEMORY_STEP_DIGEST_MAX_STEPS',
  stepDigestItemChars: 'SUNSHINEX_MEMORY_STEP_DIGEST_ITEM_CHARS',
  stepDigestTotalChars: 'SUNSHINEX_MEMORY_STEP_DIGEST_TOTAL_CHARS',
  maxSteps: 'SUNSHINEX_MAX_STEPS',
  maxLoopIterations: 'SUNSHINEX_MAX_LOOP_ITERATIONS',
  maxGraphNodes: 'SUNSHINEX_MAX_GRAPH_NODES',
  shell: 'SUNSHINEX_SHELL',
  globalSunshine: 'SUNSHINEX_GLOBAL_SUNSHINE',
  kbBackend: 'SUNSHINEX_KB_BACKEND',
  kbDataDir: 'SUNSHINEX_KB_DATA_DIR',
  projectsDir: 'SUNSHINEX_PROJECTS_DIR',
  userSkillsDir: 'SUNSHINEX_USER_SKILLS_DIR',
  embeddingBaseUrl: 'SUNSHINEX_EMBEDDING_BASE_URL',
  embeddingModel: 'SUNSHINEX_EMBEDDING_MODEL',
  websearchProvider: 'SUNSHINEX_WEBSEARCH_PROVIDER',
  websearchEndpoint: 'SUNSHINEX_WEBSEARCH_ENDPOINT',
};

/**
 * 退役语义键 → 处置提示（只提示、不落槽）：曾在本表、因语义与用户预期相悖而摘除的键。
 * 与「未知键」分开登记——未知键是拼错，退役键是配置面主动收回，两者的处置指引不同：
 * 前者提示改拼，后者必须指出「换成哪个键、以及为什么不能再写这里」。
 */
export const RETIRED_KEYS: Readonly<Record<string, string>> = {
  dataDir: 'dataDir 已退役（整目录直指、不按工作区隔离，多项目共用一份记忆与账本）；换盘请改用 projectsDir',
  structuredOutput: 'structuredOutput 已退役（SUNSHINEX_STRUCTURED_OUTPUT 同废）：工具调用恒走原生 function calling（tools 字段下发），要求端点支持 function calling，无结构化输出开关',
};

/** settings.json 解析产物：semantic=根级语义键原始值（形状裁决留给 flattenSettings）；env=透传块（键名即 SUNSHINEX_* 原名） */
export interface SettingsDoc {
  semantic: Record<string, unknown>;
  env: Record<string, string>;
}

/**
 * 剥掉 JSONC 注释（行注释 `//`、跨行块注释）并容忍 UTF-8 BOM。
 * 为什么容忍：TUI-MANUAL 的配置模板自带解释性注释（模板以 jsonc 呈现），解析口径必须与模板一致——
 * 否则「照抄模板」等于「启动即失败」，用户拿到的是一个位置坐标齐全却毫无头绪的开始。
 * 为什么逐字符状态机而不是正则：`//` 在字符串里是普通字符，baseUrl 的 `https://…` 首当其冲，
 * 正则剥离会把 URL 拦腰截断（静默改值比报错更糟）；同时须处理转义引号防提前收串。
 * 块注释按原样吞掉但保留其跨行数，使 JSON.parse 报错行号仍指向用户文件里的真实位置。
 * 尾随逗号不在容忍之列：仍按严格 JSON 报错（既有钉子用例覆盖），口径见 TUI-MANUAL。
 */
function stripJsonComments(input: string): string {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input; // 记事本另存为 UTF-8 会带 BOM
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1]!; // 转义序列整体带过：防 \" 提前收串后把后续 // 误判为注释
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1; // 行注释吃到行尾；换行本身留给解析器
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2; // 未闭合块注释吞到文末：截断后由 JSON.parse 如实报错
      for (const c of src.slice(i, stop)) if (c === '\n') out += '\n';
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 解析单个 settings.json（D7 容错三态 + D8 版本守卫）：
 * - 文件缺失返回 null 静默跳过（没配就是没配，不是错误）
 * - JSONC 注释（行注释 `//`、跨行块注释）与 UTF-8 BOM 容忍：TUI-MANUAL 的配置模板自带解释性注释，
 *   解析口径必须与模板一致，否则照抄模板即启动失败；尾随逗号不在容忍之列，仍按严格 JSON 报错
 * - 畸形 JSON / 根非对象 / version 非 1 一律 fail-fast 抛错：静默降级会演变成「key 没生效」的排查泥潭，必须让用户看到
 * - 一切抛错 message 携带文件路径，入口层原样透出即可定位
 */
export function parseSettingsFile(filePath: string): SettingsDoc | null {
  if (!fs.existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(fs.readFileSync(filePath, 'utf8')));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`settings.json 解析失败（畸形 JSON；注释与 BOM 已容忍）: ${filePath}: ${reason}`);
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
      const retired = RETIRED_KEYS[key];
      warnings.push(retired === undefined ? `settings: 未知语义键 "${key}"，已忽略` : `settings: ${retired}`);
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
