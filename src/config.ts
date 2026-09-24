import * as fs from 'fs';
import * as path from 'path';
import { userConfigDir } from './config/env';
import { McpServerConfig, ProjectContext } from './types';

export interface SunshinexDoc {
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

/** 解析单个 mcp.json 文件为 `mcpServers` 条目数组。文件缺失或 JSON 非法返回 []；非法条目（字段形态或传输与形态矛盾）跳过不抛（装配面宁可少配不可错配） */
function parseMcpJsonFile(p: string): McpServerConfig[] {
  if (!fs.existsSync(p)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
  const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { mcpServers?: unknown }).mcpServers : undefined;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
  const strRecord = (v: unknown): Record<string, string> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')
      ? (v as Record<string, string>)
      : undefined;
  const servers: McpServerConfig[] = [];
  for (const [name, cfg] of Object.entries(entry as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const c = cfg as { command?: unknown; args?: unknown; env?: unknown; transport?: unknown; url?: unknown };
    if (c.transport !== undefined && !(VALID_TRANSPORTS as readonly string[]).includes(c.transport as string)) continue;
    const transport = VALID_TRANSPORTS.includes(c.transport as (typeof VALID_TRANSPORTS)[number])
      ? (c.transport as McpServerConfig['transport'])
      : undefined;
    const url = typeof c.url === 'string' ? c.url : undefined;
    const command = typeof c.command === 'string' ? c.command : undefined;
    const env = strRecord(c.env);
    const args = strArr(c.args);
    if (transport === 'http' || transport === 'sse') {
      if (!url) continue;
      servers.push({ name, url, transport, ...(env ? { env } : {}) });
    } else if (transport === 'stdio') {
      if (!command) continue;
      servers.push({ name, command, ...(args ? { args } : {}), ...(env ? { env } : {}), transport });
    } else if (url && /^https?:\/\//.test(url)) {
      servers.push({ name, url, transport: 'http', ...(env ? { env } : {}) });
    } else if (command) {
      servers.push({ name, command, ...(args ? { args } : {}), ...(env ? { env } : {}) });
    }
  }
  return servers;
}

/** 两级装载 MCP 服务器配置：项目级 .sunshinex/mcp.json 遮蔽全局 ~/.sunshinex/mcp.json（id 撞名就近遮蔽，与技能装载链同构）。结构：`{ "mcpServers": { "<name>": { command, args?, env?, transport?, url? } } }`（与主流 MCP 客户端 mcpServers 键位兼容） */
export function loadMcpServers(projectRoot: string, globalDir: string = userConfigDir()): McpServerConfig[] {
  const global = parseMcpJsonFile(path.join(globalDir, 'mcp.json'));
  const project = parseMcpJsonFile(path.join(projectRoot, '.sunshinex', 'mcp.json'));
  if (project.length === 0) return global;
  const shadowed = new Set(project.map((s) => s.name));
  return [...project, ...global.filter((s) => !shadowed.has(s.name))];
}

