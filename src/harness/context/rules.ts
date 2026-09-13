import * as fs from 'fs';
import * as path from 'path';
import { ContextItem } from '../../types';

/** path-scoped 规则：.sunshine/rules/ 目录，命中匹配文件才加载 */
export class RulesRegistry {
  constructor(private root: string) {}

  forPath(relPath: string): ContextItem[] {
    const dir = path.join(this.root, '.sunshine', 'rules');
    if (!fs.existsSync(dir)) return [];
    const out: ContextItem[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = /^paths:\s*(.+)$/m.exec(raw);
      if (m && !m[1].split(',').some((p) => relPath.includes(p.trim()))) continue;
      out.push({ kind: 'instruction', content: raw });
    }
    return out;
  }
}
