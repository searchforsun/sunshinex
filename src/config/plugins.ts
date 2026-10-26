import * as fs from 'fs';
import * as path from 'path';

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
