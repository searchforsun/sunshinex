import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SnapshotEntry } from '../../tui/session-journal';

/**
 * write 影子快照收集器（规格 2026-09-20 rewind+fork §6.1）：
 * 每次 write 落盘前捕获目标文件当前状态（pre-image），内容寻址存 <blobsDir>/<sha256>（跨会话去重）；
 * 任务收口时 drain() 以 snapshots 事件尾追落盘（规格 docs/superpowers/specs/2026-09-22-event-level-journal-persistence-design.md D2）。仅进程内存清单，零工具面变化。
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

  /** G7 diff 查询面（daemon /session/:id/diff 消费）：同路径第 ordinal 次（1 基）pre-image 捕获——
   *  daemon 侧以调用序（帧缓冲内同路径 write 调用的位次）对位，同路径多次写各自取回写前态；
   *  drain 后清单即空（缺场 undefined）。ordinal 越界同样 undefined */
  nthFor(relPosix: string, ordinal: number): SnapshotEntry | undefined {
    if (ordinal < 1) return undefined;
    let seen = 0;
    for (const e of this.pending) {
      if (e.path !== relPosix) continue;
      seen += 1;
      if (seen === ordinal) return e;
    }
    return undefined;
  }

  /** blob 内容读取（hash 寻址，内容寻址落盘 <blobsDir>/<sha256>）：缺场/读失败 null */
  readBlob(hash: string): Buffer | null {
    try {
      return fs.readFileSync(path.join(this.blobsDir, hash));
    } catch {
      return null;
    }
  }
}

/** 装配接缝：capture 接受工具原始入参（相对项目根或绝对，安全链 safePath 两种形态都收敛在此），root 外路径跳过（防御性兜底）；
 *  G7 增 diff 查询面（nthFor/readBlob——daemon /session/:id/diff 消费，run 中查内存清单实时可得：daemon 会话
 *  drain 仅在 dispose/reset（快照清单随 seal 落 journal），会话存续期内清单常驻内存） */
export interface WriteSnapshotSink {
  capture(p: string): void;
  drain(): SnapshotEntry[];
  /** 按调用序查该路径第 ordinal 次（1 基）pre-image 捕获（p 同 capture 口径：相对 root 或绝对） */
  nthFor(p: string, ordinal: number): SnapshotEntry | undefined;
  /** blob 内容读取（hash 寻址 <dataDir>/sessions/_blobs/<sha256>）；缺场 null */
  readBlob(hash: string): Buffer | null;
}

export function makeWriteSnapshotSink(dataDir: string, root: string): WriteSnapshotSink {
  const collector = new WriteSnapshotCollector(path.join(dataDir, 'sessions', '_blobs'));
  /** 工具入参（相对/绝对）→ root 相对 POSIX；root 外 undefined（capture 跳过/nthFor 缺场同口径） */
  const relOf = (p: string): string | undefined => {
    const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join('/');
  };
  return {
    capture(p: string): void {
      const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
      const rel = relOf(abs);
      if (rel === undefined) return;
      collector.captureRooted(abs, rel);
    },
    drain: () => collector.drain(),
    nthFor: (p, ordinal) => {
      const rel = relOf(path.isAbsolute(p) ? p : path.resolve(root, p));
      return rel === undefined ? undefined : collector.nthFor(rel, ordinal);
    },
    readBlob: (hash) => collector.readBlob(hash),
  };
}
