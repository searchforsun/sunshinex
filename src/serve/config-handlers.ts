import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from '../harness/memory/store';
import { strArr, strRecord } from '../config';
import { urlOf } from './daemon-wire';
import {
  effectiveKeyRow,
  EMPTY_PERMISSIONS,
  filePermissions,
  fileSlots,
  fileWarnings,
  mcpRow,
  memoryStats,
  parseAgentFrontmatterInput,
  probeMcpServer,
  validateMcpRawContent,
} from './config-helpers';
// Task 6 起 renderAgentMd（生成器）居 catalog/agents——serve 层不再直用（upsert 经 catalog
// upsertAgent 内部生成）；Task 15 起 agents 写面（upsert/remove/setEnabled）与 AGENT_ID_RE
// （id 安全面单点，自 config-helpers 上收消依赖倒置）同样收口 catalog——本文件 handlers 全部薄封装 catalog 调用
import {
  AGENT_ID_RE,
  agentsDir,
  removeAgent,
  setAgentEnabled,
  upsertAgent,
  type AgentFrontmatterInput,
  type AgentUpsertSpec,
} from '../catalog/agents';
// Task 15 mcp 写面：单条目操作（add/remove/enable/disable）+ 两级视图读面（approval 标注进响应）
import { listMcpServers, removeMcpServer, setMcpServerEnabled, upsertMcpServer } from '../catalog/mcp';
import { listSkills } from '../catalog/skills';
import { removeLearnedSkill } from '../harness/skills';
import { approveMcpServer, denyMcpServer } from '../catalog/approvals';
// Task 16 providers/permissions 写面：op 端点收口 catalog 单点（读面 GET /settings 同源 listProviders）
import { listProviders, modelAdd, modelMove, modelRemove, removeProvider, setProviderApiKey, upsertProvider } from '../catalog/providers';
import type { ProviderModelInput, ProviderUpsertPatch } from '../catalog/providers';
import { addPermission, removePermission } from '../catalog/permissions';
import { CatalogWriteError } from '../catalog/io';
import {
  hasJsonComments,
  loadGlobalSettings,
  loadProjectSettings,
  parseSettingsFile,
  SEMANTIC_KEYS,
  surgicalSettingsUpdate,
  getSelfFilledSlots,
} from '../config/settings';
import { resolveProviderApiKey } from '../config/providers';
import type { PermissionsConfig } from '../config/permissions';
import { loadMcpServers, parseMcpJsonFile } from '../config';
import { userConfigDir } from '../config/env';
import { loadEffectivePlugins } from '../config/plugins';
import { builtinAgentRoles, loadAgentsView, parseAgentFrontmatter } from '../harness/subagent';
import { loadCrossProjectSkillGroups, loadSkillsGrouped, loadUserSkillsGroup, SkillsGroup } from '../harness/skills';

/** 配置面 HTTP 处理器（D31 分域拆分自 daemon.ts 类）：settings 结构化/raw、mcp 清单/探测/写、
 *  agents 清单/增删/正文、skills 清单、memory-stats——daemon 类状态的全部触点收敛于 io 三面
 *  （send/readJson/reloadSettingsChain），处理器本身为纯函数形（req/res + io），路由表零改动。
 */

export interface ConfigHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage, cap?: number): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  reloadSettingsChain(root: string | undefined): void;
}

/** GET /settings?root=<abs>（G8c T2，Settings 页数据源）：无 root = 仅全局+env 面。keys 按
 *  SEMANTIC_KEYS 键序全量回执（effective 判定见 effectiveKeyRow 单点）；permissions 三面
 *  {merged, project, global}（两级文件分立拆解 + 拼接去重合并——与 loadPermissions 同口径的
 *  视图态）；providers = catalog listProviders 单点（Task 16 增量消费：choices 生效面 + entries
 *  源级分组显式值面（含 tier/apiKeyEnv，T9 语义标注见实现处注释）+ apiKeyPresent 布尔
 *  （resolveProviderApiKey 判存，不显值——密钥永不回传））。G8d T5 增 warnings：两级 settings.json 的 flatten 告警（未知
 *  键，项目先行拼全局）。daemon 不调装载链（CLI 入口先跑、daemon 继承其 env），本端点纯读
 *  process.env + 文件面，零副作用 */
export function handleSettingsGet(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const rootParam = url.searchParams.get('root');
  const root = rootParam !== null && rootParam.length > 0 ? path.resolve(rootParam) : undefined;
  const selfFilled = new Set(getSelfFilledSlots());
  const projectSlots = root !== undefined ? fileSlots(loadProjectSettings(root)) : new Set<string>();
  const globalSlots = fileSlots(loadGlobalSettings());
  const keys = Object.entries(SEMANTIC_KEYS).map(([key, slot]) => effectiveKeyRow(key, slot, selfFilled, projectSlots, globalSlots));
  const globalPerms = filePermissions(loadGlobalSettings());
  const projectPerms = root !== undefined ? filePermissions(loadProjectSettings(root)) : EMPTY_PERMISSIONS;
  const merged: PermissionsConfig = {
    deny: [...new Set([...globalPerms.deny, ...projectPerms.deny])],
    allow: [...new Set([...globalPerms.allow, ...projectPerms.allow])],
    additionalDirs: [...new Set([...globalPerms.additionalDirs, ...projectPerms.additionalDirs])],
  };
  // Task 16 起 providers 面增量消费 catalog listProviders 单点（含 tier/apiKeyEnv/apiKeyPresent/
  // choices 序——与写面/装配同源不漂移；root 缺省仅全局面 = listProviders(null)，globalProvidersOnly
  // 先例口径——缺项目上下文不伪造 cwd 相对读取）。既有契约字段（choices/apiKeyPresent/warnings）零变；
  // 新增 entries = ProviderEntry 源级分组（文件结构镜像 + 密钥面）。T9 评审移交（语义标注，消费方必读）：
  // entries.models = 文件显式值（非继承源级缺省——源级 contextWindow 不流入未显式声明的模型条目），
  // 生效值一律看 choices 面（条目级 > 源级缺省）；GUI 编辑回显走 entries、生效呈现走 choices。
  // Task 27.5 富化（控制器 T26 评审裁定——全键遮蔽陷阱的观察面）：entries 每行增 origin 来源归因
  // （'project' | 'global'，loadProvidersFull 两级裁决整批盖章——项目 providers 键在场=整键遮蔽，
  // 该面全部条目 origin='project'，全局源不可能混列；catalog ProviderEntry 经 ParsedProviderEntry
  // 透传，本 handler 零改动）
  const view = listProviders(root ?? null);
  const apiKeyPresent: Record<string, boolean> = {};
  for (const choice of view.choices) apiKeyPresent[choice.provider] = resolveProviderApiKey(choice.provider) !== undefined;
  // G8d T5 warnings：两级 settings.json 的 flatten 告警（未知键）项目先行拼全局——GET /settings
  // 透出（RawPane 顶部告警列表消费）；降级语义沿 fileSlots（缺文件/畸形按空）
  const warnings = [...(root !== undefined ? fileWarnings(loadProjectSettings(root)) : []), ...fileWarnings(loadGlobalSettings())];
  io.send(res, 200, {
    keys,
    permissions: { merged, project: projectPerms, global: globalPerms },
    providers: { choices: view.choices, entries: view.providers, apiKeyPresent, warnings: view.warnings },
    warnings,
  });
}

/** PUT /settings {scope?, root?, updates}（G8c T2）：scope 缺省 'project'（root 必填，缺 400）；
 *  scope='global' 写用户级文件（root 定位面被忽略——与 raw 端点同裁定），GUI 设置页「逐项写回
 *  来源文件」的数据面。updates 为 Record<语义键, string|number|null>（非对象 400；未知键 400；
 *  值类型坏 400）。结构化写：读原文件（缺=空对象 {version:1}）→ 含注释 409
 *  引流 raw 编辑面 → 改键（null=delete）→ 保 version/env/permissions/providers/未知键（操作原
 *  对象自然保）→ 2 空格缩进 JSON 原子写（同目录 tmp+rename，目录缺则 mkdir）→ reloadSettingsChain
 *  重载 → 200 {ok:true}。畸形 JSON / 根非对象 / version 非 1：409（文件现状挡住结构化改写，与注释同面） */
export async function handleSettingsPut(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { scope?: unknown; root?: unknown; updates?: unknown } | null;
  const scope = body?.scope === 'global' ? 'global' : 'project';
  const rootRaw = body?.root;
  if (scope === 'project' && (typeof rootRaw !== 'string' || rootRaw.length === 0)) {
    io.send(res, 400, { error: 'root required — project-scoped PUT needs a root; pass scope:"global" for the user-level file' });
    return;
  }
  const updates = body?.updates;
  if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
    io.send(res, 400, { error: 'updates must be an object of key → string | number | null' });
    return;
  }
  // 先全量校验后落盘：任一键坏即 400，零部分写（对比值面 400 与文件面 409 都不动盘）。
  // 已知键判定用 Object.hasOwn 而非值比对：SEMANTIC_KEYS 是普通对象，toString/__proto__ 等
  // 原型键经 `SEMANTIC_KEYS[key] === undefined` 会解析到 Object.prototype 成员（非 undefined）
  // 穿透守卫被写上盘——hasOwn 只认真自键
  for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
    if (!Object.hasOwn(SEMANTIC_KEYS, key)) {
      io.send(res, 400, { error: `unknown settings key "${key}"` });
      return;
    }
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
      io.send(res, 400, { error: `value for "${key}" must be string | number | null` });
      return;
    }
  }
  const root = typeof rootRaw === 'string' && rootRaw.length > 0 ? path.resolve(rootRaw) : undefined;
  const target = scope === 'global' ? loadGlobalSettings() : loadProjectSettings(root!);
  let raw: string | null = null;
  try {
    raw = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  } catch {
    io.send(res, 409, { error: `settings file not readable: ${target}` });
    return;
  }
  if (raw !== null && hasJsonComments(raw)) {
    // 注释保留式手术写(设置自动保存轮):逐行只动目标键,行尾注释/缩进/其余键逐字保真;
    // 不支持形态(多行/嵌套值、单行对象、复验不过)→ 仍 409 引流 raw 编辑面,零盘上副作用
    const patched = surgicalSettingsUpdate(raw, updates as Record<string, string | number | null>);
    if (patched === null) {
      io.send(res, 409, { error: 'file contains comments in an unsupported layout', hint: 'use raw editor' });
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmpPatched = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPatched, patched, 'utf8');
    fs.renameSync(tmpPatched, target);
    io.reloadSettingsChain(root);
    io.send(res, 200, { ok: true });
    return;
  }
  let obj: Record<string, unknown>;
  if (raw === null) {
    obj = { version: 1 };
  } else {
    let parsedRoot: unknown;
    try {
      parsedRoot = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); // BOM 容忍（与 parseSettingsFile 同口径）
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      io.send(res, 409, { error: `settings file is not valid JSON: ${reason}` });
      return;
    }
    if (typeof parsedRoot !== 'object' || parsedRoot === null || Array.isArray(parsedRoot)) {
      io.send(res, 409, { error: 'settings root must be a JSON object' });
      return;
    }
    const existing = parsedRoot as Record<string, unknown>;
    if ((existing['version'] ?? 1) !== 1) {
      io.send(res, 409, { error: `unsupported settings version: ${JSON.stringify(existing['version'] ?? 1)}` });
      return;
    }
    obj = existing;
  }
  for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
    if (value === null) delete obj[key];
    else obj[key] = value;
  }
  // 原子写：同目录 tmp + rename（rename 在两平台均原子替换目标）；.sunshinex 目录缺则递归建
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpFile = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, target);
  io.reloadSettingsChain(root);
  io.send(res, 200, { ok: true });
}


/** raw 端点目标文件定位（G8c T3）：scope×file 四象限——file=settings 走 loadProjectSettings/
 *  loadGlobalSettings 既有单点；file=mcp 走两级装载同款路径（项目 `<root>/.sunshinex/mcp.json`、
 *  全局 `<userConfigDir>/mcp.json`——与 loadMcpServers 同源）。scope=global 恒忽略 root（定位面；
 *  root 在 PUT 里另有 reload 锚用途）。调用方保证 scope=project 时 root 非空 */
function rawSettingsFile(scope: 'project' | 'global', file: 'settings' | 'mcp', root: string): string {
  if (scope === 'global') return file === 'settings' ? loadGlobalSettings() : path.join(userConfigDir(), 'mcp.json');
  return file === 'settings' ? loadProjectSettings(root) : path.join(root, '.sunshinex', 'mcp.json');
}

/** GET /settings/raw?scope=project|global&root=<abs>&file=settings|mcp（G8c T3，raw 编辑面数据源）：
 *  原文（含注释/缩进/尾随换行）逐字复读——JSONC 保真是 raw 面的存在理由（结构化改写会丢注释）。
 *  缺文件 → {content:null}（编辑器空态判据）；scope=project 必带 root（缺 400——无 root 无从定位
 *  项目文件），scope=global 忽略 root（定位恒 userConfigDir）。未知 scope/file 400。 */
export function handleSettingsRawGet(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const scope = url.searchParams.get('scope');
  const file = url.searchParams.get('file');
  if (scope !== 'project' && scope !== 'global') {
    io.send(res, 400, { error: 'scope must be "project" or "global"' });
    return;
  }
  if (file !== 'settings' && file !== 'mcp') {
    io.send(res, 400, { error: 'file must be "settings" or "mcp"' });
    return;
  }
  const rootParam = url.searchParams.get('root');
  if (scope === 'project' && (rootParam === null || rootParam.length === 0)) {
    io.send(res, 400, { error: 'root query param required for scope=project' });
    return;
  }
  const target = rawSettingsFile(scope, file, rootParam ?? '');
  let content: string | null = null;
  if (fs.existsSync(target)) content = fs.readFileSync(target, 'utf8');
  io.send(res, 200, { content });
}

/** PUT /settings/raw {scope, root?, file, content}（G8c T3）：服务端验证拒存 + 原子写。
 *  - 验证口径=装载口径：file=settings 经 parseSettingsFile 验（在 tmp 上跑真解析器——验证的就是
 *    将要落盘的字节；畸形 JSONC/根非对象/version 非 1 → 400 带 parseSettingsFile 原文 message，
 *    stripJsonComments 保行数故行号指向用户文件真实位置）；file=mcp 经 validateMcpRawContent
 *    （严格 JSON+根对象+mcpServers 形态——装载面 parseMcpJsonFile 同口径）。
 *  - 原子写：同目录 tmp + rename（T2 结构化写同款）——非法内容永不到达目标路径（拒存），
 *    验证失败清 tmp。
 *  - scope=project 必带 root（缺 400）；scope=global 忽略 root 定位、但 root 在 body 时作为
 *    reload 锚（file=settings 成功后 reloadSettingsChain(root)——global 链随跑；root 缺省只写盘
 *    不 reload，stderr 提示——链重载需项目锚，无锚硬 reload 等于拿假 root 跑项目级）。
 *  - file=mcp 恒不触发 reload（mcp 不在 settings 链）。IO 失败（写/换名）不经本地捕获——沿
 *    dispatch 500 收口（T2 同惯例）。 */
export async function handleSettingsRawPut(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { scope?: unknown; root?: unknown; file?: unknown; content?: unknown } | null;
  const scope = body?.scope;
  if (scope !== 'project' && scope !== 'global') {
    io.send(res, 400, { error: 'scope must be "project" or "global"' });
    return;
  }
  const file = body?.file;
  if (file !== 'settings' && file !== 'mcp') {
    io.send(res, 400, { error: 'file must be "settings" or "mcp"' });
    return;
  }
  const content = body?.content;
  if (typeof content !== 'string') {
    io.send(res, 400, { error: 'content must be a string' });
    return;
  }
  const rootRaw = body?.root;
  let root: string | undefined;
  if (scope === 'project') {
    if (typeof rootRaw !== 'string' || rootRaw.length === 0) {
      io.send(res, 400, { error: 'root required for scope=project' });
      return;
    }
    root = path.resolve(rootRaw);
  } else if (typeof rootRaw === 'string' && rootRaw.length > 0) {
    root = path.resolve(rootRaw); // global：定位面忽略 root（rawSettingsFile），此处仅留作 reload 锚
  }
  const target = rawSettingsFile(scope, file, root ?? '');
  // 原子写+验证拒存：先落同目录 tmp → 验证 tmp（字节面=目标面）→ rename 原子替换；目录缺则递归建
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpFile = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, content, 'utf8');
  try {
    if (file === 'settings') parseSettingsFile(tmpFile); // 真解析器单点：throw → 400 原文 message
    else validateMcpRawContent(content, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmpFile); // 拒存清 tmp：目标文件零触碰，不留残片
    } catch {
      // tmp 已不在场（写即败等）——无需清
    }
    io.send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    fs.renameSync(tmpFile, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // 同上
    }
    throw err; // IO 面 → dispatch 500 收口
  }
  if (file === 'settings') {
    if (root !== undefined) io.reloadSettingsChain(root);
    else console.error('[serve] raw global settings written without reload — pass root in the request body to reload the settings chain');
  }
  io.send(res, 200, { ok: true });
}

/** GET /settings/mcp?root=（G8c T4，Settings 页 MCP 清单数据源；Task 15 改消费 catalog
 *  listMcpServers 单点——遮蔽/批准阀标注同源不漂移）：行 = mcpRow 打码视图 + approval 字段
 *  （project 接批准阀 approved/pending/denied——GUI 审批流消费；global 恒 'none' 用户手配不过阀）。
 *  应答序保持既有契约「项目先全局后」（catalog 层序全局先——视图序在此翻转，loadAgentsView 同款
 *  裁定），各作用域内 name 字典序。无 root = 仅全局清单（catalog 项目分支 root:null 会回退扫
 *  cwd——弃置项目扫描结果，与既有「无 root 仅全局面」裁定一致；空串 root 不可靠的活体陷阱见
 *  handleAgentsGet 同款注释）。env/headers 折键名列表（值不回传），transport 缺省归一 stdio */
export function handleMcpGet(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const rootParam = url.searchParams.get('root');
  const root = rootParam !== null && rootParam.length > 0 ? path.resolve(rootParam) : undefined;
  const entries = listMcpServers(root ?? null).entries;
  const ordered =
    root === undefined
      ? entries.filter((e) => e.scope === 'global')
      : [...entries.filter((e) => e.scope === 'project'), ...entries.filter((e) => e.scope === 'global')];
  io.send(res, 200, {
    servers: ordered.map((e) => ({ ...mcpRow(e.server, e.scope, e.shadowed), approval: e.approval })),
  });
}

/** POST /settings/mcp/probe {root?, name}（G8c T4）：合并清单定位该名（root 缺省 = 仅全局清单——
 *  与 GET 同源裁定）→ probeMcpServer 单台真探测（临时装配+握手身份校验+tools/list）。失败面
 *  （未知名/连接/身份不符/超时）同为 200 {ok:false, error}——探测是诊断面，失败即结果不是错误
 *  码；name 缺失是请求形态坏 → 400 */
export async function handleMcpProbe(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { root?: unknown; name?: unknown } | null;
  const name = body?.name;
  if (typeof name !== 'string' || name.length === 0) {
    io.send(res, 400, { error: 'name required — probe target server name' });
    return;
  }
  const rootRaw = body?.root;
  const root = typeof rootRaw === 'string' && rootRaw.length > 0 ? path.resolve(rootRaw) : undefined;
  const manifest = root !== undefined ? loadMcpServers(root) : parseMcpJsonFile(path.join(userConfigDir(), 'mcp.json'));
  const cfg = manifest.find((s) => s.name === name);
  if (cfg === undefined) {
    io.send(res, 200, { ok: false, error: `mcp server not found in merged manifest: ${name}` });
    return;
  }
  io.send(res, 200, await probeMcpServer(cfg));
}

/** PUT /settings/mcp {root, servers}（G8c T4）：项目级 mcp.json 整块结构化写（键 mcpServers = 输入
 *  原样——含 env 全值，文件本就承载 env，GET 面才打码；旧清单整块替换不合并）。root 必填（缺 400，
 *  全局走 raw 编辑）；逐条形状校验（name 非空串 / transport 枚举 / stdio 需 command / http·sse 需
 *  url / args 字符串数组 / env 字符串记录）首错 400、全量校验后落盘零部分写；既有文件含注释/畸形
 *  JSON → 409 引流 raw（与 T2 /settings PUT 同款守卫——结构化改写不越权处置注释/畸形）；原子写
 *  （同目录 tmp+rename）；成功不触发 settings reload——mcp 不在 settings 链，装配期读取（新会话
 *  生效）。键面用 null 原型记录承载：'__proto__' 一类名经普通对象赋值会改写原型而非落自键
 *  （JSON.parse 回读是自键——T2 Object.hasOwn 教训的写面镜像） */
/** mcp server 行可选键形状守卫表(2026-10-27 技术债轮 D53② 表驱动;键序=原逐字段判定序,
 *  400 文案逐字保持)。headers（http/sse 请求头，string→string）/ enabled（布尔整机开关）/
 *  disabledTools（停用工具短名数组）等装载面消费键,坏形在写面拦——写面虽原样透传未知字段 */
const MCP_ROW_FIELD_CHECKS: ReadonlyArray<{ readonly key: string; readonly ok: (v: unknown) => boolean; readonly expect: string }> = [
  { key: 'args', ok: (v) => strArr(v) !== undefined, expect: 'must be an array of strings' },
  { key: 'env', ok: (v) => strRecord(v) !== undefined, expect: 'must be an object of string → string' },
  { key: 'headers', ok: (v) => strRecord(v) !== undefined, expect: 'must be an object of string → string' },
  { key: 'enabled', ok: (v) => typeof v === 'boolean', expect: 'must be a boolean' },
  { key: 'disabledTools', ok: (v) => strArr(v) !== undefined, expect: 'must be an array of strings' },
];

export async function handleMcpPut(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { root?: unknown; servers?: unknown } | null;
  const rootRaw = body?.root;
  if (typeof rootRaw !== 'string' || rootRaw.length === 0) {
    io.send(res, 400, { error: 'root required — PUT is project-scoped; edit the global file via raw editor' });
    return;
  }
  const rows = body?.servers;
  if (!Array.isArray(rows)) {
    io.send(res, 400, { error: 'servers must be an array of { name, transport?, command?, args?, url?, env? }' });
    return;
  }
  const record: Record<string, unknown> = Object.create(null); // null 原型：'__proto__' 名落自键（见上）
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      io.send(res, 400, { error: `servers[${i}] must be an object` });
      return;
    }
    const r = row as Record<string, unknown>;
    if (typeof r.name !== 'string' || r.name.length === 0) {
      io.send(res, 400, { error: `servers[${i}].name must be a non-empty string` });
      return;
    }
    const transport = r.transport ?? 'stdio';
    if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
      io.send(res, 400, { error: `servers[${i}].transport must be "stdio" | "http" | "sse"` });
      return;
    }
    if (transport === 'stdio') {
      if (typeof r.command !== 'string' || r.command.length === 0) {
        io.send(res, 400, { error: `servers[${i}]: stdio transport requires a command` });
        return;
      }
    } else if (typeof r.url !== 'string' || r.url.length === 0) {
      io.send(res, 400, { error: `servers[${i}]: ${transport} transport requires a url` });
      return;
    }
    // 可选键形状守卫(2026-10-27 技术债轮 D53② 表驱动:原逐字段 if-return 线性堆叠,每新增
    // McpServerConfig 字段本函数再涨一段——headers/enabled/disabledTools 三段即 +17 行;新增字段
    // = 表中加一行)。可选键 undefined 跳过;形状谓词单点 config.strArr/strRecord(G-4 上收)
    for (const { key, ok, expect } of MCP_ROW_FIELD_CHECKS) {
      const v = r[key];
      if (v !== undefined && !ok(v)) {
        io.send(res, 400, { error: `servers[${i}].${key} ${expect}` });
        return;
      }
    }
    record[r.name] = row; // 输入原样（含 env/headers 全值与未知字段——写面不擅自裁剪）
  }
  const root = path.resolve(rootRaw);
  const target = path.join(root, '.sunshinex', 'mcp.json');
  // 409 守卫：既有文件注释/畸形（T2 同款；mcp 装载面严格 JSON，注释文件会被静默读空——结构化写
  // 不得静默越权改写这类文件）
  let raw: string | null = null;
  try {
    raw = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  } catch {
    io.send(res, 409, { error: `mcp file not readable: ${target}` });
    return;
  }
  if (raw !== null && hasJsonComments(raw)) {
    io.send(res, 409, { error: 'file contains comments', hint: 'use raw editor' });
    return;
  }
  let obj: Record<string, unknown>;
  if (raw === null) {
    obj = Object.create(null);
  } else {
    let parsedRoot: unknown;
    try {
      parsedRoot = JSON.parse(raw); // 严格 JSON：BOM/注释不容忍（与 parseMcpJsonFile 装载口径一致）
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      io.send(res, 409, { error: `mcp file is not valid JSON: ${reason}` });
      return;
    }
    if (typeof parsedRoot !== 'object' || parsedRoot === null || Array.isArray(parsedRoot)) {
      io.send(res, 409, { error: 'mcp file root must be a JSON object' });
      return;
    }
    obj = parsedRoot as Record<string, unknown>;
  }
  obj['mcpServers'] = record; // 整块替换（mcpServers 键以外顶层键原样保留，与 T2 settings PUT 同语义）
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpFile = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, target);
  io.send(res, 200, { ok: true }); // 不触发 settings reload——mcp 装配期语义
}

/** CatalogWriteError→HTTP 映射单点（T15 裁定 2026-10-28 于 handleMcpOp 首立，Task 16 抽出共用；
 *  终审修复波 2026-10-28 二裁 hint 分流）：两码恒 409（400 恒留纯请求形状错误），hint 按 code 分流——
 *  COMMENTS → {error, hint:'use raw editor'}（手写注释只有 raw 编辑面能解，引流）；INVALID → {error}
 *  无 hint（条目缺失/形状不收/畸形 JSON 等写面拒写：raw 编辑器修不了缺失条目，error 原文已指名目标
 *  与原因，挂「去 raw 编辑」是误导引流）。返回是否已回执：false = 非 catalog 面（IO 竞态等），
 *  调用方沿 dispatch 500 收口（T2/T4 同惯例）。op 族端点（mcp/providers/permissions/agents）共用本映射 */
function sendCatalogWriteError(io: ConfigHandlerIo, res: http.ServerResponse, err: unknown): boolean {
  if (!(err instanceof CatalogWriteError)) return false;
  if (err.code === 'COMMENTS') io.send(res, 409, { error: err.message, hint: 'use raw editor' });
  else io.send(res, 409, { error: err.message });
  return true;
}

/** PUT /settings/mcp/op {op:'add'|'remove'|'enable'|'disable'|'approve'|'deny', scope, root?, name, server?}
 *  （Task 15，MCP 单条目操作端点——补「global 只能 raw、编辑只能整块替换」的操作缺口）：
 *  handler 是 catalog 写面的薄封装 + CatalogWriteError→HTTP 码映射，文件读写/守卫/原子写/写通知
 *  全在 catalog/mcp 写面单点（config-changed WS 帧由写内 notify 直发——本 handler 不自行广播防双发）。
 *  - add：server 原样透传 catalog upsertMcpServer（形状校验沿 parseMcpJsonFile 接受口径：
 *    command 或 url 至少其一，COMMAND/URL 缺 → INVALID）；
 *  - remove/enable/disable：目标条目缺失/形状非法 → catalog INVALID（严格语义，非幂等）；
 *  - approve/deny：仅 project 有效（global → 400——全局条目用户手配不过批准阀），走
 *    approvals.approveMcpServer/denyMcpServer 既有写面（互斥维护 + notify 回填）。
 *  CatalogWriteError 映射（控制器裁定 2026-10-28；hint 分流终审修复波二裁）：两码统一 → 409——
 *  brief 契约行钉死 COMMENTS/INVALID → 409；同资源族三个既有
 *  结构化写面（settings 结构化/raw、mcp 整块 PUT、plugins PUT）对「目标文件现状不可结构化写」一律
 *  409 同判；本端点是首个 CatalogWriteError→HTTP 映射，无「既有分野」可沿。语义定案：**400=纯请求
 *  形状错误**（坏 op/scope、缺 name、project 缺 root、global approve/deny——全部在入 catalog 前拦），
 *  **409=内容/写面错误**（注释文件/畸形 JSON/条目缺失/server 形状不收——error 原文指名文件与原因；
 *  hint 按 code 分流见 sendCatalogWriteError 注——COMMENTS 引流 raw、INVALID 无 hint）。
 *  成功 200 {ok:true}；不触发 settings reload（mcp/approvals 均装配期语义——mcp 新会话生效、批准阀
 *  下次装载读取） */
export async function handleMcpOp(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { op?: unknown; scope?: unknown; root?: unknown; name?: unknown; server?: unknown } | null;
  const op = body?.op;
  if (op !== 'add' && op !== 'remove' && op !== 'enable' && op !== 'disable' && op !== 'approve' && op !== 'deny') {
    io.send(res, 400, { error: 'op must be "add" | "remove" | "enable" | "disable" | "approve" | "deny"' });
    return;
  }
  const scope = body?.scope;
  if (scope !== 'project' && scope !== 'global') {
    io.send(res, 400, { error: 'scope must be "project" or "global"' });
    return;
  }
  const name = body?.name;
  if (typeof name !== 'string' || name.length === 0) {
    io.send(res, 400, { error: 'name required — target mcp server name' });
    return;
  }
  if ((op === 'approve' || op === 'deny') && scope !== 'project') {
    io.send(res, 400, { error: 'approve/deny only applies to project-scope servers (global entries are user-managed and skip the approval gate)' });
    return;
  }
  const rootRaw = body?.root;
  if (scope === 'project' && (typeof rootRaw !== 'string' || rootRaw.length === 0)) {
    io.send(res, 400, { error: 'root required for scope=project' });
    return;
  }
  // global 恒忽略 root（定位面——与其余配置写面同裁定）；project 必有（上方守卫）
  const root = scope === 'project' ? path.resolve(rootRaw as string) : null;
  try {
    switch (op) {
      case 'add':
        upsertMcpServer(root, scope, name, body?.server); // server 校验在 catalog（INVALID→409 无 hint），原样透传
        break;
      case 'remove':
        removeMcpServer(root, scope, name);
        break;
      case 'enable':
      case 'disable':
        setMcpServerEnabled(root, scope, name, op === 'enable');
        break;
      case 'approve':
        approveMcpServer(root!, name);
        break;
      case 'deny':
        denyMcpServer(root!, name);
        break;
    }
  } catch (err) {
    // CatalogWriteError（COMMENTS/INVALID 两码）统一 409——控制器裁定 2026-10-28（理由与语义
    // 定案见上注，映射单点 sendCatalogWriteError，hint 按 code 分流）：400 恒留请求形状面，写面
    // 拒写（含条目缺失/server 形状不收/文件畸形）不落 400
    if (!sendCatalogWriteError(io, res, err)) throw err; // 非 catalog 面（IO 竞态等）沿 dispatch 500 收口
    return;
  }
  io.send(res, 200, { ok: true });
}

/** PUT /settings/providers/op {op:'add'|'update'|'remove'|'modelAdd'|'modelRemove'|'modelMove'|'setKey',
 *  scope, root?, name, provider?, model?, entry?, direction?, apiKey?}（Task 16，providers 单条目操作
 *  端点——补「providers 编辑只能手改 settings.json」的操作缺口）：handler 是 catalog/providers 写面的
 *  薄封装 + CatalogWriteError→HTTP 码映射（sendCatalogWriteError 单点），文件读写/守卫/原子写/写通知
 *  全在 catalog 单点（config-changed WS 帧由写内 notify 直发——本 handler 不自行广播防双发）。
 *  字段分工（body 契约）：name=目标源身份（七值通用）；provider=add|update 的条目补丁对象
 *  （ProviderUpsertPatch——add 时 baseUrl+非空 models 必备、update 增量未提字段不动）；entry=modelAdd
 *  的模型条目对象（ProviderModelInput）；model=modelRemove|modelMove 的目标模型名；direction=modelMove
 *  的 up|down；apiKey=setKey 的密钥值（空串=清槽；**响应永不回显键值**——catalog 返回 void，成功响应
 *  恒恰 {ok:true}）。错误语义沿 T15 裁定（sendCatalogWriteError 单点）：400=纯请求形状错误（坏 op/
 *  scope、缺 name、project 缺 root、载荷形状——provider/entry 在场须对象、model 缺失、direction 越枚举、
 *  apiKey 非字符串，全部在入 catalog 前拦），409=内容/写面错误（COMMENTS/INVALID——缺 baseUrl/models、
 *  缺源、同名重复、边界调序、注释/畸形文件等 catalog 判定；hint 按 code 分流见 sendCatalogWriteError 注）。
 *  成功 200 {ok:true} 后 reloadSettingsChain（handleSettingsPut 同款链重载——providers/env 随 settings
 *  链生效：setKey 的 env 专用槽落 process.env（GET /settings apiKeyPresent 翻转即时可见、适配器取键
 *  即时生效），模型清单新会话即刻生效；global 无项目锚只重装全局面） */
export async function handleProvidersOp(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as {
    op?: unknown; scope?: unknown; root?: unknown; name?: unknown;
    provider?: unknown; model?: unknown; entry?: unknown; direction?: unknown; apiKey?: unknown;
  } | null;
  const op = body?.op;
  if (op !== 'add' && op !== 'update' && op !== 'remove' && op !== 'modelAdd' && op !== 'modelRemove' && op !== 'modelMove' && op !== 'setKey') {
    io.send(res, 400, { error: 'op must be "add" | "update" | "remove" | "modelAdd" | "modelRemove" | "modelMove" | "setKey"' });
    return;
  }
  const scope = body?.scope;
  if (scope !== 'project' && scope !== 'global') {
    io.send(res, 400, { error: 'scope must be "project" or "global"' });
    return;
  }
  const name = body?.name;
  if (typeof name !== 'string' || name.length === 0) {
    io.send(res, 400, { error: 'name required — target provider name' });
    return;
  }
  const rootRaw = body?.root;
  if (scope === 'project' && (typeof rootRaw !== 'string' || rootRaw.length === 0)) {
    io.send(res, 400, { error: 'root required for scope=project' });
    return;
  }
  // 载荷形状守卫（400——纯请求形状，先于 catalog；内容校验归 catalog → 409）
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (op === 'add' || op === 'update') {
    if (!isRecord(body?.provider)) {
      io.send(res, 400, { error: `provider must be an object (provider patch) for op="${op}"` });
      return;
    }
  } else if (op === 'modelAdd') {
    if (!isRecord(body?.entry)) {
      io.send(res, 400, { error: 'entry must be an object ({ model, ... }) for op="modelAdd"' });
      return;
    }
  } else if (op === 'modelRemove' || op === 'modelMove') {
    if (typeof body?.model !== 'string' || body.model.length === 0) {
      io.send(res, 400, { error: 'model required — target model name' });
      return;
    }
    if (op === 'modelMove' && body?.direction !== 'up' && body?.direction !== 'down') {
      io.send(res, 400, { error: 'direction must be "up" | "down"' });
      return;
    }
  } else if (op === 'setKey' && typeof body?.apiKey !== 'string') {
    io.send(res, 400, { error: 'apiKey must be a string (empty string clears the slot)' });
    return;
  }
  // global 恒忽略 root（定位面——与其余配置写面同裁定）；project 必有（上方守卫）
  const root = scope === 'project' ? path.resolve(rootRaw as string) : null;
  try {
    switch (op) {
      case 'add':
      case 'update':
        upsertProvider(root, scope, name, body?.provider as ProviderUpsertPatch); // 内容校验在 catalog（INVALID→409 无 hint）
        break;
      case 'remove':
        removeProvider(root, scope, name);
        break;
      case 'modelAdd':
        modelAdd(root, scope, name, body?.entry as ProviderModelInput);
        break;
      case 'modelRemove':
        modelRemove(root, scope, name, body?.model as string);
        break;
      case 'modelMove':
        modelMove(root, scope, name, body?.model as string, body?.direction as 'up' | 'down');
        break;
      case 'setKey':
        setProviderApiKey(root, scope, name, body?.apiKey as string); // 键值零回显：catalog void、响应恒 {ok:true}
        break;
    }
  } catch (err) {
    if (!sendCatalogWriteError(io, res, err)) throw err; // 非 catalog 面（IO 竞态等）沿 dispatch 500 收口
    return;
  }
  // 链重载（handleSettingsPut 同款）：providers/env 随 settings 链生效（见上注）；root 已守卫必有
  io.reloadSettingsChain(scope === 'project' ? (root as string) : undefined);
  io.send(res, 200, { ok: true });
}

/** PUT /settings/permissions/op {op:'add'|'remove', scope, root?, list, value}（Task 16，permissions
 *  单条目操作端点）：handler 是 catalog/permissions 写面（addPermission/removePermission）的薄封装 +
 *  sendCatalogWriteError 映射——settings permissions 键（deny/allow/additionalDirs 三数组）对应 scope
 *  文件对应数组的手术写（add 去重幂等、remove 缺失 INVALID），纪律与写通知全在 catalog 单点。
 *  错误语义沿 T15 裁定：400=纯请求形状错误（坏 op/scope/list、value 非字符串、project 缺 root——全部
 *  在入 catalog 前拦），409=内容/写面错误（value 空串/空白 → INVALID、注释/畸形文件 → COMMENTS/
 *  INVALID；hint 按 code 分流见 sendCatalogWriteError 注）。成功 200 {ok:true}，不触发 settings reload——permissions
 *  键不入 env/settings 链（harness 装配期经 loadPermissions 读文件，新会话生效——mcp/approvals 装配期
 *  语义先例）；GUI 刷新由写内 notify 的 config-changed 帧承担 */
export async function handlePermissionsOp(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { op?: unknown; scope?: unknown; root?: unknown; list?: unknown; value?: unknown } | null;
  const op = body?.op;
  if (op !== 'add' && op !== 'remove') {
    io.send(res, 400, { error: 'op must be "add" | "remove"' });
    return;
  }
  const scope = body?.scope;
  if (scope !== 'project' && scope !== 'global') {
    io.send(res, 400, { error: 'scope must be "project" or "global"' });
    return;
  }
  const list = body?.list;
  if (list !== 'deny' && list !== 'allow' && list !== 'additionalDirs') {
    io.send(res, 400, { error: 'list must be "deny" | "allow" | "additionalDirs"' });
    return;
  }
  // value 非字符串 = 请求形状（400）；空串/空白 = 内容（catalog INVALID → 409）——形状/内容分野与
  // providers op 的 apiKey 同判
  if (typeof body?.value !== 'string') {
    io.send(res, 400, { error: 'value required — the permission rule string' });
    return;
  }
  const rootRaw = body?.root;
  if (scope === 'project' && (typeof rootRaw !== 'string' || rootRaw.length === 0)) {
    io.send(res, 400, { error: 'root required for scope=project' });
    return;
  }
  const root = scope === 'project' ? path.resolve(rootRaw as string) : null; // global 恒忽略 root（定位面）
  try {
    if (op === 'add') addPermission(root, scope, list, body.value);
    else removePermission(root, scope, list, body.value);
  } catch (err) {
    if (!sendCatalogWriteError(io, res, err)) throw err; // 非 catalog 面（IO 竞态等）沿 dispatch 500 收口
    return;
  }
  io.send(res, 200, { ok: true });
}

/** GET /settings/plugins?root=（2026-10-26 插件面，Settings 页插件清单数据源）：loadEffectivePlugins
 *  两级装载语义的可视化拆解——manifest 必填五元（id/name/version/description）+ 落位与启用态裁决
 *  （source/enabled/platformSupported，装载层只标记不丢弃：platformSupported=false 照常列示供设置页
 *  置灰）+ 装配面摘要（servers=mcpServers 名数组、skillsCount=skills 目录数）+ 设置语义键面
 *  （configSchema 展示说明、config=settings plugins[id].config 原值）与逐插件 warnings。无 root =
 *  仅全局装载（loadEffectivePlugins(undefined) 项目级 settings 缺席——与 /settings·/settings/mcp
 *  「无 root 仅全局面」同裁定）；顶层 warnings = 装载聚合警告单（遮蔽/坏记录/manifest 告警原值） */
export function handlePluginsGet(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const rootParam = url.searchParams.get('root');
  const root = rootParam !== null && rootParam.length > 0 ? path.resolve(rootParam) : undefined;
  // settings 畸形 JSON/version≠1 时 parseSettingsFile fail-fast 抛错：清单面是尽力而为视图，
  // 不让异常穿透成 500（与 PUT 面「结构化写不越权处置畸形文件」的 409 对称裁量）——回空清单 +
  // 顶层告警点名装载失败（原因随告警透出，设置页 pane 尾可见），零盘上副作用
  let loaded: ReturnType<typeof loadEffectivePlugins>;
  try {
    loaded = loadEffectivePlugins(root);
  } catch (e) {
    io.send(res, 200, { plugins: [], warnings: [`settings 装载失败: ${e instanceof Error ? e.message : String(e)}`] });
    return;
  }
  io.send(res, 200, {
    plugins: loaded.plugins.map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      source: p.source,
      enabled: p.enabled,
      platformSupported: p.platformSupported,
      servers: Object.keys(p.manifest.mcpServers ?? {}),
      skillsCount: (p.manifest.skills ?? []).length,
      configSchema: p.manifest.configSchema,
      exposedTools: p.manifest.exposedTools,
      configDefaults: Object.values(p.manifest.mcpServers ?? {})[0]?.configDefaults,
      config: p.config,
      warnings: p.warnings,
    })),
    warnings: loaded.warnings,
  });
}

/** PUT /settings/plugins {root?, id, enabled?, config?}（2026-10-26 插件面，设置页插件开关/配置表单）：
 *  settings 语义键 plugins.<id> = {enabled?, config?} 的结构化写——目标文件 root 在场 = 项目级
 *  `<root>/.sunshinex/settings.json`、缺省 = 全局 settings（与 GET 装载裁定镜像；写哪级读哪级，
 *  两级合并语义不变）。守卫面：id 必填非空串（缺/空 400）；enabled 在场须布尔、config 在场须浅对象
 *  （坏形 400——首错即返零部分写）；既有文件含注释/畸形 JSON → 409 引流 raw（T4 handleMcpPut 同款
 *  守卫——结构化改写不越权处置注释/畸形，注释会被装载面剥除、结构化写静默覆盖等于丢用户手注）；
 *  version 非 1 → 409（装载口径 parseSettingsFile 拒载 version≠1，写进去了也不生效）；id 经
 *  loadEffectivePlugins 定位（与 GET/装配同源）在文件守卫之后——定位面会真读两级 settings
 *  （畸形即 fail-fast 抛错），先 409 处置目标文件现状再定位；未知 id 404（无装载态的 id 无从写
 *  语义键），定位器因**他级** settings 畸形抛错（target 已过守卫，抛点必在另一级）→ 放行写入：
 *  结构化写不因无关级文件现状 500（T2 ⑲「reload 逐级容错」同精神），且未定位到的 id 记录落盘
 *  无害（装载面按 id 查表，陌生记录自然闲置）。
 *  写面：记录级整面替换（plugins.<id> 只含本次入场字段——与 loadEffectivePlugins「项目记录整体
 *  遮蔽全局记录」的合并语义一致，不做记录内深并）；既有 plugins 键形状坏（非对象）→ 整键重置
 *  （装载面本就告警忽略坏形状，写面不保留垃圾）；id 来自装载面定位，ID_RE（^[a-z0-9]+(-[a-z0-9]+)*$）
 *  已滤 '__proto__' 一类原型键，普通对象赋值安全。原子写（同目录 tmp+rename，T2/T4 同款）；
 *  成功 root 在场时 reloadSettingsChain(root)（plugins 键随 settings 链生效；无 root 无项目锚不
 *  reload——与 raw 全局面裁定同）。IO 失败（写/换名）不经本地捕获——沿 dispatch 500 收口 */
export async function handlePluginsPut(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { root?: unknown; id?: unknown; enabled?: unknown; config?: unknown } | null;
  const id = body?.id;
  if (typeof id !== 'string' || id.length === 0) {
    io.send(res, 400, { error: 'id required — target plugin id' });
    return;
  }
  if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') {
    io.send(res, 400, { error: 'enabled must be a boolean' });
    return;
  }
  if (
    body?.config !== undefined &&
    (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config))
  ) {
    io.send(res, 400, { error: 'config must be an object (shallow record of plugin config keys)' });
    return;
  }
  const rootRaw = body?.root;
  const root = typeof rootRaw === 'string' && rootRaw.length > 0 ? path.resolve(rootRaw) : undefined;
  const target = root !== undefined ? loadProjectSettings(root) : loadGlobalSettings();
  // 409 守卫：既有文件注释/畸形/version（T2/T4 同款；结构化写不越权处置这三类文件现状）——先于
  // 404 定位：定位器 parseSettingsFile 对畸形 settings fail-fast，目标文件现状须先在这里收口
  let raw: string | null = null;
  try {
    raw = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  } catch {
    io.send(res, 409, { error: `settings file not readable: ${target}` });
    return;
  }
  if (raw !== null && hasJsonComments(raw)) {
    io.send(res, 409, { error: 'file contains comments', hint: 'use raw editor' });
    return;
  }
  let obj: Record<string, unknown>;
  if (raw === null) {
    obj = { version: 1 }; // 新档补 version:1（settings schema 口径，T2 同款）
  } else {
    let parsedRoot: unknown;
    try {
      parsedRoot = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); // BOM 容忍（与 parseSettingsFile 装载口径一致）
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      io.send(res, 409, { error: `settings file is not valid JSON: ${reason}` });
      return;
    }
    if (typeof parsedRoot !== 'object' || parsedRoot === null || Array.isArray(parsedRoot)) {
      io.send(res, 409, { error: 'settings root must be a JSON object' });
      return;
    }
    const existing = parsedRoot as Record<string, unknown>;
    if ((existing['version'] ?? 1) !== 1) {
      io.send(res, 409, { error: `unsupported settings version: ${JSON.stringify(existing['version'] ?? 1)}` });
      return;
    }
    obj = existing;
  }
  // 404 定位（文件守卫后——见上注）：loadEffectivePlugins 与 GET/装配同源（内置→用户两级扫描）
  let located = true;
  try {
    located = loadEffectivePlugins(root).plugins.some((p) => p.manifest.id === id);
  } catch {
    // 他级 settings 畸形致定位器抛错（target 已过守卫）——放行写入不 500（见上注）
  }
  if (!located) {
    io.send(res, 404, { error: `plugin not found: ${id}` });
    return;
  }
  // 记录内合并保留(2026-11-01 用户报障「保存配置后插件自动关闭」根修):此前只写入场字段——
  // 保存 config 即抹掉同记录的 enabled 键(回落 manifest defaultEnabled=false=浏览器插件「自动关闭」
  // 真因;反向存 enabled 也曾丢 config)。现按既有记录深拷贝起步、入场字段覆盖;跨层级(项目遮蔽全局)
  // 的整面语义在装载侧合并,不受影响。清某键走「源码」raw 面(布尔无法表达键删除,保留方向安全)
  const prevRecord = (() => {
    const prevAll = obj['plugins'];
    if (typeof prevAll !== 'object' || prevAll === null || Array.isArray(prevAll)) return undefined;
    const prev = (prevAll as Record<string, unknown>)[id];
    return prev !== null && typeof prev === 'object' && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : undefined;
  })();
  const record: Record<string, unknown> = prevRecord ?? {};
  if (body?.enabled !== undefined) record['enabled'] = body.enabled;
  if (body?.config !== undefined) record['config'] = body.config;
  const existingPlugins = obj['plugins'];
  const pluginsMap =
    typeof existingPlugins === 'object' && existingPlugins !== null && !Array.isArray(existingPlugins)
      ? (existingPlugins as Record<string, unknown>)
      : {}; // 既有键形状坏 → 整键重置（装载面告警忽略坏形状，见 loadEffectivePlugins）
  pluginsMap[id] = record;
  obj['plugins'] = pluginsMap;
  // 原子写：同目录 tmp + rename（rename 在两平台均原子替换目标）；.sunshinex 目录缺则递归建
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpFile = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, target);
  if (root !== undefined) io.reloadSettingsChain(root); // plugins 键随 settings 链生效；无 root 无项目锚不 reload
  io.send(res, 200, { ok: true });
}

/** GET /settings/agents?root=（G8c T5，Settings 页 Agents 清单数据源）：builtins = builtinAgentRoles
 *  四预设角色平铺（零读盘零副作用）；view = loadAgentsView 两级宽容清单（项目遮蔽全局 shadowed 标记，
 *  畸形文件入 warnings 不抛死——视图面不重复装配链的 fail-fast 裁决）。无 root = 仅全局清单：projectRoot
 *  不能传空串——loadAgentsView 会 join('','agents')='agents' 相对 cwd 误扫（仓库根真有 agents/ 现目录，
 *  非理论陷阱），改传保证不存在的绝对哨兵（缺目录 = 空项目级，与 loadAgentsFrom 缺目录同语义；较改
 *  loadAgentsView 加空串特判更小——subagent.ts 语义面零改动，两案取实现最小者） */
export function handleAgentsGet(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const rootParam = url.searchParams.get('root');
  const root = rootParam !== null && rootParam.length > 0 ? path.resolve(rootParam) : undefined;
  const projectRoot = root ?? path.join(os.tmpdir(), `sunshinex-agents-empty-${crypto.randomUUID()}`);
  io.send(res, 200, { builtins: builtinAgentRoles(), view: loadAgentsView(projectRoot, userConfigDir()) });
}

/** PUT /settings/agents {root?, scope, op, id, frontmatter?, body?}（G8c T5，AgentsPane 表单增删改；
 *  Task 15 扩 op 值 enable|disable 并全量收口 catalog 写面——本 handler 只剩请求形态校验
 *  与 CatalogWriteError→HTTP 码映射，文件操作/校验/原子写/写通知全在 catalog/agents 单点；
 *  config-changed WS 帧由写内 notify 直发，handler 不自行广播防双发）：
 *  - id 安全校验 AGENT_ID_RE → 400（id 直接拼目录路径——路径分隔/穿越/点开头一律拒，全 op 同守卫）；
 *    scope=project 必带 root（缺 400），global 恒忽略 root（与 raw/mcp 面同裁定）
 *  - upsert：parseAgentFrontmatterInput 单点校验+归一（首错 400，零部分写）→ catalog upsertAgent
 *    （内部 renderAgentMd 生成 + 写前 round-trip 过真解析器 + 原子落盘——较旧 tmp+回读+rename 更进一步：
 *    坏内容根本不进 tmp）。落位=新家 <root>/.sunshinex/agents/<id>（catalog agentsDir 单点——storage
 *    归一裁定；历史旧位置条目由清单/装载入口的 migrateLegacyAgentsOnce 一次性自动迁入）；frontmatter
 *    枚举越型（isolation/executor）旧路径落 tmp 回读失败 500，现 catalog 枚举守卫 INVALID → 409
 *    （罕见路径语义升级，见映射注）
 *  - delete：catalog removeAgent（rm -rf 条目整目录含同级私有文件；缺失 INVALID）；缺失 INVALID
 *    就地吞作幂等 200（既有契约零变）
 *  - enable/disable（Task 15 新增）：catalog setAgentEnabled（frontmatter enabled 行保序手术 +
 *    写后回环）；条目缺失 → 409（写面只认标准两级——旧位置条目由清单/装载入口一次性迁移收口）
 *  CatalogWriteError 映射（控制器裁定 2026-10-28，理由见 handleMcpOp 注；hint 分流终审修复波二裁
 *  见 sendCatalogWriteError 注）：INVALID → 409 {error}（内容/写面错误；delete 例外——缺失 INVALID
 *  就地吞作幂等 200，见分支注）。
 *  COMMENTS 不可达（agent.md 无注释形态——真如此沿兜底抛错走 dispatch 500）。IO 失败不经本地捕获
 *  ——沿 dispatch 500 收口 */
export async function handleAgentsPut(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { root?: unknown; scope?: unknown; op?: unknown; id?: unknown; frontmatter?: unknown; body?: unknown; enabled?: unknown } | null;
  const op = body?.op;
  if (op !== 'upsert' && op !== 'delete' && op !== 'enable' && op !== 'disable') {
    io.send(res, 400, { error: 'op must be "upsert" | "delete" | "enable" | "disable"' });
    return;
  }
  const id = body?.id;
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) {
    io.send(res, 400, { error: 'id must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/ (used as a directory name)' });
    return;
  }
  const scope = body?.scope;
  if (scope !== 'project' && scope !== 'global') {
    io.send(res, 400, { error: 'scope must be "project" or "global"' });
    return;
  }
  const rootRaw = body?.root;
  if (scope === 'project' && (typeof rootRaw !== 'string' || rootRaw.length === 0)) {
    io.send(res, 400, { error: 'root required for scope=project' });
    return;
  }
  const root = scope === 'project' ? path.resolve(rootRaw as string) : null; // global 恒忽略 root（定位面）
  // 写面拒写回执映射：sendCatalogWriteError 单点（终审修复波 2026-10-28 收编——此前本 handler 内联
  // 同形闭包 mapWriteError 两码统一挂 hint，与单点 hint 分流口径漂移，随之删除）
  if (op === 'delete') {
    try {
      removeAgent(root, scope, id); // catalog 收口：rm -rf 条目整目录（含同级私有文件）
    } catch (err) {
      // 缺失 INVALID 就地吞（幂等契约：从未存在与已删同 ok）。非 catalog 面（IO 竞态等）→
      // dispatch 500（removeAgent 的 invalid-id 分支已被上方 AGENT_ID_RE 守卫拦截，不可达）
      if (!(err instanceof CatalogWriteError)) throw err;
    }
    io.send(res, 200, { ok: true });
    return;
  }
  if (op === 'enable' || op === 'disable') {
    const enabled = op === 'enable';
    // enabled 可选回显面：在场须布尔且与 op 同义（op 是权威——防 {op:'enable', enabled:false} 一类
    // 自相矛盾请求静默择一）
    if (body?.enabled !== undefined && (typeof body.enabled !== 'boolean' || body.enabled !== enabled)) {
      io.send(res, 400, { error: `enabled must be ${enabled} for op="${op}" (or omit it)` });
      return;
    }
    try {
      setAgentEnabled(root, scope, id, enabled); // 缺失 → INVALID→409（写面只认标准两级）
    } catch (err) {
      if (!sendCatalogWriteError(io, res, err)) throw err;
      return; // 已回 409（sendCatalogWriteError 单点：INVALID 无 hint，COMMENTS 才引流 raw）
    }
    io.send(res, 200, { ok: true }); // 不触发 settings reload——agents 装配期语义（新会话生效）
    return;
  }
  // upsert 校验面（首错 400，零部分写）：frontmatter 经 parseAgentFrontmatterInput 单点校验+归一
  let fm: AgentFrontmatterInput;
  try {
    fm = parseAgentFrontmatterInput(body?.frontmatter);
  } catch (err) {
    io.send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const bodyText = body?.body;
  if (bodyText !== undefined && typeof bodyText !== 'string') {
    io.send(res, 400, { error: 'body must be a string' });
    return;
  }
  // catalog upsertAgent：生成 + 写前 round-trip（验证口径=装载口径）+ 原子落盘 + notify 直发——
  // serve 侧零文件操作。isolation/executor 为 string 归一前形态，断言窄化后枚举守卫在 catalog
  // 运行时面（越型 INVALID → 409 无 hint，较旧 tmp 回读 500 语义升级）
  const spec: AgentUpsertSpec = {
    name: fm.name,
    ...(fm.description !== undefined ? { description: fm.description } : {}),
    ...(fm.memory === true ? { memory: true } : {}),
    ...(fm.isolation !== undefined ? { isolation: fm.isolation as 'worktree' } : {}),
    ...(fm.executor !== undefined ? { executor: fm.executor as 'internal-team' | 'external-cli' } : {}),
    body: bodyText ?? '',
  };
  try {
    upsertAgent(root, scope, id, spec);
  } catch (err) {
    if (!sendCatalogWriteError(io, res, err)) throw err;
    return; // 已回 409（sendCatalogWriteError 单点：INVALID 无 hint，COMMENTS 才引流 raw）
  }
  io.send(res, 200, { ok: true }); // 不触发 settings reload——agents 装配期语义（新会话生效）
}

/** GET /settings/agents/body?scope=project|global&id=&root=（G8d T3，AgentsPane 编辑全文装载）：
 *  读条目 agent.md（落位解析：project=<root>/.sunshinex/agents、global=<userConfigDir>/agents——
 *  catalog agentsDir 单点）的 frontmatter 后正文全文（parseAgentFrontmatter 单点——
 *  验证口径=装载口径=bodyPreview 口径，三面同源；bodyPreview 的 200 帽在此不适用）。错误面：
 *  坏 scope/坏 id（AGENT_ID_RE 同 PUT 守卫）/scope=project 缺 root → 400；文件缺 → 404（回显
 *  `${scope}/agents/${id}` 相对定位——G8e-T4 收敛：不泄 daemon 主机绝对路径，GUI 可原样呈现）；
 *  畸形 frontmatter → 400 带 parser 原文 message（清单面入 warnings 不抛死，本端点单文件直达——
 *  编辑装载是精确寻址，报错优于静默）。scope=global 恒忽略 root（定位面，PUT 同裁定） */
export function handleAgentsBodyGet(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const scope = url.searchParams.get('scope');
  if (scope !== 'project' && scope !== 'global') {
    io.send(res, 400, { error: 'scope must be "project" or "global"' });
    return;
  }
  const id = url.searchParams.get('id');
  if (id === null || !AGENT_ID_RE.test(id)) {
    io.send(res, 400, { error: 'id must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/ (used as a directory name)' });
    return;
  }
  const rootParam = url.searchParams.get('root');
  if (scope === 'project' && (rootParam === null || rootParam.length === 0)) {
    io.send(res, 400, { error: 'root required for scope=project' });
    return;
  }
  // 落位解析（Task 15 收口 catalog agentsDir 单点）：project=<root>/.sunshinex/agents、
  // global=<userConfigDir>/agents（标准两级；旧位回退随去兼容清理退役——清单/装载入口已一次性迁移）
  const scopeRoot = scope === 'project' ? path.resolve(rootParam as string) : null;
  const file = path.join(agentsDir(scope, scopeRoot), id, 'agent.md');
  if (!fs.existsSync(file)) {
    io.send(res, 404, { error: `agent.md not found: ${scope}/agents/${id}` });
    return;
  }
  const md = fs.readFileSync(file, 'utf8'); // existsSync 后读失败（竞态移除等）沿 dispatch 500 收口
  try {
    io.send(res, 200, { body: parseAgentFrontmatter(md).body });
  } catch (err) {
    io.send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** GET /settings/skills 应答行富化形（T6 基形 + Task 25 附加字段，行基形零变化纯附加）：
 *  sourceDir=条目落盘目录（catalog listSkills 链上 SkillEntry 直映）、shadowedBy=同 id 被更高
 *  优先来源遮蔽时的胜者来源名（catalog 链上裁决——harness SkillsGroup 投影不带遮蔽关系，本面
 *  在响应侧富化供 GUI 灰显+角标；正选条目/无法锚定链的行省字段） */
type SkillsGetRow = SkillsGroup['skills'][number] & { sourceDir?: string; shadowedBy?: string };

/** 技能行富化（Task 25，消费 catalog/skills listSkills 单点）：listSkills(anchor) 链上条目按
 *  (source,id) 建表，既有 SkillsGroup 行查表命中即补 sourceDir/shadowedBy（未命中保持原行——
 *  anchor 外的组自然落空）。anchor 语义按视图裁定：
 *  - 常规视图（root 在场）：三组全部锚定 root 链（loadSkillsGrouped 与 listSkills 同一条
 *    priorityChain——project 段组内去重口径亦一致，查表逐行命中）；
 *  - scope=all：跨项目域组各锚各域 root（handler 不重枚举域表，且异域 (source,id) 会与本链
 *    撞键——查错表即配错 sourceDir），故仅 user 组锚当前 root 链：userSkillsDir root 无关恒
 *    查表命中，shadowedBy=当前项目同名 project 技能在场即标（GUI 先见 user 行，标注随行透出；
 *    无 root=无项目上下文=无从遮蔽，整组省字段） */
function enrichSkillsGroups(groups: SkillsGroup[], anchor: string | undefined, sources: ReadonlyArray<SkillsGroup['source']>): SkillsGroup[] {
  if (anchor === undefined) return groups;
  const byKey = new Map(listSkills(anchor).entries.map((e) => [`${e.source}\n${e.id}`, e] as const));
  const wanted = new Set(sources);
  return groups.map((g) => {
    if (!wanted.has(g.source)) return g;
    return {
      ...g,
      skills: g.skills.map((s): SkillsGetRow => {
        const e = byKey.get(`${g.source}\n${s.id}`);
        if (e === undefined) return s;
        return { ...s, sourceDir: e.sourceDir, ...(e.shadowedBy !== undefined ? { shadowedBy: e.shadowedBy } : {}) };
      }),
    };
  });
}

/** GET /settings/skills?root=（G8c T6，Settings 页 Skills 清单数据源）：root 在场 → loadSkillsGrouped
 *  三组固定序（project/user/learned；组内沿装载序去重、跨组不去重——重复 id 是多源同名的事实呈现，
 *  遮蔽裁决属装配面 loadSkills，视图不预裁）。无 root = 仅 user 组（userSkillsDir 全局可扫；
 *  project/learned 均 root 锚定缺席——空组不占位，与 /settings·/settings/mcp「无 root 仅全局面」
 *  同裁定，但 skills 的全局面是 userSkillsDir 而非 userConfigDir 文件）。
 *  Task 25 富化：行补 sourceDir/shadowedBy（见 enrichSkillsGroups——catalog listSkills 消费单点） */
export function handleSkillsGet(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const rootParam = url.searchParams.get('root');
  const root = rootParam !== null && rootParam.length > 0 ? path.resolve(rootParam) : undefined;
  // scope=all(设置·技能页「项目筛选」视图):user 全局 + 注册项目域全枚举(project 组与 learned
  // 组逐域归属项目名;root 入场仅作当前项目组置首锚——设置页 root 可能为空,枚举不依赖它)
  if (url.searchParams.get('scope') === 'all') {
    const groups: SkillsGroup[] = [loadUserSkillsGroup(), ...loadCrossProjectSkillGroups(root)];
    io.send(res, 200, { groups: enrichSkillsGroups(groups, root, ['user']) });
    return;
  }
  io.send(res, 200, {
    groups: enrichSkillsGroups(root !== undefined ? loadSkillsGrouped(root) : [loadUserSkillsGroup()], root, ['project', 'user', 'learned']),
  });
}

/** POST /settings/skills/rm {root, id}（2026-10-31 学习技能删除面,GUI 学习技能页签/TUI /skills-rm
 *  共用单点）：root 必传(学习根=learnedSkillsDir(root) 工作区锚定);删除原语 removeLearnedSkill
 *  只作用于学习根(id 规范校验防路径逃逸,project/user 用户资产物理不可达)。404=学习根无此 id
 *  (含清理失败);200 {removed:id} */
export async function handleSkillsRemove(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { root?: unknown; id?: unknown } | null;
  if (typeof body?.root !== 'string' || body.root.length === 0) {
    io.send(res, 400, { error: 'root required' });
    return;
  }
  if (typeof body?.id !== 'string' || body.id.length === 0) {
    io.send(res, 400, { error: 'id required' });
    return;
  }
  const r = removeLearnedSkill(path.resolve(body.root), body.id);
  if (r !== 'ok') {
    io.send(res, 404, { error: `no learned skill '${body.id}'` });
    return;
  }
  io.send(res, 200, { removed: body.id });
}

/** GET /settings/memory-stats?root=（G8c T6，Settings 页记忆概览）：root 在场 → memoryStats 主域
 *  只读统计（条数/最近写入，见模块级单点）；无 root = 零值（无项目上下文无记忆面——恒定形态，
 *  不 400：概览页无项目时的空态是合法呈现而非请求形态错） */
export function handleMemoryStatsGet(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const rootParam = url.searchParams.get('root');
  const root = rootParam !== null && rootParam.length > 0 ? path.resolve(rootParam) : undefined;
  io.send(res, 200, root !== undefined ? memoryStats(root) : { entries: 0, lastWriteAt: null });
}


/** POST /memory/rm {root, slugs}(G10-C1d):记忆删除(记忆面板多选;root 寻址与 TUI /memory-rm 同形) */
export async function handleMemoryRm(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  {
    const parsed = await io.readJson(req);
    if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
    const body = parsed.body as { root?: unknown; slugs?: unknown };
    if (typeof body.root !== 'string' || body.root.length === 0 || !Array.isArray(body.slugs) || body.slugs.some((x) => typeof x !== 'string')) {
      return io.send(res, 400, { error: 'root and slugs required' });
    }
    const store = new MemoryStore(body.root);
    const removed: string[] = [];
    const failed: Array<{ slug: string; error: string }> = [];
    for (const slug of body.slugs as string[]) {
      const r = store.remove(slug);
      if (r.ok) removed.push(slug);
      else failed.push({ slug, error: r.error.message });
    }
    io.send(res, 200, { removed, failed });
  }
}

/** GET /memory?root=(G10-C6 记忆面板):清单(slug/type/created/modified/description) */
export function handleMemoryList(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const root = url.searchParams.get('root');
  if (root === null || root.length === 0) return io.send(res, 400, { error: 'root query param required' });
  // G14.147 body 一并返回(记忆页详情展开;记录体量小,清单直带全文)
  const rows = new MemoryStore(root).list().map((m) => ({
    slug: m.slug, type: m.type, created: m.created, modified: m.modified, description: m.description, body: m.body,
  }));
  io.send(res, 200, rows);
}
