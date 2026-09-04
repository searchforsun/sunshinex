import * as crypto from 'crypto';
import { ContextItem } from '../../types';

export interface ContextBudget {
  total: number;
  used: number;
  reserve: number;
}

export interface ContextItemEstimate {
  id: string;
  weight: number;
}

export interface ContextChunk {
  id: string;
  summary: string;
  type: string;
  priority: number;
}

const KIND_WEIGHT: Record<ContextItem['kind'], number> = {
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
  private lastChunks: ContextChunk[] = [];

  /** 加权估算：used = Σ ceil(content.length * weight / 4)；逐项返回 chunk id */
  estimate(items: ContextItem[]): { used: number; items: ContextItemEstimate[] } {
    const out: ContextItemEstimate[] = [];
    let used = 0;
    for (const it of items) {
      const weight = KIND_WEIGHT[it.kind] ?? 0.5;
      used += Math.ceil((it.content.length * weight) / 4);
      out.push({ id: this.chunkId(it.content), weight });
    }
    return { used, items: out };
  }

  shouldCompact(b: ContextBudget): boolean {
    return b.used > b.total - b.reserve;
  }

  async compact(items: ContextItem[], _opts?: { force?: boolean }): Promise<ContextChunk[]> {
    const chunks = this.chunkByMarkdown(items);
    const merged = this.mergeChunks(chunks);
    const kept = merged.filter((c) => c.priority > 0);
    this.lastChunks = kept;
    return kept;
  }

  verifyChecksum(chunks: ContextChunk[]): boolean {
    const hash = crypto.createHash('sha256').update(JSON.stringify(chunks)).digest('hex');
    if (this.lastChecksum === hash) return true;
    this.lastChecksum = hash;
    return false;
  }

  reinject(): ContextItem[] {
    // 阶段一：system prompt 不重注入（hardcode）；
    // SUNSHINE.md / MEMORY.md / 最近 5 文件的重读由 ContextManager 协调，
    // 本方法返回压缩摘要作为新 history（摘要本身由 ContextManager 注入）。
    return [];
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
