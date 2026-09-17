import * as fs from 'fs';
import * as path from 'path';
import { ContextItem } from '../../types';

/** 分层指令加载：SUNSHINE.md + @path import 展开（递归 4 层） */
export class ContextLoader {
  constructor(private root: string) {}

  load(): ContextItem[] {
    const items: ContextItem[] = [];
    const p = path.join(this.root, 'SUNSHINE.md');
    if (!fs.existsSync(p)) return items;
    this.collect(p, items, 0);
    return items;
  }

  private collect(file: string, items: ContextItem[], depth: number): void {
    if (depth > 4) return;
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^@([\w./-]+\.md)$/.exec(line.trim());
      if (m) {
        const target = path.resolve(path.dirname(file), m[1]);
        if (fs.existsSync(target)) this.collect(target, items, depth + 1);
        continue;
      }
      if (line.trim().length > 0) items.push({ kind: 'instruction', content: line });
    }
  }
}

/** SUNSHINE.md「Compact Instructions」区提取（规格 E 项，对标 CLAUDE.md 同名区）：
 *  识别 `## Compact Instructions` / `## 压缩指令` 标题，区体在下个二级标题或文件尾终止；
 *  无区或区体为空返回 null——压缩摘要 prompt 无区时与现形态逐字节一致。 */
export function extractCompactInstructions(md: string): string | null {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+(Compact Instructions|压缩指令)\s*$/.test(l.trim()));
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) break;
    body.push(lines[i]);
  }
  const text = body.join('\n').trim();
  return text.length > 0 ? text : null;
}
