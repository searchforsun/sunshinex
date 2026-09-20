import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SnapshotEntry } from '../../tui/session-journal';

/**
 * write 影子快照收集器（规格 2026-09-20 rewind+fork §6.1）：
 * 每次 write 落盘前捕获目标文件当前状态（pre-image），内容寻址存 <blobsDir>/<sha256>（跨会话去重）；
 * 任务收口时 drain() 交 SessionJournal.amendLastUser 随 user 事件落盘。仅进程内存清单，零工具面变化。
 */
export class WriteSnapshotCollector {
  private pending: SnapshotEntry[] = [];

  constructor(private readonly blobsDir: string) {}

  /** absPath=绝对路径，relPosix=相对项目根的 POSIX 路径（调用方已解析） */
  captureRooted(absPath: string, relPosix: string): void {
    try {
      const content = fs.readFileSync(absPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      fs.mkdirSync(this.blobsDir, { recursive: true });
      const blob = path.join(this.blobsDir, hash);
      if (!fs.existsSync(blob)) fs.writeFileSync(blob, content);
      this.pending.push({ path: relPosix, hash });
    } catch {
      this.pending.push({ path: relPosix, hash: '', deleted: true }); // 写入时不存在（新建类写入）
    }
  }

  drain(): SnapshotEntry[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/** 装配接缝：capture 接受工具原始入参（相对项目根或绝对，安全链 safePath 两种形态都收敛在此），root 外路径跳过（防御性兜底） */
export function makeWriteSnapshotSink(dataDir: string, root: string): { capture(p: string): void; drain(): SnapshotEntry[] } {
  const collector = new WriteSnapshotCollector(path.join(dataDir, 'sessions', '_blobs'));
  return {
    capture(p: string): void {
      const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
      const rel = path.relative(root, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return;
      collector.captureRooted(abs, rel.split(path.sep).join('/'));
    },
    drain: () => collector.drain(),
  };
}
