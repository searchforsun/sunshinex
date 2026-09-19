/**
 * 记忆路径分类器（规格 §4.1，纯判定零 IO）：安全链判界与写入接缝共用单点，杜绝两处口径漂移。
 * 放在 memory/ 而非 security/——避免安全层反向依赖业务模块。
 * 入参 absPath 须为 realpath 归一后的真实路径（chain.resolveSafe 已保证），故此处不再处理 `..`/符号链接。
 * dataDir 与 absPath **两侧同归一**（审查裁决 2026-09-18）：只归一 absPath 时相对 dataDir 会静默全拒（前缀比对恒失配），非对称口径即缺陷。
 * scope 给出即收窄（子代理 fork 只可写自身 agents/<id>/）；未给出则按路径自身归属分类。
 */
import * as path from 'path';
import { isWithin } from '../../paths';

export type MemoryScope = 'main' | `agents/${string}`;

export function isMemoryPath(
  dataDir: string,
  absPath: string,
  scope?: MemoryScope,
): 'main' | `agents/${string}` | null {
  const memoryRoot = path.join(path.resolve(dataDir), 'memory');
  const abs = path.resolve(absPath);
  // 子树判定走 isWithin 单点（含边界语义与尾分隔符归一），不再各写一份前缀拼接
  if (!isWithin(memoryRoot, abs)) return null;
  const prefix = memoryRoot + path.sep;
  const parts = abs.slice(prefix.length).split(path.sep);
  const [head, id] = parts;
  if (head === undefined || head === '') return null;
  if (head === 'agents') {
    if (!id || parts.length < 3) return null; // agents/ 目录本身与 agents/<id>/ 目录本身都不是记录
    const kind = `agents/${id}` as const;
    return scope === undefined || scope === kind ? kind : null;
  }
  // 主记忆目录直属文件：scope 收窄（子代理 fork）时拒绝
  return scope === undefined ? 'main' : null;
}
