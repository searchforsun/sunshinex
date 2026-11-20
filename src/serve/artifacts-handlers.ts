import type { Artifact } from '../types';
import { artifactKey } from '../types';
import { sanitizeArtifacts } from '../session/entry';

/** 轮次产物并入（2026-11-12 spec §3.4；2026-11-20 收敛）：唯一来源=report_artifacts 声明面
 *  （任意 kind）。三条自动网（write/edit 写盘钩、轮末 git 新建差集、mtime 轮窗扫描）已按用户
 *  裁定全部退役——此前一次分析任务动辄列出几十个 xml/jar 自动卡；现由 agent 自己判断交付物。
 *  本函数=声明按 artifactKey 去重保序+64 帽单点 */
const ARTIFACTS_CAP = 64;

export function mergeRunArtifacts(declared: Artifact[]): Artifact[] {
  // 2026-11-20 用户裁定「完全去掉自己去解析,交给 agent 自己判断哪些是产物」:自动网全部退役,
  // 本函数只剩声明去重(artifactKey 保序)+ 64 帽单点
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const a of declared) {
    const key = artifactKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= ARTIFACTS_CAP) break;
  }
  return out;
}

/** 产物库聚合行（2026-11-12 spec §6.2;2026-11-14 kind 化随 Artifact 判别联合）：跨 run 按
 *  artifactKey 去重保留最新 run（库语义），runSeq 倒序 */
export type AggregatedArtifact = Artifact & { runSeq: number; endedTs?: number };

/** 聚合去重单点（D71 收敛，2026-11-15）：「按 artifactKey 去重、runSeq 大者胜、倒序输出」库语义
 *  一处承载——scanArtifactsJsonl（档面）与 session.artifactsAggregated（内存+档面合并）共用 */
export function mergeAggregated(rows: Iterable<AggregatedArtifact>): AggregatedArtifact[] {
  const best = new Map<string, AggregatedArtifact>();
  for (const row of rows) {
    const key = artifactKey(row);
    const prev = best.get(key);
    if (prev !== undefined && prev.runSeq >= row.runSeq) continue;
    best.set(key, row);
  }
  return [...best.values()].sort((x, y) => y.runSeq - x.runSeq);
}

/** journal jsonl 行扫描 → 聚合（纯函数；内存当轮面由 session.artifactsAggregated 在其上合并）：
 *  run-open 行开轮记 seq，runmeta 行 artifacts 绑轮；坏行跳过（撕裂不阻断扫描） */
export function scanArtifactsJsonl(text: string): AggregatedArtifact[] {
  const rows: AggregatedArtifact[] = [];
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
        rows.push({
          ...a,
          runSeq: openSeq,
          ...(endedTs !== undefined ? { endedTs } : {}),
        });
      }
    } catch {
      // 坏行跳过（撕裂不阻断扫描,turnChangeFor 同款）
    }
  }
  return mergeAggregated(rows);
}
