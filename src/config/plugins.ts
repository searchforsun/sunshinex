import * as fs from 'fs';
import * as path from 'path';
import { parseSettingsFile, loadGlobalSettings, loadProjectSettings } from './settings';
import { userConfigDir } from './env';
import type { McpServerConfig } from '../types';

/** 插件 manifest 规范（manifestVersion 1）解析与类型单点——两级装载、MCP 名单合成、校验 CLI 同源消费。
 *  校验规则 artifact：plugins/schema/plugin-manifest.schema.json（draft-07，随包分发供编辑器补全/第三方预检）；
 *  运行时校验为手写类型守卫（主仓零依赖新增红线，不引 ajv/zod）。
 *  容错纪律沿 parseMcpJsonFile（src/config.ts）：文件缺失/非法 JSON/必填缺失/类型矛盾 → errors + manifest null（整插件跳过）；
 *  可选字段坏值/坏条目 → 告警 + 忽略该键或该条（宁可少配不可错配）。 */
export interface McpSafetyDecl {
  /** 直接执行类：免问线工具短名清单 */
  act?: string[];
  /** 硬确认类：每次执行须用户确认 */
  confirm?: string[];
  /** 只读观察类 */
  observe?: string[];
}

/** 插件贡献的 MCP server 条目 = McpServerConfig 基础上 safety?/configArgs?/configEnv?（+ cwd/configDefaults 装载面）。
 *  transport v1 仅 stdio（出现 http/sse 该条告警跳过——远程 server 支持后置）；name 来自 mcpServers 键。
 *  configArgs/configEnv/configDefaults 为装配期展开面：settings 插件 config 缺省值合并（configDefaults）后
 *  展开 args 模板（configArgs，`{value}` 占位替换、布尔 true → 纯旗标）与环境变量（configEnv，值字符串化） */
export interface McpServerContrib {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio';
  /** 子进程工作目录；"." = 插件目录（装载面解析为插件根绝对路径） */
  cwd?: string;
  /** 声明式安全三类（spec §2.4）：guard 按声明驱动问线，未声明工具走通用 MCP 审批（fail-closed 兜底） */
  safety?: McpSafetyDecl;
  configArgs?: Record<string, string[]>;
  configEnv?: Record<string, string>;
  configDefaults?: Record<string, unknown>;
}

/** 插件 manifest（manifestVersion 1），字段语义见 plugins/schema/plugin-manifest.schema.json 与 spec §2.2 字段表 */
export interface PluginManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  /** process.platform 值；缺省全平台，不匹配 = 不可用。元素只校验字符串不锁枚举（Node 平台名集合随运行时变化），类型面收窄仅供展示/过滤消费 */
  platforms?: NodeJS.Platform[];
  /** 缺省 false；仅 settings 未配置时初值 */
  defaultEnabled?: boolean;
  mcpServers?: Record<string, Omit<McpServerContrib, 'name'>>;
  /** 插件内技能目录（相对插件根），并入技能装载链（优先级最低） */
  skills?: string[];
  /** 设置页展示用 config 键说明（v1 仅展示，不强校验 config 值，故条目形状不深校验） */
  configSchema?: Record<string, { type: string; description?: string }>;
  /** settings 语义键 plugins[id].config 的镜像载体（浅对象，键值自由） */
  config?: Record<string, unknown>;
}

const KNOWN_KEYS = new Set(['manifestVersion', 'id', 'name', 'version', 'description', 'platforms', 'defaultEnabled', 'mcpServers', 'skills', 'configSchema', 'config']);
/** 保留贡献点名（v1 未实现）：出现即告警「已忽略」，名字留作前向兼容（进程内工具贡献/hooks 等留位） */
const RESERVED = ['commands', 'hooks', 'agents', 'tools'] as const;
const REQUIRED: Array<keyof PluginManifest> = ['manifestVersion', 'id', 'name', 'version', 'description'];
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 形状小工具（与 parseMcpJsonFile 同形）：字符串数组 / 字符串到字符串映射 / 浅对象 */
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
const strRecord = (v: unknown): Record<string, string> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')
    ? (v as Record<string, string>)
    : undefined;
const objRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * mcpServers 逐条形状校验（与 parseMcpJsonFile 同纪律：坏条目跳过+告警，不整插件拒）。
 * 两级容错口径：
 * - 声明面 fail-closed：safety 在场但形状矛盾 → 整条跳过（不落半份声明——丢 safety 继续跑会让本该
 *   硬确认的工具静默失去问线，违背「宁可少配不可错配」）；safety 内未知类别仅告警（已声明类别保持原样）。
 * - 功能面 fail-soft：args/env/cwd/configArgs/configEnv/configDefaults 坏值 → 该键告警忽略，条目保留。
 */
function parseMcpServerContrib(name: string, cfg: unknown, warnings: string[]): Omit<McpServerContrib, 'name'> | null {
  const skip = (reason: string): null => {
    warnings.push(`mcpServers.${name}: ${reason}，条目跳过`);
    return null;
  };
  const drop = (field: string): void => {
    warnings.push(`mcpServers.${name}.${field}: 形状矛盾，已忽略该键`);
  };
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return skip('条目须为对象');
  const c = cfg as Record<string, unknown>;
  if (c.transport !== undefined && c.transport !== 'stdio') return skip(`transport 仅支持 stdio（${String(c.transport)} 远程后置）`);
  const command = typeof c.command === 'string' && c.command !== '' ? c.command : undefined;
  if (command === undefined) return skip('缺 command（transport v1 仅 stdio）');
  let safety: McpSafetyDecl | undefined;
  if (c.safety !== undefined) {
    const s = objRecord(c.safety);
    if (!s) return skip('safety 须为对象（声明矛盾不落半份）');
    const act = s.act === undefined ? undefined : strArr(s.act);
    const confirm = s.confirm === undefined ? undefined : strArr(s.confirm);
    const observe = s.observe === undefined ? undefined : strArr(s.observe);
    if ((s.act !== undefined && act === undefined) || (s.confirm !== undefined && confirm === undefined) || (s.observe !== undefined && observe === undefined)) {
      return skip('safety 三类（act/confirm/observe）须为字符串数组');
    }
    for (const k of Object.keys(s)) if (k !== 'act' && k !== 'confirm' && k !== 'observe') warnings.push(`mcpServers.${name}.safety.${k}: 未知类别，已忽略`);
    safety = { ...(act !== undefined ? { act } : {}), ...(confirm !== undefined ? { confirm } : {}), ...(observe !== undefined ? { observe } : {}) };
  }
  const args = c.args === undefined ? undefined : strArr(c.args);
  if (c.args !== undefined && args === undefined) drop('args');
  const env = c.env === undefined ? undefined : strRecord(c.env);
  if (c.env !== undefined && env === undefined) drop('env');
  const cwd = typeof c.cwd === 'string' ? c.cwd : undefined;
  if (c.cwd !== undefined && cwd === undefined) drop('cwd');
  let configArgs: Record<string, string[]> | undefined;
  if (c.configArgs !== undefined) {
    const raw = objRecord(c.configArgs);
    if (raw && Object.values(raw).every((v) => strArr(v) !== undefined)) configArgs = raw as Record<string, string[]>;
    else drop('configArgs');
  }
  const configEnv = c.configEnv === undefined ? undefined : strRecord(c.configEnv);
  if (c.configEnv !== undefined && configEnv === undefined) drop('configEnv');
  let configDefaults: Record<string, unknown> | undefined;
  if (c.configDefaults !== undefined) {
    configDefaults = objRecord(c.configDefaults);
    if (!configDefaults) drop('configDefaults');
  }
  return {
    command,
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(c.transport === 'stdio' ? { transport: 'stdio' as const } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(safety !== undefined ? { safety } : {}),
    ...(configArgs !== undefined ? { configArgs } : {}),
    ...(configEnv !== undefined ? { configEnv } : {}),
    ...(configDefaults !== undefined ? { configDefaults } : {}),
  };
}

/** 解析插件目录下的 plugin.json（manifestVersion 1）。
 *  - errors 非空 ⇒ manifest null（文件缺失/非法 JSON/非对象/未知 manifestVersion/必填缺失/id 非规范）；
 *  - warnings 独立累积（保留键/未知字段/可选键坏值/mcpServers 坏条目），manifest 存在时也照常带回。
 *  产物为逐字段重建的干净对象（非原样透传）：保留键与未知字段不进产物，坏键剔除。 */
export function parsePluginManifest(dir: string): { manifest: PluginManifest | null; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const file = path.join(dir, 'plugin.json');
  if (!fs.existsSync(file)) return { manifest: null, warnings, errors: [`manifest missing: ${file}`] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { manifest: null, warnings, errors: [`plugin.json 非法 JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { manifest: null, warnings, errors: ['plugin.json 须为对象'] };
  const o = raw as Record<string, unknown>;
  // manifestVersion 前向兼容锚：未知 major 拒载（同 major 演进走可选字段，不落在此整数值）
  if (o.manifestVersion !== 1) {
    errors.push(`不支持的 manifestVersion: ${String(o.manifestVersion)}（支持 1）`);
    return { manifest: null, warnings, errors };
  }
  for (const k of RESERVED) if (k in o) warnings.push(`贡献点 ${k} 本版本未实现，已忽略`);
  for (const k of Object.keys(o)) if (!KNOWN_KEYS.has(k) && !RESERVED.includes(k as never)) warnings.push(`未知字段 ${k} 已忽略`);
  for (const k of REQUIRED) if (k !== 'manifestVersion' && typeof o[k] !== 'string') errors.push(`缺必填字段 ${k}`);
  // version 仅非空字符串口径（semver 供展示与排序，不做严格校验）；id 空值由 ID_RE 兜底
  if (typeof o.version === 'string' && o.version === '') errors.push('version 须非空字符串');
  const id = typeof o.id === 'string' ? o.id : '';
  if (typeof o.id === 'string' && !ID_RE.test(id)) errors.push(`id 非规范: ${id}`);
  if (id !== '' && path.basename(dir) !== id) warnings.push(`id 与目录名不一致（${id} ≠ ${path.basename(dir)}）`);
  if (errors.length > 0) return { manifest: null, warnings, errors };
  // ---- 可选键逐个守卫：坏值告警忽略该键（缺省语义不变，如 platforms 剔除 = 全平台）----
  const platforms = o.platforms === undefined ? undefined : strArr(o.platforms);
  if (o.platforms !== undefined && platforms === undefined) warnings.push('platforms: 须为字符串数组（process.platform 值），已忽略该键');
  const defaultEnabled = typeof o.defaultEnabled === 'boolean' ? o.defaultEnabled : undefined;
  if (o.defaultEnabled !== undefined && defaultEnabled === undefined) warnings.push('defaultEnabled: 须为布尔，已忽略该键');
  const skills = o.skills === undefined ? undefined : strArr(o.skills);
  if (o.skills !== undefined && skills === undefined) warnings.push('skills: 须为字符串数组（相对插件根的目录），已忽略该键');
  // configSchema 只守卫对象形状，条目不深校验（v1 仅设置页展示）——类型面按声明收窄
  const configSchema = o.configSchema === undefined ? undefined : (objRecord(o.configSchema) as Record<string, { type: string; description?: string }> | undefined);
  if (o.configSchema !== undefined && !configSchema) warnings.push('configSchema: 须为对象，已忽略该键');
  const config = o.config === undefined ? undefined : objRecord(o.config);
  if (o.config !== undefined && !config) warnings.push('config: 须为对象，已忽略该键');
  let mcpServers: Record<string, Omit<McpServerContrib, 'name'>> | undefined;
  if (o.mcpServers !== undefined) {
    const entries = objRecord(o.mcpServers);
    if (!entries) {
      warnings.push('mcpServers: 须为对象（键 = server 名），已忽略该键');
    } else {
      mcpServers = {};
      for (const [name, cfg] of Object.entries(entries)) {
        const contrib = parseMcpServerContrib(name, cfg, warnings);
        if (contrib) mcpServers[name] = contrib;
      }
    }
  }
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id,
    name: o.name as string,
    version: o.version as string,
    description: o.description as string,
    ...(platforms !== undefined ? { platforms: platforms as NodeJS.Platform[] } : {}),
    ...(defaultEnabled !== undefined ? { defaultEnabled } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(configSchema !== undefined ? { configSchema } : {}),
    ...(config !== undefined ? { config } : {}),
  };
  return { manifest, warnings, errors };
}

/** 包根（dist/config 两级上溯）：内置插件根缺省锚（plugins/ 随包分发） */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 装载产物：manifest + 落位与启用态裁决（spec §2 插件装载面）。
 *  - enabled：defaultEnabled 作初值，settings 语义键 plugins[id].enabled 在场即覆盖（两级合并见 loadEffectivePlugins）；
 *  - config：settings 语义键 plugins[id].config 原值（浅对象；manifest.config 是其镜像载体，缺省空对象）；
 *  - platformSupported：platforms 缺省全平台；不匹配 = 不可用（消费面据此剔除——设置页置灰、装配跳过），装载层只标记不丢弃；
 *  - warnings：该插件 manifest 解析告警原值（顶层聚合警告带 `[builtin:id]`/`[user:id]` 前缀，见 loadEffectivePlugins）。 */
export interface EffectivePlugin {
  manifest: PluginManifest;
  dir: string;
  source: 'builtin' | 'user';
  enabled: boolean;
  config: Record<string, unknown>;
  platformSupported: boolean;
  warnings: string[];
}

/**
 * 两级装载 + 启用态合并单点（内置 → 用户，MCP 名单合成/技能装载链/设置页同源消费）：
 * - 装载顺序即遮蔽序：内置先扫、用户后扫，同 id 用户级整体覆盖内置级并告警点名（对标 CC 插件层级语义）；
 * - 启用态两级合并：全局 settings 语义键 plugins（{<id>:{enabled?,config?}}）在前、项目级在后，
 *   记录级整面替换（项目记录整体遮蔽全局记录，config 同面合并不深并）；settings 未配置 → defaultEnabled 兜底；
 * - 容错纪律沿 parsePluginManifest：目录缺失静默空表、manifest 非法整插件跳过、settings 坏记录告警忽略该记录
 *   （宁可少配不可错配）；settings 文档畸形 JSON 不在此兜——parseSettingsFile fail-fast 抛错，与装载链口径一致；
 * - 可测性注入面：builtinRoot/userRoot/platform/settingsReader（免真写 HOME 与平台断言跳变），
 *   生产缺省 REPO_ROOT/plugins + userConfigDir()/plugins + process.platform + parseSettingsFile 读两级 settings。
 *   settingsReader 注入的是**整个 settings 文档对象**（null = 该级缺档），语义键 `.plugins` 由本函数提取。
 */
export function loadEffectivePlugins(projectRoot: string | undefined, opts: { builtinRoot?: string; userRoot?: string; settingsReader?: (scope: 'global' | 'project') => Record<string, unknown> | null; platform?: NodeJS.Platform } = {}): { plugins: EffectivePlugin[]; warnings: string[] } {
  const builtinRoot = opts.builtinRoot ?? path.join(REPO_ROOT, 'plugins');
  const userRoot = opts.userRoot ?? path.join(userConfigDir(), 'plugins');
  const platform = opts.platform ?? process.platform;
  const warnings: string[] = [];
  const scan = (root: string, source: 'builtin' | 'user'): EffectivePlugin[] => {
    if (!fs.existsSync(root)) return [];
    const out: EffectivePlugin[] = [];
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      // 目录缺 plugin.json = 非插件条目（如随包分发的 plugins/schema 校验 artifact），静默跳过不告警——
      // 内置根常驻非插件子目录，逐目录缺档告警会让每次装配（harness 构造期消费 warnings）制造固定噪声
      if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue;
      const r = parsePluginManifest(dir);
      warnings.push(...r.warnings.map((w) => `[${source}:${d.name}] ${w}`));
      if (r.manifest === null) { warnings.push(...r.errors.map((e) => `[${source}:${d.name}] ${e}`)); continue; }
      out.push({ manifest: r.manifest, dir, source, enabled: r.manifest.defaultEnabled === true, config: {}, platformSupported: (r.manifest.platforms ?? []).length === 0 || (r.manifest.platforms ?? []).includes(platform), warnings: r.warnings });
    }
    return out;
  };
  const byId = new Map<string, EffectivePlugin>();
  for (const p of scan(builtinRoot, 'builtin')) byId.set(p.manifest.id, p);
  for (const p of scan(userRoot, 'user')) { const prev = byId.get(p.manifest.id); if (prev !== undefined) warnings.push(`[user] 插件 ${p.manifest.id} 遮蔽内置版`); byId.set(p.manifest.id, p); }
  // 启用态：global ← project 两级合并（settings 语义键 plugins：{<id>:{enabled?,config?}}）
  const read = (scope: 'global' | 'project'): Record<string, unknown> => {
    const doc = opts.settingsReader !== undefined ? opts.settingsReader(scope)
      : scope === 'global' ? parseSettingsFile(loadGlobalSettings()) : projectRoot === undefined ? null : parseSettingsFile(loadProjectSettings(projectRoot));
    const v = doc?.plugins;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  const merged = { ...read('global'), ...read('project') };
  const plugins = [...byId.values()].map((p) => {
    const ov = merged[p.manifest.id];
    let enabled = p.enabled; let config: Record<string, unknown> = {};
    if (typeof ov === 'object' && ov !== null && !Array.isArray(ov)) {
      const o = ov as { enabled?: unknown; config?: unknown };
      if (typeof o.enabled === 'boolean') enabled = o.enabled;
      if (typeof o.config === 'object' && o.config !== null && !Array.isArray(o.config)) config = o.config as Record<string, unknown>;
    } else if (ov !== undefined) warnings.push(`plugins.${p.manifest.id} 须为对象，已忽略`);
    return { ...p, enabled, config };
  });
  return { plugins, warnings };
}

/** 合成产物：可装配 server 名单 + 声明式安全表 + 警告单（harness 构造期与 guard 同源消费，Task 9 接 safety）。
 *  servers 中 env 空对象不落键（缺省语义不变）；cwd 已解析为绝对路径（manifest '.' = 插件目录）。 */
export interface PluginMcpAssembly {
  servers: McpServerConfig[];
  /** server 名 → 三类安全声明（仅启用且平台可用插件；guard 问线驱动面，未声明 server 走通用 MCP 审批） */
  safety: Record<string, McpSafetyDecl>;
  /** 装载告警（loadEffectivePlugins 原值）+ 合成告警（用户遮蔽/插件撞名）聚合 */
  warnings: string[];
}

/**
 * 插件 MCP 名单合成单点（spec §2.4 装配面；与 loadEffectivePlugins 同源，供 harness 一次调用合成用户∪插件名单）：
 * - 遍历序 = 插件 id 字典序（确定性，同名撞车先到先得可复现）；仅取 enabled 且 platformSupported 的插件；
 * - server 名两级去重：先撞用户 mcp.json 名单（userServerNames）→ 告警跳过（用户遮蔽插件）；
 *   再撞已见名单 → 告警跳过（插件间撞名，字典序先到先得）；
 * - config 展开：configDefaults 与 settings 插件 config 浅合并（用户 config 覆盖缺省）后逐键展开——
 *   configArgs 值 undefined 整键跳过；pattern（string[] 整体裁决）含 `{value}` 逐元素展开（占位替换、
 *   非占位元素原样透传，如 ["--browser","{value}"]），不含 `{value}` 仅在值为布尔 true 时追加
 *   （旗标模式——非 true 值不得把字符串当旗标落参）；
 *   configEnv 展开为 env 键 ← String(config 值)；
 * - cwd：manifest '.' = 插件目录 → 解析为插件根绝对路径后落 McpServerConfig.cwd（stdio spawn 消费）；
 * - safety 逐 server 收集（未声明不落键）；装载告警与合成告警聚合单张警告单返回。
 * opts 沿 loadEffectivePlugins 注入面（builtinRoot/userRoot/settingsReader/platform）原样透传 + userServerNames。
 */
export function pluginMcpServers(projectRoot: string | undefined, opts: Parameters<typeof loadEffectivePlugins>[1] & { userServerNames?: ReadonlySet<string> } = {}): PluginMcpAssembly {
  const { userServerNames, ...loadOpts } = opts;
  const { plugins, warnings } = loadEffectivePlugins(projectRoot, loadOpts);
  const servers: McpServerConfig[] = [];
  const safety: Record<string, McpSafetyDecl> = {};
  const seen = new Set<string>();
  const sorted = [...plugins].sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0));
  for (const p of sorted) {
    if (!p.enabled || !p.platformSupported) continue;
    for (const [name, cfg] of Object.entries(p.manifest.mcpServers ?? {})) {
      if (userServerNames?.has(name)) { warnings.push(`插件 server ${name}（${p.manifest.id}）被用户 mcp.json 遮蔽，跳过`); continue; }
      if (seen.has(name)) { warnings.push(`插件 server ${name} 撞名（${p.manifest.id}），字典序后者跳过`); continue; }
      seen.add(name);
      const merged = { ...cfg.configDefaults, ...p.config };
      const args = [...(cfg.args ?? [])];
      for (const [key, patterns] of Object.entries(cfg.configArgs ?? {})) {
        const v = merged[key];
        if (v === undefined) continue;
        // pattern（configArgs 值 = string[]）为整体裁决单位：含 {value} 的 pattern 逐元素展开
        // （占位替换 + 非占位元素原样透传——"--browser","{value}" 空格双元素形态）；不含 {value} 的
        // 旗标 pattern 仅布尔 true 追加（非 true 值不得把字符串当旗标落参）
        if (patterns.some((pat) => pat.includes('{value}'))) {
          for (const pat of patterns) args.push(pat.includes('{value}') ? pat.replace('{value}', String(v)) : pat);
        } else if (v === true) {
          args.push(...patterns);
        }
      }
      const env: Record<string, string> = { ...(cfg.env ?? {}) };
      for (const [envKey, confKey] of Object.entries(cfg.configEnv ?? {})) {
        const v = merged[confKey];
        if (v !== undefined) env[envKey] = String(v);
      }
      servers.push({
        name,
        command: cfg.command,
        args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(cfg.cwd !== undefined ? { cwd: cfg.cwd === '.' ? p.dir : cfg.cwd } : {}),
      });
      if (cfg.safety !== undefined) safety[name] = cfg.safety;
    }
  }
  return { servers, safety, warnings };
}
