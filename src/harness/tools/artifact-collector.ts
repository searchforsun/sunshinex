import type { ArtifactFile } from '../../types';
import { isDeliverablePath } from '../../types';

/** 轮次产物声明收集器（2026-11-12 spec §3.3；仿 WriteSnapshotCollector 注入模式：内存清单、
 *  run 收口 drain、缺省不注入=无产物、零工具面变化）。callId 在声明时刻拿不到（调用 id 随
 *  tool-result 回执才现），与快照族同根因同解：回执时回标末尾未标条目 */
export class ArtifactCollector {
  private pending: ArtifactFile[] = [];

  /** write/edit 落盘声明（builtin.ts commitFileWrite 单点调钩）：白名单命中才记 */
  record(relPosix: string, source: 'write' | 'edit'): void {
    if (!isDeliverablePath(relPosix)) return;
    this.pending.push({ path: relPosix, source });
  }

  /** tool-result 回执回标（serve/session.ts 泵 tagCall 邻位）：挂该路径末尾未回标条目——
   *  多刀写同路径时末尾未标=本次调用产物；回标路径反斜杠归一比对 */
  tagCall(relPosix: string, callId: string): void {
    const want = relPosix.replaceAll('\\', '/');
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i]!.path === want && this.pending[i]!.callId === undefined) {
        this.pending[i]!.callId = callId;
        return;
      }
    }
  }

  /** run 收口：按 path 去重保留末次（先 write 后 edit 视同一条），并清空清单 */
  drain(): ArtifactFile[] {
    if (this.pending.length === 0) return [];
    const byPath = new Map<string, ArtifactFile>();
    for (const a of this.pending) byPath.set(a.path, a);
    this.pending = [];
    return [...byPath.values()];
  }
}
