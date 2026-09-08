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

/** 解析「MCP 服务器」分区为 McpServerConfig[]：行式 `name | command | args...`，args 按空格切分；name 或 command 缺失的行跳过不抛（装配面宁可少配不可错配） */
export function parseMcpServers(doc: SunshinexDoc): McpServerConfig[] {
  const servers: McpServerConfig[] = [];
  for (const line of sectionLines(doc, 'MCP 服务器')) {
    const parts = line.split('|').map((p) => p.trim());
    const name = parts[0] ?? '';
    const command = parts[1] ?? '';
    if (!name || !command) continue;
    const args = line.split('|').slice(2).join('|').trim().split(/\s+/).filter((a) => a.length > 0);
    servers.push(args.length > 0 ? { name, command, args } : { name, command });
  }
  return servers;
}

/** 解析「网络白名单」分区为域名数组（每行一个，trim）；空数组语义 = 全禁（安全缺省，禁用闸门 Task 2 落地） */
export function parseNetworkAllowlist(doc: SunshinexDoc): string[] {
  return sectionLines(doc, '网络白名单').map((l) => l.trim());
}
