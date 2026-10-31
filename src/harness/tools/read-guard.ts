import * as crypto from 'crypto';
import { CodedToolError } from '../tools';

/** edit 先读守卫（2026-10-31 用户裁定「一批编辑先读源码再编辑,加守卫」）：read 工具记录快照、
 *  edit 工具校验——目标文件未读过即拒（NOT_READ）、读过但磁盘内容已变即拒（STALE_READ）。
 *  edit 字面匹配对文件当前态,凭记忆构造 old_string 是 not-found 空转主因;守卫把「先读后改」
 *  从工具描述规程升级为执行器硬闸。
 *
 *  快照粒度=内容哈希（非 mtime——同秒写入与外部改写无法靠时间戳区分）;edit 成功后快照随新
 *  内容前进（edit 内部已读磁盘现态,连环编辑无需重读）。守卫实例随 Harness 运行时铸造
 *  （setMode/reset 换铸即新守卫——换铸后模型须重读目标文件再 edit,与「快照出生重建」同族语义）;
 *  未注入（测试夹具）时 edit 不设闸,既有夹具零改动。 */

/** 守卫面（builtin.ts opts 可选接缝）：read 成功路径 record;edit 匹配前 ensureRead,违例抛
 *  CodedToolError 同族错误码（NOT_READ / STALE_READ） */
export interface ReadGuard {
  record(abs: string, content: string): void;
  ensureRead(abs: string, currentContent: string): void;
}

const sha = (content: string): string => crypto.createHash('sha256').update(content).digest('hex');

export function createReadGuard(): ReadGuard {
  const snapshots = new Map<string, string>();
  return {
    record(abs, content) {
      snapshots.set(abs, sha(content));
    },
    ensureRead(abs, currentContent) {
      const snap = snapshots.get(abs);
      if (snap === undefined) {
        throw new CodedToolError('NOT_READ', `edit requires reading the file first: ${abs} has not been read in this session — call the read tool on it, then base old_string on its current text`);
      }
      if (snap !== sha(currentContent)) {
        throw new CodedToolError('STALE_READ', `${abs} has changed since your last read (another tool or process wrote it) — read the file again and base old_string on its current text, do not retry from memory`);
      }
    },
  };
}
