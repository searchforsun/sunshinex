/**
 * catalog/mcp 读面：两级（全局/项目）mcp.json 合并列举 + 遮蔽标注。
 * 与装载面（config.loadMcpServers）的分工：装载面丢遮蔽条目（运行时一台只装一份，Task 4 已接线）；
 * 本面是「视图」——项目同名遮蔽全局时，全局条目保留在列并标 shadowed:true（catalog 面要能看清
 * 全局配了什么、被谁遮蔽）。读纪律沿 catalog/io 单点（readJsoncDoc），条目形状判定复用
 * parseMcpJsonFile 的谓词（单点，不另造解析器）；项目条目 approval 接 approvals.approvalState
 * 批准阀（Task 3——项目 mcp.json 随仓库分发，未审不启），全局条目恒 'none'（用户手配不过阀）。
 */
import * as path from 'node:path';
import { userConfigDir } from '../config/env';
import { parseMcpJsonFile } from '../config';
import type { McpServerConfig } from '../types';
import type { Listing, Scope } from './types';
import { CatalogWriteError, readJsoncDoc, writeJsonAtomic, notifyCatalogWrite } from './io';
import { approvalState } from './approvals';

/** catalog 列表条目：name/scope 定位 + 遮蔽标注 + 原始 server 配置 + 审批态（project 接批准阀，global 恒 'none'） */
export interface McpServerEntry {
  name: string;
  scope: Scope;
  /** true = 被另一作用域同名条目遮蔽（项目遮全局）；仅视图标注，条目本身保留在列 */
  shadowed: boolean;
  server: McpServerConfig;
  approval: 'none' | 'approved' | 'pending' | 'denied';
}

/** mcp.json 落位单点：global=<userConfigDir>/mcp.json（globalDir 显式传参 = 测试/重定向口）；project=<root>/.sunshinex/mcp.json（root 缺省回退 cwd，与 CLI 无项目上下文时口径一致） */
export function mcpJsonPath(scope: Scope, root: string | null, globalDir?: string): string {
  if (scope === 'global') return path.join(globalDir ?? userConfigDir(), 'mcp.json');
  return path.join(root ?? process.cwd(), '.sunshinex', 'mcp.json');
}

/**
 * 两级合并列举：全局先、项目后；各作用域内按 name 字典序；同名项目遮蔽全局（全局标 shadowed 保留）。
 * 容错口径沿 Listing（D7）：缺文件 = 空条目不算错；坏 JSON / 根非对象 / mcpServers 形状非法 /
 * 单条目形状非法（parseMcpJsonFile 静默拒收）一律降级产 warnings，不抛错——列举面宁可少配不可错配。
 */
export function listMcpServers(root: string | null, globalDir?: string): Listing<McpServerEntry> {
  const warnings: string[] = [];
  /** 单作用域读面：readJsoncDoc 出文件级告警，parseMcpJsonFile 出条目（缺文件跳过，避免双读双告警） */
  const readScope = (scope: Scope): McpServerConfig[] => {
    const file = mcpJsonPath(scope, root, globalDir);
    const doc = readJsoncDoc(file);
    warnings.push(...doc.warnings);
    if (!doc.exists) return [];
    const servers = parseMcpJsonFile(file);
    // 坏条目对账：doc 里声明了、但形状谓词拒收的键 → 跳过并产告警（parseMcpJsonFile 自身静默）
    const entry = doc.doc['mcpServers'];
    if (entry !== undefined && (entry === null || typeof entry !== 'object' || Array.isArray(entry))) {
      warnings.push(`${file} mcpServers 须为对象，已按空处理`);
      return servers;
    }
    const known = new Set(servers.map((s) => s.name));
    // entry undefined（文件无 mcpServers 键 / 坏 JSON 降级空 doc）= 无键面可对账，跳过即可——
    // 不可 Object.keys(undefined)（Task 4 接线装载面时暴露：坏 JSON 恒抛 TypeError，违反本面 D7 不抛契约）
    for (const name of Object.keys((entry ?? {}) as Record<string, unknown>)) {
      if (!known.has(name)) warnings.push(`${file} 条目 "${name}" 形状非法，已跳过`);
    }
    return servers;
  };
  // approval 接线：项目条目过批准阀（root 缺省回退 cwd——与 mcpJsonPath 项目落位同口径）；
  // 全局条目不过阀（用户手配非仓库供给）恒 'none'。读全局 settings 走 parseSettingsFile 既有纪律。
  const effectiveRoot = root ?? process.cwd();
  const toEntry = (scope: Scope) => (s: McpServerConfig): McpServerEntry => ({
    name: s.name,
    scope,
    shadowed: false,
    server: s,
    approval: scope === 'project' ? approvalState(effectiveRoot, s.name) : 'none',
  });
  const globalEntries = readScope('global').map(toEntry('global'));
  const projectEntries = readScope('project').map(toEntry('project'));
  // 遮蔽标注：项目同名遮蔽全局——全局条目保留在列、标 shadowed:true（视图口径）
  const projectNames = new Set(projectEntries.map((e) => e.name));
  for (const g of globalEntries) if (projectNames.has(g.name)) g.shadowed = true;
  const byName = (a: McpServerEntry, b: McpServerEntry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { entries: [...globalEntries.sort(byName), ...projectEntries.sort(byName)], warnings };
}

/* ---------- 写面（Task 15）：mcp.json 单条目操作收口 ----------
 *  补 MCP 单条目操作缺口（此前仅整块替换 PUT /settings/mcp 与 raw 编辑面）。serve 面（Task 15
 *  handleMcpOp）后续一律薄封装本面，不再各自 fs 直写。写纪律沿 approvals.setApproval 同款守卫序：
 *  readJsoncDoc 读 → COMMENTS 先拒（注释文件结构化写会毁注释——serve 面映射 409 引流 raw 编辑面）
 *  → 畸形 INVALID（readJsoncDoc 对坏 JSON/根非对象降级空 doc，照写等于毁用户既有内容）
 *  → fn 手术 mcpServers（快照等值判零变化，幂等重放零落盘）→ writeJsonAtomic 原子写
 *  → notifyCatalogWrite('mcp', scope, root)（任务14 直发帧——serve 面不得再自行广播防双发）。 */

/** project 作用域 root 必备守卫（写面四函数共用）：mcpJsonPath 的 root:null→cwd 回退仅为读面签名
 *  全整改兜底，写面绝不借道——凭空落 cwd 是伪写（agentWriteTarget 同款裁定）。返回 mcp.json 落位 */
function mcpWriteTarget(scope: Scope, root: string | null): string {
  if (scope === 'project' && root === null) {
    throw new CatalogWriteError('INVALID', 'project-scope mcp write requires root');
  }
  return mcpJsonPath(scope, root);
}

/**
 * mcp.json 写面公共体：守卫（见上）→ fn 手术 mcpServers 键 → 零变化不落盘 → 原子写 + 写通知。
 * mcpServers 键形状坏（非对象/数组/null）→ 整键重置为对象（approvals section / daemon plugins 键
 * 同款先例——装载面本就告警忽略坏形状，写面不保留垃圾）；fn 内抛 CatalogWriteError 原样穿透
 * （缺失条目一类语义拒写），目标零触碰。
 */
function mutateMcpServers(scope: Scope, root: string | null, fn: (servers: Record<string, unknown>) => void): void {
  const file = mcpWriteTarget(scope, root);
  const read = readJsoncDoc(file);
  if (read.hasComments) {
    throw new CatalogWriteError('COMMENTS', `${file} 含 JSONC 注释，结构化写会毁注释；请经 raw 编辑面移除注释后重试`);
  }
  if (read.exists && read.warnings.length > 0) {
    throw new CatalogWriteError('INVALID', read.warnings[0]!);
  }
  const section = read.doc['mcpServers'];
  const servers: Record<string, unknown> =
    typeof section === 'object' && section !== null && !Array.isArray(section)
      ? (section as Record<string, unknown>)
      : {};
  const before = JSON.stringify(servers);
  fn(servers);
  if (JSON.stringify(servers) === before) return; // 零变化不落盘（无盘上副作用——幂等重放不产写通知帧）
  read.doc['mcpServers'] = servers;
  writeJsonAtomic(file, JSON.stringify(read.doc, null, 2) + '\n');
  notifyCatalogWrite('mcp', scope, root);
}

/**
 * add 条目形状校验（沿 parseMcpJsonFile 装载接受口径，写面 fail-fast 而非装载面静默跳过）：
 * name 非空串；server 须对象；transport 在场须 stdio|http|sse；http/sse 须非空 url、显式 stdio 须
 * 非空 command；无 transport 时 command/url 至少其一。可选键形状（args/env/headers/enabled/
 * disabledTools）不在此拦——op 面原样透传（与整块 PUT 的写面拦形分工：本面收口最小接受口径，
 * 坏可选键由装载面 strArr/strRecord 容错跳过）。
 */
function validateMcpServerPayload(name: unknown, server: unknown): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new CatalogWriteError('INVALID', 'mcp server name required (non-empty string)');
  }
  if (name === '__proto__') {
    // JSON.parse 产物是普通对象——servers['__proto__'] = x 走原型 setter 改写原型而非落自键
    throw new CatalogWriteError('INVALID', 'mcp server name "__proto__" is not allowed');
  }
  if (typeof server !== 'object' || server === null || Array.isArray(server)) {
    throw new CatalogWriteError('INVALID', `mcp server "${name}" must be an object`);
  }
  const s = server as Record<string, unknown>;
  if (s.transport !== undefined && s.transport !== 'stdio' && s.transport !== 'http' && s.transport !== 'sse') {
    throw new CatalogWriteError('INVALID', `mcp server "${name}" transport must be "stdio" | "http" | "sse"`);
  }
  // 接受口径与 parseMcpJsonFile 对齐：空串 command 不算在场（装载面 `else if (command)` 空串 falsy
  // 跳过）、url 非空白才算在场（装载面 trim 判空）
  const hasCommand = typeof s.command === 'string' && s.command.length > 0;
  const hasUrl = typeof s.url === 'string' && s.url.trim().length > 0;
  if (s.transport === 'http' || s.transport === 'sse') {
    if (!hasUrl) throw new CatalogWriteError('INVALID', `mcp server "${name}": ${s.transport} transport requires a url`);
  } else if (s.transport === 'stdio') {
    if (!hasCommand) throw new CatalogWriteError('INVALID', `mcp server "${name}": stdio transport requires a command`);
  } else if (!hasCommand && !hasUrl) {
    throw new CatalogWriteError('INVALID', `mcp server "${name}": command or url required (at least one)`);
  }
}

/** 新增/整写一个 mcp server 条目（Task 15 写面）：形状校验 → mutate（键 = name，值 = server 原样
 *  透传——含可选键/未知字段，写面不擅自裁剪）。同名即覆盖（add 即 upsert，GUI 表单编辑与新增
 *  同入口）；同值重加快照等值零落盘 */
export function upsertMcpServer(root: string | null, scope: Scope, name: string, server: unknown): void {
  validateMcpServerPayload(name, server);
  mutateMcpServers(scope, root, (servers) => {
    servers[name] = server;
  });
}

/** 移除一个 mcp server 条目：键不存在（Object.hasOwn 只认真自键——原型键不可冒名）→ INVALID
 *  （catalog 严格语义，非幂等——幂等收口属调用面裁量，沿 removeAgent 同裁定） */
export function removeMcpServer(root: string | null, scope: Scope, name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new CatalogWriteError('INVALID', 'mcp server name required (non-empty string)');
  }
  mutateMcpServers(scope, root, (servers) => {
    if (!Object.hasOwn(servers, name)) {
      throw new CatalogWriteError('INVALID', `mcp server not found: ${scope}/${name}`);
    }
    delete servers[name];
  });
}

/** 启停一个 mcp server 条目（整机开关键 enabled——装载面 enabled !== false 才拉起进程）：条目缺失
 *  或形状非法（非对象条目无从手术）→ INVALID；幂等重放（已是目标态）快照等值零落盘 */
export function setMcpServerEnabled(root: string | null, scope: Scope, name: string, enabled: boolean): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new CatalogWriteError('INVALID', 'mcp server name required (non-empty string)');
  }
  mutateMcpServers(scope, root, (servers) => {
    if (!Object.hasOwn(servers, name)) {
      throw new CatalogWriteError('INVALID', `mcp server not found: ${scope}/${name}`);
    }
    const entry = servers[name];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new CatalogWriteError('INVALID', `mcp server "${name}" entry must be an object`);
    }
    (entry as Record<string, unknown>)['enabled'] = enabled;
  });
}
