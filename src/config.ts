import * as fs from 'fs';
import * as path from 'path';
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

/** 取 SUNSHINE.md 指定标题分区的正文行；分区缺失返回空数组 */
function sectionLines(doc: SunshinexDoc, title: string): string[] {
  return doc.sections[title] ?? [];
}

/** 解析「MCP 服务器」分区为 McpServerConfig[]：行式 `name | endpoint [| 传输标记与 args]`。endpoint 以 http(s):// 开头为远程行（缺省 transport:http，可用 transport:sse 覆盖）；否则为 stdio 命令行（缺省不落 transport 字段，显式 transport:stdio 才注入），args 按空格切分。非法 transport 值或传输与形态矛盾的行整行跳过不抛（装配面宁可少配不可错配） */
export function parseMcpServers(doc: SunshinexDoc): McpServerConfig[] {
  const servers: McpServerConfig[] = [];
  for (const line of sectionLines(doc, 'MCP 服务器')) {
    const parts = line.split('|').map((p) => p.trim());
    const name = parts[0] ?? '';
    const endpoint = parts[1] ?? '';
    if (!name || !endpoint) continue;

    let transport: McpServerConfig['transport'];
    let malformed = false;
    const rest: string[] = [];
    for (const seg of parts.slice(2)) {
      const mark = /^transport:(.+)$/.exec(seg);
      if (!mark) {
        rest.push(seg);
      } else if (mark[1] === 'stdio' || mark[1] === 'http' || mark[1] === 'sse') {
        transport = mark[1];
      } else {
        malformed = true;
      }
    }

    if (/^https?:\/\//.test(endpoint)) {
      if (malformed || transport === 'stdio') continue;
      servers.push({ name, url: endpoint, transport: transport ?? 'http' });
    } else {
      if (malformed || transport === 'http' || transport === 'sse') continue;
      const args = rest.join(' ').split(/\s+/).filter((a) => a.length > 0);
      const server: McpServerConfig = { name, command: endpoint };
      if (args.length > 0) server.args = args;
      if (transport === 'stdio') server.transport = 'stdio';
      servers.push(server);
    }
  }
  return servers;
}

/** 解析「网络白名单」分区为域名数组（每行一个，trim）；空数组语义 = 全禁（安全缺省，禁用闸门 Task 2 落地） */
export function parseNetworkAllowlist(doc: SunshinexDoc): string[] {
  return sectionLines(doc, '网络白名单').map((l) => l.trim());
}
