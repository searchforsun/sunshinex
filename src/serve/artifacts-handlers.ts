import type { ArtifactFile, ChangeFile } from '../types';
import { isDeliverablePath } from '../types';

/** 轮次产物并入（2026-11-12 spec §3.4-3.5）：声明面（write/edit，已保末次）∪ bash 兜底（收尾
 *  差集中白名单**新建**——skill 脚本产件通道；修改类不经兜底，差集无前后像语义），按 path
 *  去重声明优先，64 帽（声明集在先，溢出静默截断） */
export const ARTIFACTS_CAP = 64;

export function mergeRunArtifacts(declared: ArtifactFile[], gitExtra: ChangeFile[]): ArtifactFile[] {
  const seen = new Set(declared.map((a) => a.path));
  const bashArtifacts = gitExtra
    .filter((c) => c.status === 'added' || c.status === 'untracked')
    .map((c) => c.path.replaceAll('\\', '/'))
    .filter((p) => isDeliverablePath(p) && !seen.has(p))
    .map((p) => ({ path: p, source: 'bash' as const }));
  return [...declared, ...bashArtifacts].slice(0, ARTIFACTS_CAP);
}
