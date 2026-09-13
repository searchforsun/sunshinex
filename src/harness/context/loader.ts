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
