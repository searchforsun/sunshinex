/** 代码回退算法（规格 2026-09-20 rewind+fork §6.2）：单一档案收集 + pre-image 写回；纯模块零会话依赖 */
import * as fs from 'fs';
import * as path from 'path';
import { parseJournalFile, type SnapshotEntry } from './session-journal';

/** 收集行号 ≥ anchorLine 的 user 事件 files（≥ 含锚点轮自身写入），每文件取行号最早一条，行号序输出 */
export function collectRestorePlan(file: string, anchorLine: number): SnapshotEntry[] {
  const parsed = parseJournalFile(file);
  const byPath = new Map<string, SnapshotEntry>();
  parsed.events.forEach((e, i) => {
    if (i + 1 < anchorLine || e.t !== 'user' || !e.files) return;
    for (const f of e.files) {
      if (!byPath.has(f.path)) byPath.set(f.path, { ...f });
    }
  });
  return [...byPath.values()];
}

export function applyRestorePlan(
  root: string,
  plan: SnapshotEntry[],
  blobsDir: string,
): { restored: string[]; removed: string[]; skipped: string[] } {
  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const a of plan) {
    const abs = path.resolve(root, a.path);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      skipped.push(a.path); // 越界路径拒绝（防御性兜底，安全链本应已在写入侧拦截）
      continue;
    }
    try {
      if (a.deleted) {
        fs.rmSync(abs, { force: true });
        removed.push(a.path);
        continue;
      }
      const content = fs.readFileSync(path.join(blobsDir, a.hash));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      restored.push(a.path);
    } catch {
      skipped.push(a.path); // blob 缺失等 IO 失败：跳过并如实列明（规格 §6.3）
    }
  }
  return { restored, removed, skipped };
}
