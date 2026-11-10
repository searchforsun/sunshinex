import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { TurnFileChange } from '../types';

/**
 * 轮次 checkpoint 服务面(2026-11-10 用户裁定「每轮精确看到自己的改动、能撤销」):
 * turn-diff 端点的 blob 读侧 + turn-restore 的 staleness 闸门回写。不走 git——恢复=前像 blob
 * 写回磁盘(Claude Code checkpoint 同款),与审查页(暂存/提交)完全解耦;撤销后的变化自然以
 * 未暂存改动出现在审查页,两边互不干扰。
 */

export interface TurnRestoreResult {
  path: string;
  ok: boolean;
  /** staleness 闸门:当前磁盘内容 ≠ 轮末后像(后续轮次/用户又改过)——拒绝回写防吞改动 */
  stale?: boolean;
  /** 无前像(非 write/edit 快照族,如 bash 改动)——不支持本轮撤销 */
  noCheckpoint?: boolean;
}

/** 单路径 staleness 判定 + 前像回写。blobsRead=hash → Buffer|null(blob 读侧注入,缺 blob 回 noCheckpoint/stale 由调用方兜) */
export function restoreTurnFile(root: string, turn: TurnFileChange, blobsRead: (hash: string) => Buffer | null): TurnRestoreResult {
  if (turn.before === undefined && turn.beforeDeleted !== true) return { path: turn.path, ok: false, noCheckpoint: true };
  const abs = path.resolve(root, turn.path);
  // 判界同 changeContent:路径必须落 root 内(防 journal 面伪造越界路径回写)
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { path: turn.path, ok: false };
  // staleness 闸门:当前磁盘 hash 与轮末后像逐字节比对(afterDeleted=轮末已删 → 现在仍须不存在)
  let current: Buffer | null = null;
  try {
    current = fs.readFileSync(abs);
  } catch {
    current = null;
  }
  if (turn.afterDeleted === true) {
    if (current !== null) return { path: turn.path, ok: false, stale: true };
  } else {
    const currentHash = current !== null ? crypto.createHash('sha256').update(current).digest('hex') : '';
    if (currentHash !== turn.after) return { path: turn.path, ok: false, stale: true };
  }
  if (turn.beforeDeleted === true) {
    // 本轮新建 → 撤销=删文件(已不在场幂等成功)
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      return { path: turn.path, ok: false };
    }
    return { path: turn.path, ok: true };
  }
  const blob = turn.before !== undefined ? blobsRead(turn.before) : null;
  if (blob === null) return { path: turn.path, ok: false, noCheckpoint: true };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, blob);
  } catch {
    return { path: turn.path, ok: false };
  }
  return { path: turn.path, ok: true };
}

/** 轮 diff 内容读侧(turn-diff 端点):前像/后像 blob → utf8 文本(512KB 截断同 /diff 面),缺 blob null */
export function turnDiffContent(turn: TurnFileChange, blobsRead: (hash: string) => Buffer | null, maxBytes: number): { oldContent?: string; newContent: string; truncated: boolean; deleted: boolean } {
  let truncated = false;
  let oldContent: string | undefined;
  if (turn.beforeDeleted !== true && turn.before !== undefined) {
    const blob = blobsRead(turn.before);
    if (blob !== null) {
      truncated = blob.length > maxBytes;
      oldContent = blob.subarray(0, maxBytes).toString('utf8');
    }
  }
  let newContent = '';
  let deleted = false;
  if (turn.afterDeleted === true) {
    deleted = true;
  } else {
    const blob = blobsRead(turn.after);
    if (blob === null) return { oldContent, newContent: '', truncated, deleted: true }; // 后像 blob 缺场按删除面降级(不空差)
    truncated = truncated || blob.length > maxBytes;
    newContent = blob.subarray(0, maxBytes).toString('utf8');
  }
  return { ...(oldContent !== undefined ? { oldContent } : {}), newContent, truncated, deleted };
}
