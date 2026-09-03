import * as fs from 'fs';
import * as path from 'path';
import { ProjectContext } from './types';

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
