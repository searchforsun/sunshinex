import type { ModelAdapter } from '../../model/adapter';
import { isModelSummarizer } from '../context/summarizer';
import { resolveMemoryConfig } from '../../config/memory-config';
import { MemoryStore } from './store';
import { settleMemory } from './extractor';
import { LearnedSkillStore } from '../skills/learned';
import { extractLearnedSkill, validSkillName } from '../skills/learned-extract';
import { slugify as slugifyPreview } from '../skills/learned';

type PipelineOutcome = 'done' | 'failed' | 'stopped';

interface PipelineItem {
  kind: 'learned' | 'memory';
  goal: string;
  reply: string;
  outcome: PipelineOutcome;
  digest: string;
}

type PipelineNotice = (source: 'memory' | 'skills', line: string) => void;

interface MemoryPipelineDeps {
  model: ModelAdapter;
  root: string;
  notify: PipelineNotice;
  /** 记忆开关判门（会话级 /memory on|off 覆盖优先于控制面）：逐项消费时求值，不在构造期冻结；缺省读控制面 */
  memoryEnabled?: () => boolean;
  /** 技能沉淀开关判门（--learn/装配期覆盖优先于控制面）：同上，逐项求值 */
  learnedEnabled?: () => boolean;
}

/**
 * 后台沉淀管线（规格 §3.1）：收口零等待入队 → 单 worker FIFO 串行消费。
 * 兜底定位（D5）：模型运行中自主写入（memory_write）为主通道，本管线覆盖「模型没写/写入被拒」的任务；
 * 双写由 store 三级归一去重收敛，宁少勿滥。异常一律吞掉（旁路纪律）。
 */
export class MemoryPipeline {
  private queue: PipelineItem[] = [];
  /** 单 worker 门闩：非空即有且仅有一个在飞的消费循环（drain 期间再入队只排队不并发） */
  private worker: Promise<void> | undefined;

  constructor(private readonly deps: MemoryPipelineDeps) {}

  private memoryEnabled(): boolean {
    return this.deps.memoryEnabled?.() ?? resolveMemoryConfig().autoMemory;
  }

  private learnedEnabled(): boolean {
    return this.deps.learnedEnabled?.() ?? resolveMemoryConfig().learnedSkills;
  }

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

  /** G14.81 近轮环（旧→新，容量 6）：跨轮合成上下文 */
  private recentSettles: Array<{ goal: string; outcome: string }> = [];

  /** 无真实模型：与今日行为一致——done 走确定性 learned 写盘并返回说明行；failed/stopped 与记忆提取跳过。
   *  G14.81 门控：仅收 goal 含 ASCII 的输入——非 ASCII goal 会 slug 塌缩成 learned-N 噪声目录（用户裁定不产） */
  private runDeterministic(item: PipelineItem): string | undefined {
    if (item.kind !== 'learned') return undefined;
    if (item.outcome !== 'done' || !item.reply) return undefined;
    const cfg = resolveMemoryConfig();
    if (!this.learnedEnabled()) return undefined;
    // G14.92 名字质量门:确定性路径同样不产噪声——slug 须含字母且 >=3 字符('34'/'rm' 类纯数字/单词命令挡外;
    // 非 ASCII goal 塌缩 'learned' 同挡)。无模型判价值,宁缺勿滥
    const slug = slugifyPreview(item.goal);
    if (!validSkillName(slug)) {
      this.recentSettlesPush(item.goal, item.outcome);
      return undefined;
    }
    this.recentSettlesPush(item.goal, item.outcome);
    const r = new LearnedSkillStore(this.deps.root).settle(item.goal, item.reply, { limit: cfg.learnedSkillLimit });
    // 撞名沉淀=原地更新（2026-10-15 用户裁决）：updated 时文案归 updated，不再产 -N 副本
    return r.ok ? `[skills] ${r.value.updated ? 'updated' : 'learned'}: ${r.value.id}` : undefined;
  }

  private recentSettlesPush(goal: string, outcome: string): void {
    this.recentSettles.push({ goal, outcome });
    if (this.recentSettles.length > 6) this.recentSettles.shift();
  }

  private async consumeLearned(item: PipelineItem): Promise<void> {
    const cfg = resolveMemoryConfig();
    if (!this.learnedEnabled()) return;
    const store = new LearnedSkillStore(this.deps.root);
    const recent = this.recentSettles.slice(-6); // 当前轮入环前取——跨轮合成上下文
    this.recentSettlesPush(item.goal, item.outcome);
    try {
      // G14.92 证据密度门（先于模型调用）：工具步 <3 的任务几乎必为单命令/问答/增删单文件类琐碎操作
      // （本轮实测噪声源），直接跳过提炼——跨轮合成不受影响（recent 环照常入环，模型可跨轮合并）
      const stepLines = item.digest.split('\n').filter((l) => l.trim().length > 0).length;
      if (stepLines < 3) return;
      // 三态裁决（重试环在 extractLearnedSkill 内——三次皆败 skip 丢弃，无回退写盘：
      // 回退产物 learned:34/rm 类噪声正是污染源，宁缺勿滥）
      const verdict = await extractLearnedSkill(this.deps.model, {
        goal: item.goal,
        reply: item.reply,
        outcome: item.outcome,
        digest: item.digest,
        recent,
        existing: store.names(),
      });
      if (verdict.action === 'skip' || verdict.skill === undefined) return;
      if (verdict.action === 'update') {
        // 原地更新:相近主题合并进既有技能(容量守恒,不新增目录);目标已删降级 create
        const u = store.updateExisting(verdict.id ?? '', verdict.skill);
        if (u.ok) {
          this.deps.notify('skills', `[skills] updated: ${u.value}`);
          return;
        }
      }
      // create 裁决撞名时 settle 原地覆盖（2026-10-15 用户裁决「禁止 -1/-2 后缀」），文案随 updated 归位
      const r = store.settle(item.goal, item.reply, { limit: cfg.learnedSkillLimit, refined: verdict.skill });
      if (r.ok) this.deps.notify('skills', `[skills] ${r.value.updated ? 'updated' : 'learned'}: ${r.value.id}`);
    } catch {
      // 旁路纪律
    }
  }

  private async consumeMemory(item: PipelineItem): Promise<void> {
    if (!this.memoryEnabled()) return;
    try {
      // digest 随材料面进提取（feedback 类事实主要在会话过程，不在最终答复）；notify 承接整理未应用说明行
      const slugs = await settleMemory({
        goal: item.goal,
        reply: item.reply,
        digest: item.digest,
        model: this.deps.model,
        root: this.deps.root,
        notify: (line) => this.deps.notify('memory', line),
      });
      if (slugs.length > 0) this.deps.notify('memory', this.memoryLine(slugs));
    } catch {
      // 旁路纪律
    }
  }

  /** 说明行文案（G14.106 GUI 可见面去路径引用——recall 指针只留在 TUI/链行侧,径经链接化会
   *  在正文拖出长蓝链）；近限提醒（规格 §3.4）以 ` — ` 并入同一行——单行契约不拆 */
  private memoryLine(slugs: string[]): string {
    const base = `[memory] saved: ${slugs.join(', ')}`;
    const near = new MemoryStore(this.deps.root).capacityNotice();
    return near ? `${base} — ${near}` : base;
  }
}
