import { artifactKey, type Artifact } from '../../types';

/** 轮次产物收集器（2026-11-12 spec §3.3;2026-11-14 kind 化;2026-11-20 收敛：唯一写入口）。
 *  2026-11-20 用户裁定「完全去掉自己去解析,交给 agent 自己判断哪些是产物」：write/edit 落盘钩、
 *  轮末 git 差集、mtime 扫描三条自动网全部退役——产物面唯一来源=report_artifacts 模型显式声明
 *  （任意 kind，title/desc 随行），收集器只承接 declare()，run 收口 drain 去重。 */
export class ArtifactCollector {
  private pending: Artifact[] = [];

  /** report_artifacts 模型显式声明（任意 kind,不限白名单）：入列即原样登记（source 归 'tool',
   *  调用面已校验 file 存在性/url 形态） */
  declare(entries: Artifact[]): void {
    for (const e of entries) this.pending.push({ ...e, source: 'tool' } as Artifact);
  }

  /** run 收口：声明条按 artifactKey 去重保末次（模型意图优先）；2026-11-20 起已无自动网，
   *  本收集器只承接 report_artifacts 声明，清空清单。帽在 mergeRunArtifacts 统一收口 */
  drain(): Artifact[] {
    if (this.pending.length === 0) return [];
    const byKey = new Map<string, Artifact>();
    for (const a of this.pending) byKey.set(artifactKey(a), a);
    this.pending = [];
    return [...byKey.values()];
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
