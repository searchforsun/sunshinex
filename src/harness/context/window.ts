import * as crypto from 'crypto';
import { ContextItem } from '../../types';

/** checksum 校验三态结论：first=首次注册基线；replay=幂等重放；new=检测到新一轮压缩 */
export type ChecksumVerdict = 'first' | 'replay' | 'new';

/** 真实 token 近似：CJK（中文/全角区）×1 + 其余 ÷4（spec §2.1，零依赖近似口径） */
export function estimateTokens(content: string): number {
  const cjk = (content.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  return cjk + Math.ceil((content.length - cjk) / 4);
}

export interface ContextBudget {
  total: number;
  used: number;
  reserve: number;
}

export interface ContextItemEstimate {
  id: string;
}

export interface ContextChunk {
  id: string;
  summary: string;
  type: string;
  priority: number;
}

/** 权重表：estimate 已退役权重语义，现供 compact 丢弃序使用（T2 起消费） */
export const KIND_WEIGHT: Record<ContextItem['kind'], number> = {
  system: 1.0,
  instruction: 1.2,
  memory: 0.8,
  history: 0.5,
  tool: 0.7,
  result: 0.6,
};

/** 上下文窗口：加权 token 估算 + 分块 compaction + checksum 重注入（Claude Code 稳定性增强） */
export class ContextWindow {
  private lastChecksum: string | null = null;

  /** 估算：used = Σ estimateTokens(content)（真实 token 近似，无 kind 权重；权重语义退役为 compact 丢弃优先级） */
  estimate(items: ContextItem[]): { used: number; items: ContextItemEstimate[] } {
    const out: ContextItemEstimate[] = [];
    let used = 0;
    for (const it of items) {
      used += estimateTokens(it.content);
      out.push({ id: this.chunkId(it.content) });
    }
    return { used, items: out };
  }

  shouldCompact(b: ContextBudget): boolean {
    return b.used > b.total - b.reserve;
  }

  /** 摘要预算化压缩（spec §2.3）：超限时按丢弃序丢块（priority 升序 → kind 权重升序 → 位置最旧先；system/instruction 白名单不可丢），
   *  丢尽可丢块仍超限 → 确定性均匀截断（二分最大统一保留长度 L，保 checksum 确定性）。未传 summaryTokenBudget 保持既有行为。 */
  async compact(items: ContextItem[], opts?: { force?: boolean; summaryTokenBudget?: number }): Promise<ContextChunk[]> {
    const chunks = this.chunkByMarkdown(items);
    const merged = this.mergeChunks(chunks);
    const kept = merged.filter((c) => c.priority > 0);
    const budget = opts?.summaryTokenBudget;
    if (budget === undefined) return kept;
    const tokensOf = (cs: ContextChunk[]) => cs.reduce((s, c) => s + estimateTokens(c.summary), 0);
    if (tokensOf(kept) <= budget) return kept;
    const order = kept
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.type !== 'system' && c.type !== 'instruction')
      .sort(
        (a, b) =>
          a.c.priority - b.c.priority ||
          (KIND_WEIGHT[a.c.type as ContextItem['kind']] ?? 0.5) - (KIND_WEIGHT[b.c.type as ContextItem['kind']] ?? 0.5) ||
          a.i - b.i,
      );
    const dropped = new Set<ContextChunk>();
    let out = kept;
    for (const { c } of order) {
      if (tokensOf(out) <= budget) break;
      dropped.add(c);
      out = out.filter((x) => x !== c);
    }
    if (tokensOf(out) > budget) {
      const maxLen = Math.max(...out.map((c) => c.summary.length));
      let lo = 0;
      let hi = maxLen;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const t = out.reduce((s, c) => s + estimateTokens(c.summary.slice(0, mid)), 0);
        if (t <= budget) lo = mid;
        else hi = mid - 1;
      }
      out = out.map((c) => ({ ...c, summary: c.summary.slice(0, lo) }));
    }
    return out;
  }

  /** checksum 门禁（三态）：first=注册基线；replay=同一压缩事件幂等重放；new=新一轮压缩并更新基线 */
  verifyChecksum(chunks: ContextChunk[]): ChecksumVerdict {
    const hash = crypto.createHash('sha256').update(JSON.stringify(chunks)).digest('hex');
    if (this.lastChecksum === null) {
      this.lastChecksum = hash;
      return 'first';
    }
    if (this.lastChecksum === hash) return 'replay';
    this.lastChecksum = hash;
    return 'new';
  }

  /** 当前基线 checksum 前 16 位；未注册时为 null（供压缩事件记忆对账） */
  checksum(): string | null {
    return this.lastChecksum === null ? null : this.lastChecksum.slice(0, 16);
  }

  /** 压缩摘要条目（纯计算）：kept chunks 摘要拼接 + checksum 标记 */
  summarize(chunks: ContextChunk[]): ContextItem {
    const hash = crypto.createHash('sha256').update(JSON.stringify(chunks)).digest('hex').slice(0, 16);
    const text = chunks.map((c) => `- [${c.type}] ${c.summary}`).join('\n');
    return { kind: 'history', content: `[压缩摘要 checksum=${hash}]\n${text}` };
  }

  /** reinject 落地：由压缩 chunks 产出重注入条目（摘要；最近文件重读由 ContextManager 协调后追加） */
  reinject(chunks: ContextChunk[]): ContextItem[] {
    return [this.summarize(chunks)];
  }

  private chunkId(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /** 按 ## / ### / --- / > 边界切分 */
  private chunkByMarkdown(items: ContextItem[]): ContextChunk[] {
    const out: ContextChunk[] = [];
    for (const it of items) {
      const lines = it.content.split(/\r?\n/);
      let cur = '';
      const flush = () => {
        if (cur.trim().length === 0) return;
        out.push({ id: this.chunkId(cur), summary: cur.trim().slice(0, 2000), type: it.kind, priority: this.priority(cur) });
        cur = '';
      };
      for (const l of lines) {
        if (/^(#{2,3}\s|---|>)/.test(l)) { flush(); cur = l; }
        else cur += (cur ? '\n' : '') + l;
      }
      flush();
    }
    return out;
  }

  /** priority：极短/高度重复内容判为 0，其余为 1 */
  private priority(content: string): number {
    if (content.trim().length < 4) return 0;
    const words = content.trim().split(/\s+/);
    if (words.length >= 4 && new Set(words).size <= 2) return 0; // 冗余重复
    return 1;
  }

  /** 去重合并：相同 id 或 Jaccard > 0.9 合并 */
  private mergeChunks(chunks: ContextChunk[]): ContextChunk[] {
    const out: ContextChunk[] = [];
    for (const c of chunks) {
      const dup = out.find((o) => o.id === c.id || this.jaccard(o.summary, c.summary) > 0.9);
      if (dup) {
        if (c.summary.length > dup.summary.length) dup.summary = c.summary;
        dup.priority = Math.max(dup.priority, c.priority);
      } else {
        out.push({ ...c });
      }
    }
    return out;
  }

  private jaccard(a: string, b: string): number {
    const sa = new Set(a.split(/\s+/).filter(Boolean));
    const sb = new Set(b.split(/\s+/).filter(Boolean));
    if (sa.size === 0 || sb.size === 0) return 0;
    let inter = 0;
    for (const w of sa) if (sb.has(w)) inter++;
    return inter / (sa.size + sb.size - inter);
  }
}
