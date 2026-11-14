import { artifactKey, type Artifact } from '../../types';
import { isDeliverablePath } from '../../types';

/** 轮次产物收集器（2026-11-12 spec §3.3;2026-11-14 kind 化改宗：file/url/command 三类,仿
 *  WriteSnapshotCollector 注入模式:内存清单、run 收口 drain、缺省不注入=无产物、零工具面变化）。
 *  两个写入口:record=write/edit 落盘自动声明(白名单门,kind file);declare=report_artifacts
 *  工具面模型显式声明(任意 kind,不限白名单,title/desc 随行)。callId 在声明时刻拿不到（调用 id
 *  随 tool-result 回执才现），与快照族同根因同解：回执时回标末尾未标条目 */
export class ArtifactCollector {
  private pending: Artifact[] = [];

  /** write/edit 落盘声明（builtin.ts commitFileWrite 单点调钩）：白名单命中才记,kind=file */
  record(relPosix: string, source: 'write' | 'edit'): void {
    if (!isDeliverablePath(relPosix)) return;
    this.pending.push({ kind: 'file', path: relPosix, source });
  }

  /** report_artifacts 模型显式声明（任意 kind,不限白名单）：入列即原样登记（source 归 'tool',
   *  调用面已校验 file 存在性/url 形态） */
  declare(entries: Artifact[]): void {
    for (const e of entries) this.pending.push({ ...e, source: 'tool' } as Artifact);
  }

  /** tool-result 回执回标（serve/session.ts 泵 tagCall 邻位）：挂该文件路径末尾未回标的
   *  file 类条目——多刀写同路径时末尾未标=本次调用产物；回标路径反斜杠归一比对 */
  tagCall(relPosix: string, callId: string): void {
    const want = relPosix.replaceAll('\\', '/');
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const e = this.pending[i]!;
      if (e.kind === 'file' && e.path === want && e.callId === undefined) {
        e.callId = callId;
        return;
      }
    }
  }

  /** run 收口：按 artifactKey 去重,**tool 声明遮蔽同键推导条**(模型意图优先),同类保末次;
   *  输出序=声明条在先(声明序)→推导条(原序),并清空清单。帽在 mergeRunArtifacts 统一收口 */
  drain(): Artifact[] {
    if (this.pending.length === 0) return [];
    const declared: Artifact[] = [];
    const declaredKeys = new Set<string>();
    const derivedBykey = new Map<string, Artifact>();
    const derivedOrder: string[] = [];
    for (const a of this.pending) {
      const key = artifactKey(a);
      if (a.source === 'tool') {
        if (!declaredKeys.has(key)) declaredKeys.add(key);
        const at = declared.findIndex((d) => artifactKey(d) === key);
        if (at >= 0) declared[at] = a;
        else declared.push(a);
        continue;
      }
      if (derivedBykey.has(key)) {
        derivedBykey.set(key, a);
      } else {
        derivedBykey.set(key, a);
        derivedOrder.push(key);
      }
    }
    this.pending = [];
    const derived = derivedOrder.filter((k) => !declaredKeys.has(k)).map((k) => derivedBykey.get(k)!);
    return [...declared, ...derived];
  }
}

/** 供类型引用的来源窄化（builtin executor 校验后构造声明条用） */
type DeclaredArtifactInput = {
  kind: 'file' | 'url' | 'command';
  path?: string;
  url?: string;
  command?: string;
  title?: string;
  desc?: string;
};

/** 声明条构造（executor 校验通过后调）：kind 判别装配 + source 钉 'tool'；
 *  title/desc 清洗（trim+非空过滤+长度帽 120/200）在此单点，调用方传原始值即可 */
export function buildDeclaredArtifact(input: DeclaredArtifactInput): Artifact {
  const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim().slice(0, 120) : undefined;
  const desc = typeof input.desc === 'string' && input.desc.trim() !== '' ? input.desc.trim().slice(0, 200) : undefined;
  const meta = { ...(title !== undefined ? { title } : {}), ...(desc !== undefined ? { desc } : {}) };
  if (input.kind === 'file') return { kind: 'file', path: input.path!, source: 'tool', ...meta };
  if (input.kind === 'url') return { kind: 'url', url: input.url!, source: 'tool', ...meta };
  return { kind: 'command', command: input.command!, source: 'tool', ...meta };
}
