import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { flattenSettings, loadGlobalSettings, parseSettingsFile } from '../config/settings';
import { parseProvidersSpec } from '../config/providers';
import type { ModelChoice } from '../config/providers';
import type { PermissionsConfig } from '../config/permissions';
import type { McpServerConfig } from '../types';
import { memoryDir } from '../harness/memory/store';

/** /settings 配置面模块级助手（D31 分域拆分自 daemon.ts，G8c T2-T6 原域）：只读视图的文件级拆解、
 *  effective 判定、mcp 两级遮蔽视图行与单台真探测、agent.md 生成与输入校验、记忆统计——叶子模块，
 *  config-handlers 消费，零 daemon 类依赖。
 */

// ---------- G8c T2：/settings 面模块级助手（只读视图的文件级拆解 + effective 判定 pure fn） ----------

/** 空 permissions 面（坏形/缺级/缺键的统一缺省形态，与 permissions.ts readLevel 的 EMPTY 同构） */
export const EMPTY_PERMISSIONS: PermissionsConfig = { deny: [], allow: [], additionalDirs: [] };

/** 单文件语义槽集（G8c T2 /settings 来源判定）：parse→flatten 的槽键面。缺失/畸形按空——GET 是
 * 只读视图，畸形文件的 fail-fast 属装载链（CLI 入口）职责，daemon 不重复裁决只降级视图 */
export function fileSlots(filePath: string): Set<string> {
  try {
    const doc = parseSettingsFile(filePath);
    if (doc === null) return new Set();
    return new Set(Object.keys(flattenSettings(doc).slots));
  } catch {
    return new Set();
  }
}

/** 单文件 flatten 告警（G8d T5 /settings warnings 透出）：未知/退役键告警面——RawPane 顶部告警
 * 列表数据源。降级风格沿 fileSlots：缺失/畸形按空（GET 只读视图，fail-fast 属装载链） */
export function fileWarnings(filePath: string): string[] {
  try {
    const doc = parseSettingsFile(filePath);
    if (doc === null) return [];
    return flattenSettings(doc).warnings;
  } catch {
    return [];
  }
}

/** 单文件 permissions 键简版读取（G8c T2）：形状校验沿 permissions.ts readLevel 同口径（对象 +
 *  三字符串数组），坏形/坏数组按空——daemon 需要两级分立视图而 permissions.ts 只出合并态 */
export function filePermissions(filePath: string): PermissionsConfig {
  try {
    const doc = parseSettingsFile(filePath);
    if (doc === null || doc.permissions === undefined) return EMPTY_PERMISSIONS;
    const raw = doc.permissions;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_PERMISSIONS;
    const obj = raw as Record<string, unknown>;
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : [];
    return { deny: strArr(obj.deny), allow: strArr(obj.allow), additionalDirs: strArr(obj.additionalDirs) };
  } catch {
    return EMPTY_PERMISSIONS;
  }
}

/** GET /settings?root= 无 root 时的 providers 面：仅全局文件（loadProviders 需项目 root 定位项目级，
 *  缺 root 不能以空串调之——否则会读 cwd 相对 .sunshinex/settings.json） */
export function globalProvidersOnly(): { choices: ModelChoice[]; warnings: string[] } {
  const filePath = loadGlobalSettings();
  try {
    const doc = parseSettingsFile(filePath);
    return parseProvidersSpec(doc === null ? undefined : doc.providers, filePath);
  } catch {
    return parseProvidersSpec(undefined, filePath); // 畸形按缺级（装载链职责，此处只降级视图）
  }
}

/** PUT /settings/raw 的 mcp 原文验证（G8c T3）——验证口径与装载口径一字不差：严格 JSON.parse
 *  （parseMcpJsonFile 读盘即此口径：注释与 BOM 均不容忍——注释文件会被装载面静默读空成「零服务器」，
 *  放行比报错更糟）+ 根对象 + mcpServers 在场须对象（装载面同门：非对象形态静默回 []，原文编辑面
 *  显式拒）。畸形 throw，message 携带目标路径与原文 reason（→400 面）。 */
export function validateMcpRawContent(content: string, target: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`mcp.json 解析失败（严格 JSON；装载面不容忍注释与 BOM）: ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`mcp.json 根必须是 JSON 对象: ${target}`);
  }
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    throw new Error(`mcp.json "mcpServers" 必须是 JSON 对象: ${target}`);
  }
}

// ---------- G8c T4：/settings/mcp 面模块级助手（两级遮蔽视图行 + 单台真探测装配） ----------

/** GET /settings/mcp 行：装载面 McpServerConfig 的打码视图——env 折叠为键名列表（env 值不回传：
 *  文件本就承载 env 全值，PUT 结构化写全值回写、raw 面另有无打码原文，GET 只供清单呈现）。
 *  transport 归一：装载面缺省条目（无 transport 字段的 stdio）不带该键，视图面统一显形 'stdio' */
export interface McpServerRow {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  source: 'project' | 'global';
  shadowed: boolean;
}

export function mcpRow(cfg: McpServerConfig, source: 'project' | 'global', shadowed: boolean): McpServerRow {
  return {
    name: cfg.name,
    transport: cfg.transport ?? 'stdio',
    ...(cfg.command !== undefined ? { command: cfg.command } : {}),
    ...(cfg.args !== undefined ? { args: cfg.args } : {}),
    ...(cfg.url !== undefined ? { url: cfg.url } : {}),
    envKeys: Object.keys(cfg.env ?? {}),
    source,
    shadowed,
  };
}

/** probe stdio 子进程环境：宿主环境整份继承 + cfg.env 覆盖（债 D21 同款，与 McpHost 正式装配同一
 *  环境语义——探测结论对装配期可迁移；process.env 值域含 undefined 须剔除） */
function probeChildEnv(cfg: McpServerConfig): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v;
  }
  return { ...merged, ...(cfg.env ?? {}) };
}

/** probe 临时传输装配：照 McpHost.makeTransport 三分支抄（探测面无 ToolRegistry/CodedToolError 收束，
 *  plain Error 同文案形；形态字段缺失或 url 非法与连接失败同语义） */
function makeProbeTransport(cfg: McpServerConfig): Transport {
  const fail = (msg: string): Error => new Error(`MCP server connection failed (${cfg.name}): ${msg}`);
  switch (cfg.transport ?? 'stdio') {
    case 'http':
    case 'sse': {
      if (!cfg.url) throw fail(`${cfg.transport} transport requires a url`);
      try {
        const url = new URL(cfg.url);
        return cfg.transport === 'sse' ? new SSEClientTransport(url) : new StreamableHTTPClientTransport(url);
      } catch (e) {
        throw fail(`Invalid url: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    case 'stdio':
    default:
      if (!cfg.command) throw fail('stdio transport requires a command');
      return new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: probeChildEnv(cfg) });
  }
}

export const PROBE_CONNECT_TIMEOUT_MS = 10_000;

/** 单台真探测（POST /settings/mcp/probe 核心）：临时 Client → connect（10s 竞速超时，计时器必清）
 *  → serverInfo.name !== 配置名 → identity mismatch（防冒名，与 McpHost 握手同门）→ listTools →
 *  tools 映射 {name, description?}。失败面全收敛 200 {ok:false, error 截 120}：连接失败包
 *  connection failed 前缀（与 McpHost 警告单同文案形）；finally 恒 close——半开传输收口（stdio
 *  子进程残留/SSE EventSource 重连循环都会挂住 daemon 进程） */
export async function probeMcpServer(
  cfg: McpServerConfig,
): Promise<{ ok: true; tools: Array<{ name: string; description?: string }> } | { ok: false; error: string }> {
  const clip = (msg: string): string => (msg.length > 120 ? msg.slice(0, 120) : msg);
  let client: Client | undefined;
  try {
    const transport = makeProbeTransport(cfg);
    client = new Client({ name: 'sunshinex-mcp-probe', version: '0.1.0' });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`connect timed out after ${PROBE_CONNECT_TIMEOUT_MS}ms`)), PROBE_CONNECT_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: clip(`connection failed (${cfg.name}): ${msg}`) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const actual = client.getServerVersion()?.name;
    if (actual !== cfg.name) {
      return { ok: false, error: clip(`identity mismatch (${cfg.name}): serverInfo.name=${actual ?? '(unknown)'}`) };
    }
    const listed = await client.listTools();
    return {
      ok: true,
      tools: listed.tools.map((t) => ({ name: t.name, ...(t.description !== undefined ? { description: t.description } : {}) })),
    };
  } catch (e) {
    return { ok: false, error: clip(e instanceof Error ? e.message : String(e)) };
  } finally {
    if (client !== undefined) await client.close().catch(() => {});
  }
}

// ---------- G8c T5：/settings/agents 面模块级助手（agent.md 生成 + 写后回读验证） ----------

/** PUT /settings/agents upsert 输入的 frontmatter 面（校验后形态）：name 必填，可选键按需；
 *  调用方已保证字符串值单行（含换行的值在 400 面拒收——frontmatter 是单行 KV 词法，换行注入伪键） */
export interface AgentFrontmatterInput {
  name: string;
  description?: string;
  memory?: boolean;
  isolation?: string;
  executor?: string;
}

/** agent.md 生成（G8c T5 upsert）：frontmatter 键序固定 name 首位、可选键按需追加
 *  （description→memory→isolation→executor），body 缺省空串。生成物经写后回读 parseAgentFrontmatter
 *  验证后才落盘目标——装配链 loadAgents 对畸形文件 fail-fast，坏文件会死锁整个会话装配，
 *  本生成器 + 回读验证是写盘前的防线（handler 内单点消费） */
export function renderAgentMd(fm: AgentFrontmatterInput, body: string): string {
  const lines = [`name: ${fm.name}`];
  if (fm.description !== undefined) lines.push(`description: ${fm.description}`);
  if (fm.memory === true) lines.push('memory: true');
  if (fm.isolation !== undefined) lines.push(`isolation: ${fm.isolation}`);
  if (fm.executor !== undefined) lines.push(`executor: ${fm.executor}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** PUT /settings/agents 的 id 安全面（单点）：id 直接拼进 <scopeDir>/agents/<id>/ 目录路径——
 *  路径分隔/穿越/点开头等形态一律拒（首字符限字母数字，余字符限 [A-Za-z0-9_-]） */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** upsert frontmatter 输入校验+归一（G8c T5，validateMcpRawContent 同款 throw→400 形态）：name 必填
 *  非空白单行；可选键按需——description/isolation/executor 须单行字符串（frontmatter 是单行 KV 词法，
 *  含换行的值会注入伪键，多行内容属 body 面）；memory 须布尔。name 先行 trim 归一（parseFrontmatterKV
 *  值域 trim，输入面先归一防写后回读的回环比对误报） */
export function parseAgentFrontmatterInput(raw: unknown): AgentFrontmatterInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('frontmatter must be an object with required name');
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.name !== 'string' || f.name.trim().length === 0 || /\r|\n/.test(f.name)) {
    throw new Error('frontmatter.name required (non-empty single-line string)');
  }
  const oneLine = (label: string, v: unknown): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string') throw new Error(`${label} must be a string`);
    if (/\r|\n/.test(v)) throw new Error(`${label} must be single-line (multi-line content belongs in body)`);
    return v;
  };
  const description = oneLine('frontmatter.description', f.description);
  const isolation = oneLine('frontmatter.isolation', f.isolation);
  const executor = oneLine('frontmatter.executor', f.executor);
  if (f.memory !== undefined && typeof f.memory !== 'boolean') {
    throw new Error('frontmatter.memory must be a boolean');
  }
  return {
    name: f.name.trim(),
    ...(description !== undefined ? { description } : {}),
    ...(f.memory === true ? { memory: true } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(executor !== undefined ? { executor } : {}),
  };
}

/** /settings keys 行（G8c T2 effective 判定 pure fn）：
 *  - 槽在 env 且非自填 → 'env'+envOverride（真导出恒最优先，GUI 禁编+徽标）
 *  - 槽在 env 且自填 → root 项目文件有值 'project'、否则全局文件有值 'global'、否则 'env' 不带
 *    envOverride（窄缝：链来自其他 root 的项目文件，本视图无从归因，只能如实报 env 面值）
 *  - 槽缺 → 文件链同判定（project/global），都无 → 'default'；value 恒取 env 槽（槽缺即 null——
 *    文件有值但未装载的键如实报「有配置但未生效」，不伪装 effective 值） */
export function effectiveKeyRow(
  key: string,
  slot: string,
  selfFilled: ReadonlySet<string>,
  projectSlots: ReadonlySet<string>,
  globalSlots: ReadonlySet<string>,
): { key: string; value: string | null; source: 'env' | 'project' | 'global' | 'default'; envOverride: boolean } {
  const envValue = process.env[slot];
  if (envValue !== undefined) {
    if (!selfFilled.has(slot)) return { key, value: envValue, source: 'env', envOverride: true };
    if (projectSlots.has(slot)) return { key, value: envValue, source: 'project', envOverride: false };
    if (globalSlots.has(slot)) return { key, value: envValue, source: 'global', envOverride: false };
    return { key, value: envValue, source: 'env', envOverride: false };
  }
  if (projectSlots.has(slot)) return { key, value: null, source: 'project', envOverride: false };
  if (globalSlots.has(slot)) return { key, value: null, source: 'global', envOverride: false };
  return { key, value: null, source: 'default', envOverride: false };
}

// ---------- G8c T6：/settings/skills + /settings/memory-stats 面模块级助手 ----------

/** GET /settings/memory-stats 统计（G8c T6）：主域记忆目录（memoryDir 单点）只读扫描。
 *  记录文件口径 = 主目录直属 .md 且非派生索引 MEMORY.md（agents/ 子智能体子树与 .bak-* 快照目录
 *  不是主域记录，isFile 天然排除）；entries=记录文件数，lastWriteAt=最大 mtimeMs（无记录 →
 *  {entries:0, lastWriteAt:null}）。
 *  只读面不走 MemoryStore 构造（其 mkdirSync 副作用会让 GET 建目录）——与 list() 的口径差异：
 *  坏记录（frontmatter 畸形）按文件计——stats 是盘面概览非解析视图；枚举与 stat 间的竞态移除
 *  按已计不重扫（概览面尽力而为，同 loadSkillsFrom 姿态） */
export function memoryStats(root: string): { entries: number; lastWriteAt: number | null } {
  const dir = memoryDir(root);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { entries: 0, lastWriteAt: null }; // 目录不存在/不可读 = 零值（从未写过记忆的合法态）
  }
  let count = 0;
  let last: number | null = null;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'MEMORY.md') continue;
    count += 1;
    try {
      const mtimeMs = fs.statSync(path.join(dir, e.name)).mtimeMs;
      if (last === null || mtimeMs > last) last = mtimeMs;
    } catch {
      // 枚举与 stat 之间被移除：条目已计（竞态窗口的概览，不回滚重扫）
    }
  }
  return { entries: count, lastWriteAt: last };
}
