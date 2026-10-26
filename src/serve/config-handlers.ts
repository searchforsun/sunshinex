import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from '../harness/memory/store';
import { urlOf } from './daemon-wire';
import {
  AGENT_ID_RE,
  effectiveKeyRow,
  EMPTY_PERMISSIONS,
  filePermissions,
  fileSlots,
  fileWarnings,
  globalProvidersOnly,
  mcpRow,
  memoryStats,
  parseAgentFrontmatterInput,
  probeMcpServer,
  renderAgentMd,
  validateMcpRawContent,
  type AgentFrontmatterInput,
} from './config-helpers';
import {
  hasJsonComments,
  loadGlobalSettings,
  loadProjectSettings,
  parseSettingsFile,
  SEMANTIC_KEYS,
  RETIRED_KEYS,
  surgicalSettingsUpdate,
  getSelfFilledSlots,
} from '../config/settings';
import { loadProviders, resolveProviderApiKey } from '../config/providers';
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
 *  视图态）；providers = loadProviders 展开 + apiKeyPresent 布尔（resolveProviderApiKey 判存，
 *  不显值——密钥永不回传）。G8d T5 增 warnings：两级 settings.json 的 flatten 告警（未知/退役
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
  const loaded = root !== undefined ? loadProviders(root) : globalProvidersOnly();
  const apiKeyPresent: Record<string, boolean> = {};
  for (const choice of loaded.choices) apiKeyPresent[choice.provider] = resolveProviderApiKey(choice.provider) !== undefined;
  // G8d T5 warnings：两级 settings.json 的 flatten 告警（未知/退役键）项目先行拼全局——GET /settings
  // 透出（RawPane 顶部告警列表消费）；降级语义沿 fileSlots（缺文件/畸形按空）
  const warnings = [...(root !== undefined ? fileWarnings(loadProjectSettings(root)) : []), ...fileWarnings(loadGlobalSettings())];
  io.send(res, 200, {
    keys,
    permissions: { merged, project: projectPerms, global: globalPerms },
    providers: { choices: loaded.choices, apiKeyPresent, warnings: loaded.warnings },
    warnings,
  });
}

/** PUT /settings {scope?, root?, updates}（G8c T2）：scope 缺省 'project'（root 必填，缺 400）；
 *  scope='global' 写用户级文件（root 定位面被忽略——与 raw 端点同裁定），GUI 设置页「逐项写回
 *  来源文件」的数据面。updates 为 Record<语义键, string|number|null>（非对象 400；未知键 400 带
 *  RETIRED 处置提示；值类型坏 400）。结构化写：读原文件（缺=空对象 {version:1}）→ 含注释 409
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
      const retired = Object.hasOwn(RETIRED_KEYS, key) ? RETIRED_KEYS[key] : undefined;
      io.send(res, 400, {
        error: retired !== undefined ? `unknown key "${key}": ${retired}` : `unknown settings key "${key}"`,
      });
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

/** GET /settings/mcp?root=（G8c T4，Settings 页 MCP 清单数据源）：loadMcpServers 两级合并语义的
 *  视图化拆解——直接 parseMcpJsonFile 逐文件读（loadMcpServers 只出合并态）：项目级全量
 *  （source='project'，shadowed=false）+ 全局逐名（被项目同名遮蔽 → shadowed=true 仍列示，GUI
 *  可呈现「被遮蔽」态；未遮蔽 → shadowed=false）。无 root = 仅全局清单（与 /settings providers
 *  面同裁定：空串 root 会让装载面读 cwd 相对 .sunshinex/mcp.json，不可靠）。env 折键名列表，
 *  transport 缺省归一 stdio（mcpRow 单点） */
export function handleMcpGet(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const rootParam = url.searchParams.get('root');
  const root = rootParam !== null && rootParam.length > 0 ? path.resolve(rootParam) : undefined;
  const globalServers = parseMcpJsonFile(path.join(userConfigDir(), 'mcp.json'));
  const projectServers = root !== undefined ? parseMcpJsonFile(path.join(root, '.sunshinex', 'mcp.json')) : [];
  const projectNames = new Set(projectServers.map((s) => s.name));
  io.send(res, 200, {
    servers: [
      ...projectServers.map((s) => mcpRow(s, 'project', false)),
      ...globalServers.map((s) => mcpRow(s, 'global', projectNames.has(s.name))),
    ],
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
    if (r.args !== undefined && (!Array.isArray(r.args) || !r.args.every((a) => typeof a === 'string'))) {
      io.send(res, 400, { error: `servers[${i}].args must be an array of strings` });
      return;
    }
    if (
      r.env !== undefined &&
      (typeof r.env !== 'object' || r.env === null || Array.isArray(r.env) || !Object.values(r.env).every((v) => typeof v === 'string'))
    ) {
      io.send(res, 400, { error: `servers[${i}].env must be an object of string → string` });
      return;
    }
    // 2026-10-26 新字段形态闸门：headers（http/sse 请求头，string→string）/ enabled（布尔整机开关）/
    // disabledTools（停用工具短名数组）——写面虽原样透传未知字段，这三键装载面消费，坏形在此拦
    if (
      r.headers !== undefined &&
      (typeof r.headers !== 'object' || r.headers === null || Array.isArray(r.headers) || !Object.values(r.headers).every((v) => typeof v === 'string'))
    ) {
      io.send(res, 400, { error: `servers[${i}].headers must be an object of string → string` });
      return;
    }
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') {
      io.send(res, 400, { error: `servers[${i}].enabled must be a boolean` });
      return;
    }
    if (r.disabledTools !== undefined && (!Array.isArray(r.disabledTools) || !r.disabledTools.every((a) => typeof a === 'string'))) {
      io.send(res, 400, { error: `servers[${i}].disabledTools must be an array of strings` });
      return;
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
  const loaded = loadEffectivePlugins(root);
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
  // 记录级整面替换：只含入场字段（enabled/config 均缺 = 清空该插件记录的语义——显式写空面）
  const record: Record<string, unknown> = {};
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

/** PUT /settings/agents {root?, scope, op, id, frontmatter?, body?}（G8c T5，AgentsPane 表单增删改）：
 *  - id 安全校验 AGENT_ID_RE → 400（id 直接拼目录路径——路径分隔/穿越/点开头一律拒，upsert 与 delete
 *    同守卫）；scope=project 必带 root（缺 400），global 恒忽略 root（与 raw/mcp 面同裁定）
 *  - upsert：先全量校验后落盘零部分写（name 必填非空白；name/description/isolation/executor 单行
 *    字符串——frontmatter 是单行 KV 词法，含换行的值会注入伪键，多行内容属 body 面；memory 布尔；
 *    body 字符串缺省空）→ renderAgentMd 生成（键序 name 首位）→ 写同目录 tmp → 回读 tmp 过真解析器
 *    parseAgentFrontmatter + name 回环（验证口径=装载口径且验证的就是将要落盘的字节；throw/回环不符
 *    → 清 tmp 500，目标零触碰）→ rename 原子落盘
 *  - delete：<scopeDir>/agents/<id>/ 存在 → rm -rf；不存在 → 幂等 ok。IO 失败（写/rename/rm）不经
 *    本地捕获——沿 dispatch 500 收口（T2/T3/T4 同惯例） */
export async function handleAgentsPut(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { root?: unknown; scope?: unknown; op?: unknown; id?: unknown; frontmatter?: unknown; body?: unknown } | null;
  const op = body?.op;
  if (op !== 'upsert' && op !== 'delete') {
    io.send(res, 400, { error: 'op must be "upsert" or "delete"' });
    return;
  }
  const scope = body?.scope;
  if (scope !== 'project' && scope !== 'global') {
    io.send(res, 400, { error: 'scope must be "project" or "global"' });
    return;
  }
  const id = body?.id;
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) {
    io.send(res, 400, { error: 'id must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/ (used as a directory name)' });
    return;
  }
  const rootRaw = body?.root;
  if (scope === 'project' && (typeof rootRaw !== 'string' || rootRaw.length === 0)) {
    io.send(res, 400, { error: 'root required for scope=project' });
    return;
  }
  const scopeDir = scope === 'global' ? userConfigDir() : path.resolve(rootRaw as string); // global 恒忽略 root（定位面）
  const agentDir = path.join(scopeDir, 'agents', id);
  if (op === 'delete') {
    if (fs.existsSync(agentDir)) fs.rmSync(agentDir, { recursive: true }); // 不存在 = 幂等 ok
    io.send(res, 200, { ok: true });
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
  // 写后回读验证（T3 raw 同款几何）：先落同目录 tmp → 回读 tmp 过真解析器（字节面=目标面）→
  // throw/回环不符即拒：清 tmp 500，目标文件零触碰（不落盘）。验证口径=装配口径 parseAgentFrontmatter——
  // 防生成坏文件（装配链 fail-fast 写盘前防线）；单行校验下此路径仅生成器缺陷可达，纯防御层
  fs.mkdirSync(agentDir, { recursive: true });
  const target = path.join(agentDir, 'agent.md');
  const tmpFile = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, renderAgentMd(fm, bodyText ?? ''), 'utf8');
  try {
    const meta = parseAgentFrontmatter(fs.readFileSync(tmpFile, 'utf8'));
    if (meta.name !== fm.name) throw new Error(`round-trip name mismatch: ${JSON.stringify(meta.name)}`);
  } catch (err) {
    try {
      fs.unlinkSync(tmpFile); // 拒存清 tmp：目标文件零触碰，不留残片
    } catch {
      // tmp 已不在场（写即败等）——无需清
    }
    io.send(res, 500, { error: `generated agent.md failed validation (${target}): ${err instanceof Error ? err.message : String(err)}` });
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
  io.send(res, 200, { ok: true }); // 不触发 settings reload——agents 装配期语义（新会话生效）
}

/** GET /settings/agents/body?scope=project|global&id=&root=（G8d T3，AgentsPane 编辑全文装载）：
 *  读 <scopeDir>/agents/<id>/agent.md 的 frontmatter 后正文全文（parseAgentFrontmatter 单点——
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
  const scopeDir = scope === 'global' ? userConfigDir() : path.resolve(rootParam as string);
  const file = path.join(scopeDir, 'agents', id, 'agent.md');
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

/** GET /settings/skills?root=（G8c T6，Settings 页 Skills 清单数据源）：root 在场 → loadSkillsGrouped
 *  三组固定序（project/user/learned；组内沿装载序去重、跨组不去重——重复 id 是多源同名的事实呈现，
 *  遮蔽裁决属装配面 loadSkills，视图不预裁）。无 root = 仅 user 组（userSkillsDir 全局可扫；
 *  project/learned 均 root 锚定缺席——空组不占位，与 /settings·/settings/mcp「无 root 仅全局面」
 *  同裁定，但 skills 的全局面是 userSkillsDir 而非 userConfigDir 文件） */
export function handleSkillsGet(io: ConfigHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const rootParam = url.searchParams.get('root');
  const root = rootParam !== null && rootParam.length > 0 ? path.resolve(rootParam) : undefined;
  // scope=all(设置·技能页「项目筛选」视图):user 全局 + 注册项目域全枚举(project 组与 learned
  // 组逐域归属项目名;root 入场仅作当前项目组置首锚——设置页 root 可能为空,枚举不依赖它)
  if (url.searchParams.get('scope') === 'all') {
    const groups: SkillsGroup[] = [loadUserSkillsGroup(), ...loadCrossProjectSkillGroups(root)];
    io.send(res, 200, { groups });
    return;
  }
  io.send(res, 200, { groups: root !== undefined ? loadSkillsGrouped(root) : [loadUserSkillsGroup()] });
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
