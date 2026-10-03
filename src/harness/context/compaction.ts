import * as path from 'path';
import * as crypto from 'crypto';
import { ContextItem, HistoryStep } from '../../types';
import { resolveDataDir } from '../../config/data-dir';
import { ArchiveStore, createFsArchiveStore } from '../../storage/archive';
import { ContextChunk, ContextWindow, estimateTokens } from './window';
import { maskText } from '../security/chain';
import { isModelSummarizer, summarizeWithModel } from './summarizer';
import type { ModelAdapter } from '../../model/adapter';

const REREAD_MAX_LINES = 500;

/** 压缩重注入 opts（门面 applyCompaction 与协调器 apply 共用，字段与原内联签名逐一相同） */
export interface ApplyCompactionOpts {
  rereadTokenBudget?: number;
  summaryModel?: ModelAdapter;
  summaryTokenBudget?: number;
  traceLine?: string;
  focus?: string;
}

/** 压缩协调注入面（D25/H3 拆分自 ContextManager 职责④）：window/根路径与门面回调经构造注入，协调器不反向 import 门面——
 *  compact 事件所需的 chainFrom（链账本水位）与 compacted 的消费方（会话日志订阅）均以回调形式由门面接线，件间零引用。 */
interface CompactionCoordinatorDeps {
  /** 上下文窗口（checksum 门禁与重注入拼装；lastChecksum 基线随协调器推进——replay 判定的状态本体） */
  window: ContextWindow;
  /** 项目根（重读文件路径解析） */
  root: string;
  /** 最近读取文件快照（LRU 归门面；按登记顺序即最旧在前重读） */
  recentFiles(): string[];
  /** SUNSHINE.md「Compact Instructions」区缓存（E 项，归门面；随刷新点重提取）——摘要指令并源 */
  compactInstructions(): string | null;
  /** 压缩水位只读（compact 事件载荷；链账本归 ChainLedger，门面接线） */
  chainFrom(): number;
  /** 压缩事件回投（门面组合 ContextChange 后分发会话日志，单一事实源挂钩） */
  onCompact(chainFrom: number, compacted: ContextItem[]): void;
  /** 归档/重读 IO 接缝（D26/J10 IO 收敛）：门面构造恒注入（缺省 fs 实现或 spy 版）；可选形态保既有
   *  直接构造面（单测 rig 六依赖零 archive）不破——未注入且真实触达 IO 时协调器惰性缺省同款 fs 实现 */
  archive?: ArchiveStore;
}

/** 压缩协调器（D25/H3 收编 ContextManager 职责④ + ⑨）：压缩块状态（compacted）、压缩事件计数（compactions）
 *  与重注入协调（checksum 门禁 → 摘要分叉 → 重读 → 预算循环）的单一持有者；模块级 runCompaction（归档与
 *  重读 IO 一律经 archive 接缝，D26/J10）同住本文件。 */
export class CompactionCoordinator {
  /** 压缩块（compacted）：apply 落地、assemble/restoreSession 经门面只读消费 */
  private compactedItems: ContextItem[] = [];
  /** 压缩事件计数：first 记 1、new 递增；replay（同一压缩事件幂等重放）不计数 */
  private compactions = 0;
  /** 直接构造未注入 archive 时的惰性缺省（记忆化；门面路径恒注入，不触达本字段） */
  private defaultArchive?: ArchiveStore;

  constructor(private readonly deps: CompactionCoordinatorDeps) {}

  /** 归档接缝解析：deps.archive 优先；未注入时按项目根解析数据目录惰性建 fs 实现并记忆化 */
  private archiveStore(): ArchiveStore {
    return this.deps.archive ?? (this.defaultArchive ??= createFsArchiveStore(resolveDataDir(this.deps.root)));
  }

  /** 压缩重注入：checksum 门禁 → 摘要（模型六要素优先，未传/门禁关闭/失败回退确定性 join）→ 重读最近文件 → 注入块。
   *  返回摘要来源三态：model=模型正文生效；deterministic=确定性回退；replay=同一压缩事件幂等重放（不注入、不计数、不发起模型调用）。 */
  async apply(chunks: ContextChunk[], opts?: ApplyCompactionOpts): Promise<'model' | 'deterministic' | 'replay'> {
    const verdict = this.deps.window.verifyChecksum(chunks);
    if (verdict === 'replay') return 'replay'; // 同一压缩事件幂等重放（规格 §8：不发起模型调用）
    this.compactions++; // first=首个压缩事件（计 1）、new=新一轮压缩；replay 不计数
    let summaryBody: string | undefined;
    if (opts?.summaryModel && isModelSummarizer(opts.summaryModel)) {
      // E 项：SUNSHINE.md「Compact Instructions」区体并入摘要指令（focus 措辞标注「优先覆盖」、优先级更高）
      const mergedFocus = [this.deps.compactInstructions() ?? undefined, opts.focus]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .join('\n');
      const body = await summarizeWithModel(opts.summaryModel, chunks, opts.summaryTokenBudget ?? 2000, mergedFocus || undefined);
      if (body !== null) summaryBody = body;
    }
    const items: ContextItem[] = [...this.deps.window.reinject(chunks, summaryBody, opts?.traceLine)];
    for (const rel of this.deps.recentFiles()) {
      try {
        const abs = path.resolve(this.deps.root, rel);
        const lines = this.archiveStore().read(abs).split(/\r?\n/).slice(0, REREAD_MAX_LINES);
        // 重读是文件内容直入上下文的旁路，必须过与工具结果相同的凭据脱敏模式集（B3）
        items.push({ kind: 'memory', content: maskText(`[re-read] ${rel}:\n${lines.join('\n')}`) });
      } catch {
        // 文件已删除或不可读：跳过该文件
      }
    }
    // 重读预算化（spec §2.4）：预算仅管辖重读条目；登记顺序即最旧在前，队首（最旧）整文件先丢
    const budget = opts?.rereadTokenBudget;
    if (budget !== undefined) {
      const tokens = (cs: ContextItem[]) => cs.reduce((s, i) => s + estimateTokens(i.content), 0);
      const rereads = items.slice(1);
      while (rereads.length > 0 && tokens(rereads) > budget) rereads.shift();
      items.length = 1;
      items.push(...rereads);
    }
    this.compactedItems = items;
    this.deps.onCompact(this.deps.chainFrom(), this.compactedItems);
    return summaryBody !== undefined ? 'model' : 'deterministic';
  }

  /** 压缩块观测（只读，门面 compactedView 转发）：apply 落地的重注入条目（内部引用直读，调用方禁改写） */
  compactedView(): ContextItem[] {
    return this.compactedItems;
  }

  /** 压缩块观测（只读）：当前压缩块代表的条目数（reactor 压缩事件计数口径） */
  compactedUpToCount(): number {
    return this.compactedItems.length;
  }

  /** 压缩事件计数（只读观测）：首个压缩事件记 1、新一轮压缩递增；同一压缩事件幂等重放（replay）不计数 */
  compactionCount(): number {
    return this.compactions;
  }

  /** 会话恢复直注入（/resume / --continue）：压缩块整体浅拷贝替换，不触发事件、不计数（重放期间日志是读方） */
  restoreCompacted(items: ContextItem[]): void {
    this.compactedItems = items.map((i) => ({ ...i }));
  }

  /** 压缩块清空（/new）；压缩事件计数跨会话保留——口径与原 resetSession 逐字一致 */
  clearCompacted(): void {
    this.compactedItems = [];
  }
}

export interface RunCompactionResult {
  chunks: ContextChunk[];
  /** 摘要来源三态（透传 applyCompaction）：model / deterministic / replay */
  via: 'model' | 'deterministic' | 'replay';
}

/** runCompaction 宿主注入面（结构化契约）：ContextManager 结构满足此面——压缩协调不反向 import 门面实现，
 *  reactor 自动压缩与 TUI /compact 两入口经门面实例传入（消费方零改动）。 */
export interface CompactionHost {
  /** 项目根（归档落点推算） */
  readonly root: string;
  /** 上下文窗口（确定性选块） */
  readonly window: ContextWindow;
  /** 归档存储（D26/J10 IO 收敛）：折链全量归档写经此接缝（门面构造注入或缺省 fs 实现） */
  readonly archive: ArchiveStore;
  chainView(): HistoryStep[];
  foldableItems(assembled: ContextItem[]): ContextItem[];
  applyCompaction(chunks: ContextChunk[], opts?: ApplyCompactionOpts): Promise<'model' | 'deterministic' | 'replay'>;
  reloadContext(): void;
  trimChainFront(n: number): void;
}

/** 压缩协调单点（规格 §4.2/D5，原 index.ts 模块级函数原样收编）：确定性选块 → 摘要分叉（模型优先，失败回退）→ 门禁重注入 → 折叠链前缀。
 *  reactor 自动压缩与 TUI /compact 两入口只传参不各自拼装（防拼装漂移，memory 双写教训）；
 *  replay 幂等重放不折链（防重复推进水位）。
 *  归档 IO 经 CompactionHost.archive 接缝（D26/J10，落点 <dataDir>/archives/、命名与内容逐字节不变，
 *  IO 本体收敛于 storage 层）：先行且仅在将真实折链时写，写失败降级无指针行，压缩永不因归档失败而失败。 */
export async function runCompaction(
  cm: CompactionHost,
  items: ContextItem[],
  opts: { summaryTokenBudget: number; rereadTokenBudget: number; chainFoldedCount?: number; summaryModel?: ModelAdapter; focus?: string },
): Promise<RunCompactionResult> {
  let traceLine: string | undefined;
  const folded = opts.chainFoldedCount ?? 0;
  if (folded > 0 && cm.chainView().length > 0) {
    try {
      const rows = cm.chainView().slice(0, Math.min(folded, cm.chainView().length));
      const digest = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 8);
      const file = cm.archive.write(`compaction-${rows.length}-${digest}.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      traceLine = `Full trace: ${file}`;
    } catch {
      traceLine = undefined; // 归档失败降级：无指针行，压缩照常
    }
  }
  const chunks = await cm.window.compact(cm.foldableItems(items), { summaryTokenBudget: opts.summaryTokenBudget });
  const via = await cm.applyCompaction(chunks, {
    rereadTokenBudget: opts.rereadTokenBudget,
    summaryTokenBudget: opts.summaryTokenBudget,
    ...(opts.summaryModel ? { summaryModel: opts.summaryModel } : {}),
    ...(traceLine !== undefined ? { traceLine } : {}),
    ...(opts.focus !== undefined ? { focus: opts.focus } : {}),
  });
  if (via !== 'replay') {
    // 压缩成功（非 replay）刷新项目上下文快照（G 项刷新点，对标 CC 压缩点重载；
    // replay 幂等重放不刷新，重放零击穿语义保持）
    cm.reloadContext();
  }
  if (via !== 'replay' && opts.chainFoldedCount !== undefined && opts.chainFoldedCount > 0) {
    cm.trimChainFront(opts.chainFoldedCount);
  }
  return { chunks, via };
}
