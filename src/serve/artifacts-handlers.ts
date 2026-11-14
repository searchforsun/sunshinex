import type { ArtifactFile, ChangeFile } from '../types';
import { isDeliverablePath } from '../types';
import { sanitizeArtifacts } from '../session/entry';

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

/** 产物库聚合行（2026-11-12 spec §6.2）：跨 run 按 path 去重保留最新 run（库语义），runSeq 倒序 */
export interface AggregatedArtifact {
  path: string;
  source: 'write' | 'edit' | 'bash';
  callId?: string;
  runSeq: number;
  endedTs?: number;
}

/** journal jsonl 行扫描 → 聚合（纯函数；内存当轮面由 session.artifactsAggregated 在其上合并）：
 *  run-open 行开轮记 seq，runmeta 行 artifacts 绑轮；坏行跳过（撕裂不阻断扫描） */
export function scanArtifactsJsonl(text: string): AggregatedArtifact[] {
  const best = new Map<string, AggregatedArtifact>();
  let openSeq = -1;
  for (const line of text.split('\n')) {
    if (!line.includes('"run-open"') && !line.includes('"runmeta"')) continue;
    try {
      const e = JSON.parse(line) as { t?: string; seq?: unknown; artifacts?: unknown; endedTs?: unknown };
      if (e.t === 'run-open') {
        openSeq = typeof e.seq === 'number' ? e.seq : openSeq;
        continue;
      }
      if (e.t !== 'runmeta' || e.seq !== undefined || openSeq < 0) continue;
      const artifacts = sanitizeArtifacts(e.artifacts);
      const endedTs = typeof e.endedTs === 'number' ? e.endedTs : undefined;
      if (artifacts === undefined) continue;
      for (const a of artifacts) {
        const prev = best.get(a.path);
        if (prev !== undefined && prev.runSeq >= openSeq) continue;
        best.set(a.path, {
          path: a.path,
          source: a.source,
          ...(a.callId !== undefined ? { callId: a.callId } : {}),
          runSeq: openSeq,
          ...(endedTs !== undefined ? { endedTs } : {}),
        });
      }
    } catch {
      // 坏行跳过（撕裂不阻断扫描,turnChangeFor 同款）
    }
  }
  return [...best.values()].sort((x, y) => y.runSeq - x.runSeq);
}
