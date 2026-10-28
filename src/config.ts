import * as fs from 'fs';
import * as path from 'path';
import { userConfigDir } from './config/env';
import { listMcpServers } from './catalog/mcp';
import { McpServerConfig, ProjectContext } from './types';

interface SunshinexDoc {
  sections: Record<string, string[]>;
  raw: string;
}

/** 解析 SUNSHINE.md：以 # 标题为分区，正文按行收集（跳过空行） */
export function parseSunshinex(md: string): SunshinexDoc {
  const sections: Record<string, string[]> = {};
  let current = '(preamble)';
  sections[current] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (m) {
      current = m[1];
      sections[current] = [];
    } else if (line.trim().length > 0) {
      sections[current].push(line.trim());
    }
  }
  return { sections, raw: md };
}

/** 从根目录加载 SUNSHINE.md，提炼规则/架构原则/项目名 */
export function loadSunshinex(root: string): ProjectContext | null {
  const p = path.join(root, 'SUNSHINE.md');
  if (!fs.existsSync(p)) return null;
  const doc = parseSunshinex(fs.readFileSync(p, 'utf8'));

  const rules: string[] = [];
  for (const [title, lines] of Object.entries(doc.sections)) {
    if (/规则|规范|rule|convention|编码|安全/i.test(title)) {
      for (const l of lines) {
        if (l.startsWith('-') || l.startsWith('*')) {
          rules.push(l.replace(/^[-*]\s*/, ''));
        }
      }
    }
  }

  const name = doc.sections['项目名称']?.[0] ?? 'sunshinex';
  const architecture = doc.sections['架构原则'] ?? [];
  return { name, rules, architecture };
}

const VALID_TRANSPORTS = ['stdio', 'http', 'sse'] as const;

/** 字段形状谓词单点(2026-10-27 技术债轮 D53②/G-4 上收:parseMcpJsonFile 装载面、serve 配置写面
 *  守卫、config/plugins 装载展开三处同谓词,原三份本地复制)。值或 undefined 形——undefined 即形状非法 */
export function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

export function strRecord(v: unknown): Record<string, string> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')
    ? (v as Record<string, string>)
    : undefined;
}

/** 解析单个 mcp.json 文件为 `mcpServers` 条目数组。文件缺失或 JSON 非法返回 []；非法条目（字段形态或传输与形态矛盾）跳过不抛（装配面宁可少配不可错配）。
 *  G8c T4 起导出：daemon /settings/mcp 两级视图需逐文件分立拆解（loadMcpServers 只出合并态），签名沿内部形 */
export function parseMcpJsonFile(p: string): McpServerConfig[] {
  if (!fs.existsSync(p)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
  const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { mcpServers?: unknown }).mcpServers : undefined;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  const servers: McpServerConfig[] = [];
  for (const [name, cfg] of Object.entries(entry as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const c = cfg as { command?: unknown; args?: unknown; env?: unknown; transport?: unknown; url?: unknown; headers?: unknown; enabled?: unknown; disabledTools?: unknown };
    if (c.transport !== undefined && !(VALID_TRANSPORTS as readonly string[]).includes(c.transport as string)) continue;
    const transport = VALID_TRANSPORTS.includes(c.transport as (typeof VALID_TRANSPORTS)[number])
      ? (c.transport as McpServerConfig['transport'])
      : undefined;
    /** 无 scheme 容错（2026-10-26 用户实测 gitnexus 形态 `url:"192.168.66.73:3000/api/mcp"`）：
     *  缺 http(s):// 前缀即补 http://（主机:端口 形态的主流通配；new URL 对裸 host:port 会把
     *  host 段误判为 protocol，必须先归一）。畸形 url（含空白等）不在此判——交由装配/探测面
     *  new URL 的 Invalid url 报警，此处只做前缀补全 */
    const normUrl = (u: string): string => (/^https?:\/\//i.test(u) ? u : `http://${u}`);
    const rawUrl = typeof c.url === 'string' && c.url.trim() !== '' ? c.url.trim() : undefined;
    const url = rawUrl !== undefined ? normUrl(rawUrl) : undefined;
    const command = typeof c.command === 'string' ? c.command : undefined;
    const env = strRecord(c.env);
    const args = strArr(c.args);
    const headers = strRecord(c.headers);
    const enabled = typeof c.enabled === 'boolean' ? c.enabled : undefined;
    const disabledTools = strArr(c.disabledTools);
    if (transport === 'http' || transport === 'sse') {
      if (!url) continue;
      servers.push({ name, url, transport, ...(env ? { env } : {}), ...(headers ? { headers } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(disabledTools ? { disabledTools } : {}) });
    } else if (transport === 'stdio') {
      if (!command) continue;
      servers.push({ name, command, ...(args ? { args } : {}), ...(env ? { env } : {}), transport, ...(enabled !== undefined ? { enabled } : {}), ...(disabledTools ? { disabledTools } : {}) });
    } else if (url) {
      // 无 transport 的 url 条目：一律 http 流派（无 scheme 已补全，原 https?:// 显式前缀原样）
      servers.push({ name, url, transport: 'http', ...(env ? { env } : {}), ...(headers ? { headers } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(disabledTools ? { disabledTools } : {}) });
    } else if (command) {
      servers.push({ name, command, ...(args ? { args } : {}), ...(env ? { env } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(disabledTools ? { disabledTools } : {}) });
    }
  }
  return servers;
}

/**
 * 两级装载 MCP 服务器配置（2026-10-28 裁定反转 2026-10-27「应用级」——spec §1 决策 1「项目遮蔽全局 +
 * 项目 MCP 首次启用需一次确认」/§4 批准阀；项目 mcp.json 复活装载）。收口 catalog 单一事实源
 * （listMcpServers 两级合并 + 审批标注），本函数是其上的「装载口径」过滤链，与视图面分工：
 * 视图保留被遮蔽条目标 shadowed:true，装载面只出实际拉起进程的集合——
 * ① enabled !== false（缺省语义）：全局或项目停用均不装载（不拉起进程）；
 * ② 项目条目过批准阀（approvalState 读全局 settings mcpApprovals/mcpDenied）：仅 approved 装载，
 *    pending/denied 一律不拉起进程（项目 mcp.json 随仓库分发，未审先启等于仓库供给方拿到本机执行权）；
 *    全局条目用户手配不过阀（catalog 恒标 'none'）；
 * ③ 同名遮蔽以「实际装载」计：被 ①② 过滤掉的项目条目不遮蔽全局同名（未批准/停用不吃掉全局同款）。
 * 输出序沿 catalog（全局先、项目后，各作用域内 name 字典序）。
 * 结构：`{ "mcpServers": { "<name>": { command, args?, env?, transport?, url? } } }`（与主流 MCP 客户端 mcpServers 键位兼容）。
 * require 环说明：catalog/mcp 复用本模块 parseMcpJsonFile 谓词、本模块经其出合并视图——双方均函数体内
 * 引用（CJS 晚绑定），无顶层执行依赖。
 */
export function loadMcpServers(projectRoot: string, globalDir: string = userConfigDir()): McpServerConfig[] {
  const { entries } = listMcpServers(projectRoot, globalDir);
  const loadable = entries
    .filter((e) => e.server.enabled !== false)
    .filter((e) => e.scope !== 'project' || e.approval === 'approved');
  const loadedProjectNames = new Set(loadable.filter((e) => e.scope === 'project').map((e) => e.name));
  return loadable.filter((e) => e.scope !== 'global' || !loadedProjectNames.has(e.name)).map((e) => e.server);
}

