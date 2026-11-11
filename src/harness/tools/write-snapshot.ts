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
  /** pending 中已落 journal 的条数(takeUnsealed 游标;pending 本身留给 nthFor 按调用序查 diff) */
  private sealed = 0;

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

  /** 每次改动的后像落库（2026-11-11 用户裁定「不兼容旧会话，就是读快照」）：紧跟同路径 capture 之后
   *  调用——找到 pending 末尾该路径条目挂 afterHash（内容寻址同库去重）。capture 被跳过（root 外）
   *  或无匹配条目时静默不挂——diff 查询面按无快照 404（不回退现盘，防累计漂移假差） */
  attachAfterRooted(relPosix: string, content: string): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i].path === relPosix) {
        this.pending[i].afterHash = this.store(Buffer.from(content, 'utf8'));
        return;
      }
    }
  }

  /** 捕获按调用回标（2026-11-11 每刀独立快照）：session 泵在 tool-result 回执时调——把该路径
   *  末尾未回标的条目挂上 callId（同路径写批次面链队串行,末尾未标=本次调用产物）。无未标条目
   *  （失败调用未捕获/已全标）静默——回执位次寻址的整条路径退役 */
  tagCallRooted(relPosix: string, callId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const e = this.pending[i];
      if (e.path !== relPosix) continue;
      if (e.callId !== undefined) return; // 末尾该路径条目已标=本调用没产生捕获(如 edit 未命中失败)
      e.callId = callId;
      return;
    }
  }

  /** 按 callId 直取捕获（内存清单内）：重启后清单空走 journal snapshots 行回查（session 面） */
  byCallRooted(callId: string): SnapshotEntry | undefined {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i].callId === callId) return this.pending[i];
    }
    return undefined;
  }

  drain(): SnapshotEntry[] {
    const out = this.pending;
    this.pending = [];
    this.sealed = 0;
    return out;
  }

  /** 取上次以来的新增捕获并推进游标,不清 pending(daemon 逐轮落档:回退文件要按轮定位改动) */
  takeUnsealed(): SnapshotEntry[] {
    const out = this.pending.slice(this.sealed);
    this.sealed = this.pending.length;
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

  /** blob 写入面（2026-11-10 轮次 checkpoint：轮末后像落库与 capture 同库同径——内容寻址去重，
   *  撤销/轮 diff 读侧复用 readBlob 单点）。返回 sha256 hash */
  store(content: Buffer): string {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    fs.mkdirSync(this.blobsDir, { recursive: true });
    const blob = path.join(this.blobsDir, hash);
    if (!fs.existsSync(blob)) fs.writeFileSync(blob, content);
    return hash;
  }
}

/** 装配接缝：capture 接受工具原始入参（相对项目根或绝对，安全链 safePath 两种形态都收敛在此），root 外路径跳过（防御性兜底）；
 *  G7 增 diff 查询面（nthFor/readBlob——daemon /session/:id/diff 消费，run 中查内存清单实时可得：daemon 会话
 *  drain 仅在 dispose/reset（快照清单随 seal 落 journal），会话存续期内清单常驻内存） */
export interface WriteSnapshotSink {
  capture(p: string): void;
  /** 落盘后的后像快照（2026-11-11）：紧跟 capture(p) 同路径调用，content=写入的新内容——
   *  挂到末尾该路径条目的 afterHash；无匹配条目（root 外 capture 被跳过）静默不挂 */
  captureAfter(p: string, content: string): void;
  /** 捕获按调用回标（2026-11-11 每刀独立快照）：tool-result 回执时把该路径末尾未标条目挂 callId */
  tagCall(p: string, callId: string): void;
  /** 按 callId 直取捕获（2026-11-11）：内存清单内查（重启后走 journal snapshots 行回查） */
  byCall(callId: string): SnapshotEntry | undefined;
  drain(): SnapshotEntry[];
  takeUnsealed(): SnapshotEntry[];
  /** 按调用序查该路径第 ordinal 次（1 基）pre-image 捕获（p 同 capture 口径：相对 root 或绝对） */
  nthFor(p: string, ordinal: number): SnapshotEntry | undefined;
  /** blob 内容读取（hash 寻址 <dataDir>/sessions/_blobs/<sha256>）；缺场 null */
  readBlob(hash: string): Buffer | null;
  /** blob 写入（内容寻址同库；返回 sha256）——轮末后像落库（turn checkpoint）消费 */
  store(content: Buffer): string;
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
    captureAfter: (p, content) => {
      const rel = relOf(path.isAbsolute(p) ? p : path.resolve(root, p));
      if (rel === undefined) return;
      collector.attachAfterRooted(rel, content);
    },
    tagCall: (p, callId) => {
      const rel = relOf(path.isAbsolute(p) ? p : path.resolve(root, p));
      if (rel === undefined) return;
      collector.tagCallRooted(rel, callId);
    },
    byCall: (callId) => collector.byCallRooted(callId),
    drain: () => collector.drain(),
    takeUnsealed: () => collector.takeUnsealed(),
    nthFor: (p, ordinal) => {
      const rel = relOf(path.isAbsolute(p) ? p : path.resolve(root, p));
      return rel === undefined ? undefined : collector.nthFor(rel, ordinal);
    },
    readBlob: (hash) => collector.readBlob(hash),
    store: (content) => collector.store(content),
  };
}
