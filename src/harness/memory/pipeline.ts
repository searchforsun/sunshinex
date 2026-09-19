import * as path from 'path';
import type { ModelAdapter } from '../../model/adapter';
import { isModelSummarizer } from '../context/summarizer';
import { resolveMemoryConfig } from '../../config/memory-config';
import { resolveDataDir } from '../../config/data-dir';
import { MemoryStore } from './store';
import { settleMemory } from './extractor';
import { LearnedSkillStore } from '../skills/learned';
import { extractLearnedSkill } from '../skills/learned-extract';

export type PipelineOutcome = 'done' | 'failed' | 'stopped';

export interface PipelineItem {
  kind: 'learned' | 'memory';
  goal: string;
  reply: string;
  outcome: PipelineOutcome;
  digest: string;
}

export type PipelineNotice = (source: 'memory' | 'skills', line: string) => void;

/**
 * 后台沉淀管线（规格 §3.1）：收口零等待入队 → 单 worker FIFO 串行消费。
 * 兜底定位（D5）：模型运行中自主写入（memory_write）为主通道，本管线覆盖「模型没写/写入被拒」的任务；
 * 双写由 store 三级归一去重收敛，宁少勿滥。异常一律吞掉（旁路纪律）。
 */
export class MemoryPipeline {
  private queue: PipelineItem[] = [];
  /** 单 worker 门闩：非空即有且仅有一个在飞的消费循环（drain 期间再入队只排队不并发） */
  private worker: Promise<void> | undefined;

  constructor(private readonly deps: { model: ModelAdapter; root: string; notify: PipelineNotice }) {}

  /** 待办计数：排队项 + 在飞 worker（1 项）——入队即生效，drain 返回即归零 */
  pending(): number {
    return this.queue.length + (this.worker !== undefined ? 1 : 0);
  }

  /** 零等待：无真实模型走同步确定性路径并返回说明行；有模型只入队 */
  enqueue(item: PipelineItem): string | undefined {
    if (!isModelSummarizer(this.deps.model)) return this.runDeterministic(item);
    this.queue.push(item);
    void this.drain();
    return undefined;
  }

  /** 空闲踢点：队列非空才消费（无待办零调用零配额） */
  kick(): void {
    if (this.queue.length > 0) void this.drain();
  }

  /**
   * 消费至队列清空。并发/重入调用共享同一个在飞 worker（绝不并发第二模型调用）；
   * 返回语义提升为「队列已清空」——CLI 收尾 `await drain()` 依赖此语义（在飞后台消费也要等到，
   * 否则退出前 drain 会被在飞 worker 短路而漏沉淀）。
   */
  async drain(): Promise<void> {
    while (this.worker !== undefined || this.queue.length > 0) {
      if (this.worker === undefined) this.worker = this.runWorker();
      const running = this.worker;
      try {
        await running;
      } catch {
        // 旁路纪律：runWorker/consume 内部已吞异常，此处兜底防死锁（worker 清位不因异常中断）
      }
      if (this.worker === running) this.worker = undefined;
    }
  }

  /** 单 worker 消费循环：FIFO 串行，逐项吞异常（任务收口永不因沉淀失败而失败） */
  private async runWorker(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      await this.consume(item);
    }
  }

  private async consume(item: PipelineItem): Promise<void> {
    if (item.kind === 'learned') await this.consumeLearned(item);
    else await this.consumeMemory(item);
  }

  /** 无真实模型：与今日行为一致——done 走确定性 learned 写盘并返回说明行；failed/stopped 与记忆提取跳过 */
  private runDeterministic(item: PipelineItem): string | undefined {
    if (item.kind !== 'learned') return undefined;
    if (item.outcome !== 'done' || !item.reply) return undefined;
    const cfg = resolveMemoryConfig();
    if (!cfg.learnedSkills) return undefined;
    const r = new LearnedSkillStore(this.deps.root).settle(item.goal, item.reply, { limit: cfg.learnedSkillLimit });
    return r.ok ? `[skills] learned: ${r.value}` : undefined;
  }

  private async consumeLearned(item: PipelineItem): Promise<void> {
    const cfg = resolveMemoryConfig();
    if (!cfg.learnedSkills) return;
    try {
      const ex = await extractLearnedSkill(this.deps.model, {
        goal: item.goal,
        reply: item.reply,
        outcome: item.outcome,
        digest: item.digest,
      });
      const store = new LearnedSkillStore(this.deps.root);
      if (ex && ex.skill) {
        const r = store.settle(item.goal, item.reply, { limit: cfg.learnedSkillLimit, refined: ex.skill });
        if (r.ok) this.deps.notify('skills', `[skills] learned: ${r.value}`);
        return;
      }
      if (ex === null && item.outcome === 'done' && item.reply) {
        // 技术失败回退确定性写盘：沉淀永不因技术故障丢失
        const r = store.settle(item.goal, item.reply, { limit: cfg.learnedSkillLimit });
        if (r.ok) this.deps.notify('skills', `[skills] learned: ${r.value}`);
      }
      // ex.skill === null：模型判无可复用教训 → 零落盘（宁少勿滥）
    } catch {
      // 旁路纪律
    }
  }

  private async consumeMemory(item: PipelineItem): Promise<void> {
    if (!resolveMemoryConfig().autoMemory) return;
    try {
      const slugs = await settleMemory({ goal: item.goal, reply: item.reply, model: this.deps.model, root: this.deps.root });
      if (slugs.length > 0) this.deps.notify('memory', this.memoryLine(slugs));
    } catch {
      // 旁路纪律
    }
  }

  /** 说明行文案与 harness 既有口径逐字对齐（src/harness/index.ts settleMemory 链行），并附近限提醒（规格 §3.4/§6） */
  private memoryLine(slugs: string[]): string {
    const base = `[memory] saved: ${slugs.join(', ')} — recall via read ${path.join(resolveDataDir(this.deps.root), 'memory', 'MEMORY.md')}`;
    const near = new MemoryStore(this.deps.root).capacityNotice();
    return near ? `${base}\n${near}` : base;
  }
}
