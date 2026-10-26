import * as fs from 'fs';
import * as path from 'path';
import { userConfigDir } from './env';
import { t } from '../i18n';

/**
 * 语义键 → SUNSHINEX_* 环境槽映射表（全仓唯一权威）。
 * - 只有 *API_KEY 不进本表（D6 + 用户裁决「env 块只承载敏感字段」）：密钥只走 env 透传块或环境变量，设置与凭据分离。
 * - SUNSHINEX_DATA_DIR 亦不进本表：它是「整目录直指」的**开发与测试专用**重定向口（测试钉数据目录、CI 隔离运行时数据），
 *   留在用户配置面即诱导误用（多工作区共用一份 sessions/memory/runs/skills，记忆索引还会跨项目注入提示词），
 *   故只保留在环境变量面，见 RETIRED_KEYS；用户级换盘一律走 projectsDir。
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
  maxTokens: 'SUNSHINEX_MAX_TOKENS',
  subagentTokenCap: 'SUNSHINEX_SUBAGENT_TOKEN_CAP',
  teamTokenCap: 'SUNSHINEX_TEAM_TOKEN_CAP',
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
  readFence: 'SUNSHINEX_READ_FENCE',
  sandbox: 'SUNSHINEX_SANDBOX',
  isolation: 'SUNSHINEX_ISOLATION',
};

/**
 * 退役语义键 → 处置提示（只提示、不落槽）：曾在本表、因语义与用户预期相悖而摘除的键。
 * 与「未知键」分开登记——未知键是拼错，退役键是配置面主动收回，两者的处置指引不同：
 * 前者提示改拼，后者必须指出「换成哪个键、以及为什么不能再写这里」。
 */
export const RETIRED_KEYS: Readonly<Record<string, string>> = {
  dataDir: 'dataDir 须走 projectsDir（按工作区分目录隔离）；SUNSHINEX_DATA_DIR 是开发与测试专用重定向口，用户配置面以 projectsDir 为准',
  structuredOutput: 'structuredOutput 不存在：工具调用恒走原生 function calling（tools 字段下发），要求端点支持 function calling，无结构化输出开关',
};

/** settings.json 解析产物：semantic=根级语义键原始值（形状裁决留给 flattenSettings）；env=透传块（键名即 SUNSHINEX_* 原名） */
interface SettingsDoc {
  semantic: Record<string, unknown>;
  env: Record<string, string>;
  /** permissions 结构化语义键原值（spec 5.2）：形状裁决在 config/permissions.ts，不经 flatten/env 槽 */
  permissions?: unknown;
  /** providers 结构化语义键原值（多源多模型清单，/model 选择卡数据源）：形状裁决在 config/providers.ts，不经 flatten/env 槽 */
  providers?: unknown;
  /** plugins 结构化语义键原值（插件启用态与 config，两级装载合并见 config/plugins.ts）：形状裁决在 config/plugins.ts，不经 flatten/env 槽 */
  plugins?: unknown;
  /** imageHistoryLimit 结构化语义键原值（图片历史渲染半径，spec §3.2）：形状裁决在 config/image-history.ts，不经 flatten/env 槽 */
  imageHistoryLimit?: unknown;
}

/**
 * 剥掉 JSONC 注释（行注释 `//`、跨行块注释）并容忍 UTF-8 BOM。
 * 为什么容忍：MANUAL.md 的配置模板自带解释性注释（模板以 jsonc 呈现），解析口径必须与模板一致——
 * 否则「照抄模板」等于「启动即失败」，用户拿到的是一个位置坐标齐全却毫无头绪的开始。
 * 为什么逐字符状态机而不是正则：`//` 在字符串里是普通字符，baseUrl 的 `https://…` 首当其冲，
 * 正则剥离会把 URL 拦腰截断（静默改值比报错更糟）；同时须处理转义引号防提前收串。
 * 块注释按原样吞掉但保留其跨行数，使 JSON.parse 报错行号仍指向用户文件里的真实位置。
 * 尾随逗号不在容忍之列：仍按严格 JSON 报错（既有钉子用例覆盖），口径见 MANUAL.md。
 */
/** 剥注释文本（导出供 daemon 测试复验注释保留式手术写产物;行为同 parseSettingsFile 内口径） */
export function stripJsonComments(input: string): string {
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
 * - JSONC 注释（行注释 `//`、跨行块注释）与 UTF-8 BOM 容忍：MANUAL.md 的配置模板自带解释性注释，
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
  let permissions: unknown = undefined;
  let providers: unknown = undefined;
  let plugins: unknown = undefined;
  let imageHistoryLimit: unknown = undefined;
  for (const [key, value] of Object.entries(root)) {
    if (key === 'version' || key === 'env') continue;
    if (key === 'permissions') {
      permissions = root[key] as unknown;
      continue;
    }
    if (key === 'providers') {
      providers = root[key] as unknown;
      continue;
    }
    if (key === 'plugins') {
      plugins = root[key] as unknown;
      continue;
    }
    if (key === 'imageHistoryLimit') {
      imageHistoryLimit = root[key] as unknown;
      continue;
    }
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
  return { semantic, env, permissions, providers, plugins, imageHistoryLimit };
}

interface FlattenResult {
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

interface ApplyResult {
  /** 实际写入 process.env 的槽位数（只填缺省语义下的真实写入计数） */
  loaded: number;
  warnings: string[];
}

/** 本进程装载链自填的 SUNSHINEX_* 槽登记（G8c T2 /settings 来源分层的判据）：applySettings 只填
 *  缺省槽时单点登记——「槽在 env 但非自填」即真导出环境变量（恒最优先，GUI 禁编+徽标）；自填即
 *  来自文件链（项目/全局级可编辑）。daemon 不自行调链（CLI 入口先跑、daemon 继承其 env），本登记
 *  因此覆盖链的所有跑法：无论谁调 applySettings，登记面同一。 */
const selfFilledSlots = new Set<string>();

/** 本进程经装载链自填的槽名快照（只读视图；PUT /settings 重载链以此为清除清单） */
export function getSelfFilledSlots(): readonly string[] {
  return [...selfFilledSlots];
}

/** 清空自填登记：PUT /settings 成功后重载链前的清场步骤（删 env 槽 + 清集 → applySettings 按新
 *  文件态重登记）。清集必须在删槽之后、重装之前——否则已删槽的陈旧登记会让下次重载误删真导出值。 */
export function resetSelfFilledSlots(): void {
  selfFilledSlots.clear();
}

/** 文本是否含 JSONC 注释（G8c T2 PUT /settings 的 409 判据）：与 stripJsonComments 同一状态机口径
 *  （raw !== stripped），BOM 不误报（先剥 BOM 再比对）。含注释文件的结构化写走 surgicalSettingsUpdate
 *  （注释保留式逐行手术），本函数仍是不支持形态（多行值等）回退 409 引流 raw 编辑面的判定单点。 */
export function hasJsonComments(text: string): boolean {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return stripJsonComments(src) !== src;
}

/**
 * 注释保留式结构化改写（设置自动保存轮）：带 JSONC 注释的 settings 文本上做逐行手术——只动
 * updates 指名的根级键，行尾注释/缩进/空行/其余键原样保留。设计域：语义键值恒为单行标量
 * （string/number，updates 校验面保证；多行/对象/数组值不在域内 → 返回 null，调用方回退 409）。
 * - 改值：定位根级键行，重写「键: 值」段，行尾逗号与注释逐字保留；
 * - 删值（null）：整行移除，随后的逗号修整遍清掉悬挂逗号（严格 JSON 本就禁尾随逗号，剥之恒安全）；
 * - 增值：根 `{` 行后插入新键行（尾随逗号由修整遍兜底）。
 * 产出一律经 JSON.parse(剥注释) 复验：不可解析或未触及键值漂移 → 返回 null（调用方 409，零盘上副作用）。
 * BOM 原样保真；行注释 `//` 与跨行块注释状态机口径与 stripJsonComments 一致。
 */
export function surgicalSettingsUpdate(
  raw: string,
  updates: Record<string, string | number | null>,
): string | null {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const src = bom ? raw.slice(1) : raw;
  const lines = src.split('\n');
  const pending: Record<string, string | number | null> = { ...updates };
  const out: string[] = [];
  let depth = 0; // 未闭合 '{' 计数:根对象开括号后 =1,根级键行即 depth 1(嵌套对象/数组元素 ≥2)
  let inString = false;
  let inBlock = false;
  let rootOpenLine = -1; // 根 `{` 所在行(插入新键锚点;要求 `{` 独占一行——单行对象不支持 → null)

  /** 行内字符扫描:维护 inString/inBlock/depth;返回值段信息(仅根级键行有意义) */
  const scanLine = (
    line: string,
  ): { key: string; prefix: string; hadComma: boolean; suffix: string } | { nested: true } | null => {
    let i = 0;
    let key: string | null = null;
    let colon = -1;
    while (i < line.length) {
      const ch = line[i]!;
      if (inBlock) {
        if (ch === '*' && line[i + 1] === '/') {
          inBlock = false;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (inString) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '"') inString = false;
        i += 1;
        continue;
      }
      if (ch === '/' && line[i + 1] === '/') return key === null ? null : { key, prefix: line.slice(0, colon < 0 ? i : colon), hadComma: false, suffix: line.slice(colon < 0 ? i : i) };
      if (ch === '/' && line[i + 1] === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      if (ch === '"') {
        // 根级字符串:可能是键(后随 ':')——收键串
        if (depth === 1 && key === null) {
          let j = i + 1;
          while (j < line.length && line[j] !== '"') {
            if (line[j] === '\\') j += 1;
            j += 1;
          }
          if (j >= line.length) return null; // 键串未闭合(畸形)→ 交由复验/409
          let k = j + 1;
          while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k += 1;
          if (line[k] === ':') {
            key = line.slice(i + 1, j);
            let m = k + 1;
            while (m < line.length && (line[m] === ' ' || line[m] === '\t')) m += 1;
            colon = m; // 前缀含冒号后空白:重建行保持原「键: 值」间距样式
            i = m;
            continue;
          }
        }
        inString = true;
        i += 1;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    return key === null ? null : { key, prefix: line.slice(0, colon), hadComma: false, suffix: '' };
  };

  /** 值段解析:自 colon 起扫标量值(string/number/true/false/null),返回 [值尾, 其后是否有逗号];
   *  值为多行/嵌套({/[ 开)→ null(不在手术域) */
  const scanValue = (
    line: string,
    from: number,
  ): { end: number; hadComma: boolean } | null => {
    let i = from;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
    if (i >= line.length) return null; // 值在后续行(多行值)→ 不在域内
    if (line[i] === '{' || line[i] === '[') return null;
    if (line[i] === '"') {
      i += 1;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i += 1;
        i += 1;
      }
      if (i >= line.length) return null; // 串未闭合(值跨行)
      i += 1;
    } else {
      while (i < line.length && line[i] !== ',' && !(line[i] === '/' && line[i + 1] === '/')) i += 1;
      const token = line.slice(from, i).trim();
      if (token === '' || /[{[\n]/.test(token)) return null;
    }
    let hadComma = false;
    let j = i;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j += 1;
    if (line[j] === ',') {
      hadComma = true;
      i = j + 1;
    }
    return { end: i, hadComma };
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '{' && depth === 0 && rootOpenLine === -1) {
      rootOpenLine = out.length; // 根开括号行(独占一行才可作插入锚)
    }
    const info = scanLine(line);
    if (info !== null && 'key' in info && depth === 1 && Object.hasOwn(pending, info.key)) {
      const key = info.key;
      const v = pending[key];
      delete pending[key];
      if (v === null) continue; // 删键:整行移出输出(逗号修整遍兜底悬挂逗号)
      const val = scanValue(line, info.prefix.length);
      if (val === null) return null; // 多行/嵌套值不在手术域 → 调用方 409
      const suffix = line.slice(val.end); // 行尾注释/空白逐字保留
      out.push(`${info.prefix}${JSON.stringify(v)}${val.hadComma ? ',' : ''}${suffix}`);
      continue;
    }
    out.push(line);
    // 行内块注释收口后的深度已由 scanLine 维护;此处无需额外动作
  }

  // 增键:根 `{` 行后逐行插入(尾随逗号交修整遍;待插键含 null=删不存在的键 → 无事)
  const inserts = Object.entries(pending).filter(([, v]) => v !== null);
  if (inserts.length > 0) {
    if (rootOpenLine === -1) return null; // 单行对象/无根括号 → 不在域内
    let at = rootOpenLine + 1;
    for (const [k, v] of inserts) {
      out.splice(at, 0, `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
      at += 1;
    }
  }

  // 逗号修整:剥「逗号 + 空白 + }/]」(严格 JSON 本禁尾随逗号,剥之恒安全;删键/插入的悬挂逗号兜底)
  let text = out.join('\n');
  {
    let res = '';
    let i = 0;
    let s = false;
    while (i < text.length) {
      const ch = text[i]!;
      if (s) {
        res += ch;
        if (ch === '\\') {
          res += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (ch === '"') s = false;
        i += 1;
        continue;
      }
      if (ch === '"') {
        s = true;
        res += ch;
        i += 1;
        continue;
      }
      if (ch === ',') {
        let j = i + 1;
        while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j += 1;
        if (text[j] === '}' || text[j] === ']') {
          i += 1; // 跳过逗号,不输出
          continue;
        }
      }
      res += ch;
      i += 1;
    }
    text = res;
  }

  // 复验:剥注释后必须可解析,且未触及键的原值逐字不漂移(可解析但语义漂移同样拒绝)
  try {
    const before = JSON.parse(stripJsonComments(src)) as Record<string, unknown>;
    const after = JSON.parse(stripJsonComments(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(updates)) {
      if (v === null ? after[k] !== undefined : JSON.stringify(after[k]) !== JSON.stringify(v)) return null;
    }
    for (const k of Object.keys(before)) {
      if (!Object.hasOwn(updates, k) && JSON.stringify(after[k]) !== JSON.stringify(before[k])) return null;
    }
    for (const k of Object.keys(after)) {
      if (!Object.hasOwn(before, k) && !Object.hasOwn(updates, k)) return null;
    }
  } catch {
    return null;
  }
  return (bom ? '﻿' : '') + text;
}

/**
 * 装载：parse → flatten → 只填 process.env 未定义键（只填缺省语义）。
 * 已导出环境变量与先装层级（项目 settings）不被覆盖——装载顺序即优先级（D2）。
 * 只填缺省写入时登记自填槽（selfFilledSlots——见上；G8c T2 /settings 来源分层判据）。
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
      selfFilledSlots.add(slot);
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

/**
 * 两级 settings 装载（项目级 → 全局级）收口单点（R1 收敛：src/index.ts 与 src/cli/index.ts 双胞胎合一）：
 * applySettings 只填缺省槽，先装者不被覆盖，装载顺序即优先级。抛错（畸形 JSON / version 非 1）属 fail-fast：
 * 本函数透出含文件路径的错误信息并退出非零——静默降级会演变成「配置没生效」的排查泥潭；
 * warnings 经 stderr 逐行双语输出（外观通道；applySettings 等库层数据函数零打印零退出，出口职责独归本函数）。
 */
export function loadSettingsChain(projectRoot: string): void {
  try {
    for (const result of [applySettings(loadProjectSettings(projectRoot)), applySettings(loadGlobalSettings())]) {
      for (const w of result.warnings) console.error(t(`settings warning: ${w}`, `settings 警告：${w}`));
    }
  } catch (err) {
    console.error(t(
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err.message : String(err),
    ));
    process.exit(1);
  }
}
