import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { StorageAdapter } from '../../storage/adapter';
import { ContextItem, HistoryStep } from '../../types';
import { resolveDataDir } from '../../config/data-dir';
import { ContextLoader, extractCompactInstructions } from './loader';
import { RulesRegistry } from './rules';
import { ContextWindow, ContextChunk, estimateTokens } from './window';
import { SessionStore } from './session';
import { maskText } from '../security/chain';
import { isModelSummarizer, summarizeWithModel } from './summarizer';
import type { ModelAdapter } from '../../model/adapter';

const RECENT_LIMIT = 5;
const REREAD_MAX_LINES = 500;

/** 上下文与记忆管理门面 */
/** 会话链/压缩变更事件（会话日志订阅面，规格 2026-09-17-session-persistence-resume-design.md §5 单一事实源）：
 *  append=链尾追加（携带实际推入的行与绝对步号）；compact=压缩后状态快照——applyCompaction 与 trimChainFront 各发一条，
 *  重放按序覆盖取后态（配对压缩产生两条 compact 事件，最终状态精确）。 */
export type ContextChange =
  | { kind: 'append'; steps: HistoryStep[] }
  | { kind: 'compact'; chainFrom: number; compacted: ContextItem[] };

/** 会话状态完整快照（exportSessionState / restoreSession 载荷） */
export interface ContextSessionState {
  chain: HistoryStep[];
  chainFrom: number;
  compacted: ContextItem[];
}

export class ContextManager {
  readonly loader: ContextLoader;
  readonly rules: RulesRegistry;
  readonly window: ContextWindow;
  readonly session: SessionStore;

  private compacted: ContextItem[] = [];
  private recent: string[] = [];
  private pendingSkill: string | null = null;
  /** 会话链（CLAUDE.md §11 只增不改）：主链对话事实的 append-only 账本 */
  private chain: HistoryStep[] = [];
  /** 压缩水位：chain 前 chainFrom 条已被压缩块代表（trimChainFront 推进，不回退） */
  private chainFrom = 0;
  private chainSeq = 0;
  /** 压缩事件计数：first 记 1、new 递增；replay（同一压缩事件幂等重放）不计数 */
  private compactions = 0;
  /** SUNSHINE.md「Compact Instructions」区缓存（与装配快照同源；E 项）：压缩摘要生成时注入 prompt */
  private compactInstructions: string | null = null;
  /** 会话变更订阅（单槽，后注册覆盖；restoreSession 直注入不经过此口） */
  private changeSink?: (c: ContextChange) => void;

  constructor(private readonly rootPath: string, store: StorageAdapter) {
    this.loader = new ContextLoader(rootPath);
    this.rules = new RulesRegistry(rootPath);
    this.window = new ContextWindow();
    this.session = new SessionStore(store);
    // Compact Instructions 区提取（E 项）：装配同源读一次；无文件/无区为 null
    const sunshinePath = path.join(rootPath, 'SUNSHINE.md');
    try {
      this.compactInstructions = extractCompactInstructions(fs.readFileSync(sunshinePath, 'utf8'));
    } catch {
      this.compactInstructions = null;
    }
  }

  /** 项目根绝对路径（环境事实注入与路径消歧的单一来源） */
  get root(): string {
    return this.rootPath;
  }

  /** 最近读取文件登记：去重 + LRU 上限 5（供压缩后重读） */
  trackFile(relPath: string): void {
    const p = String(relPath ?? '').trim();
    if (!p) return;
    this.recent = this.recent.filter((f) => f !== p);
    this.recent.push(p);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
  }

  /** 最近读取文件快照（按登记顺序，最旧在前） */
  recentFiles(): string[] {
    return [...this.recent];
  }

  /** 压缩重注入：checksum 门禁 → 摘要（模型六要素优先，未传/门禁关闭/失败回退确定性 join）→ 重读最近文件 → 注入块。
   *  返回摘要来源三态：model=模型正文生效；deterministic=确定性回退；replay=同一压缩事件幂等重放（不注入、不计数、不发起模型调用）。 */
  async applyCompaction(
    chunks: ContextChunk[],
    opts?: { rereadTokenBudget?: number; summaryModel?: ModelAdapter; summaryTokenBudget?: number; traceLine?: string; focus?: string },
  ): Promise<'model' | 'deterministic' | 'replay'> {
    const verdict = this.window.verifyChecksum(chunks);
    if (verdict === 'replay') return 'replay'; // 同一压缩事件幂等重放（规格 §8：不发起模型调用）
    this.compactions++; // first=首个压缩事件（计 1）、new=新一轮压缩；replay 不计数
    let summaryBody: string | undefined;
    if (opts?.summaryModel && isModelSummarizer(opts.summaryModel)) {
      // E 项：SUNSHINE.md「Compact Instructions」区体并入摘要指令（focus 措辞标注「优先覆盖」、优先级更高）
      const mergedFocus = [this.compactInstructions ?? undefined, opts.focus]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .join('\n');
      const body = await summarizeWithModel(opts.summaryModel, chunks, opts.summaryTokenBudget ?? 2000, mergedFocus || undefined);
      if (body !== null) summaryBody = body;
    }
    const items: ContextItem[] = [...this.window.reinject(chunks, summaryBody, opts?.traceLine)];
    for (const rel of this.recent) {
      try {
        const abs = path.resolve(this.root, rel);
        const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/).slice(0, REREAD_MAX_LINES);
        // 重读是文件内容直入上下文的旁路，必须过与工具结果相同的凭据脱敏模式集（B3）
        items.push({ kind: 'memory', content: maskText(`[重读] ${rel}:\n${lines.join('\n')}`) });
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
    this.compacted = items;
    this.changeSink?.({ kind: 'compact', chainFrom: this.chainFrom, compacted: this.compacted });
    return summaryBody !== undefined ? 'model' : 'deterministic';
  }

  /** 技能首帧注入槽：set 后的下一次 assemble 尾追携带（kind=system），消费即清——技能正文不随后续帧重复 */
  setSkillBlock(content: string): void {
    this.pendingSkill = content;
  }

  /** 会话链只读视图：自压缩水位起的存续条目（reactor 缺省 seed 的单一来源） */
  /** 会话变更订阅（会话日志单一事实源挂钩，规格 §5）：appendChain/applyCompaction/trimChainFront 三类变更发出；传 undefined 取消 */
  onContextChange(cb?: (c: ContextChange) => void): void {
    this.changeSink = cb;
  }

  /** 会话状态导出（完整快照；深拷贝防外部改写内部数组） */
  exportSessionState(): ContextSessionState {
    return { chain: this.chain.map((s) => ({ ...s })), chainFrom: this.chainFrom, compacted: this.compacted.map((i) => ({ ...i })) };
  }

  /** 会话状态恢复（/resume / --continue）：直接注入，不触发订阅（重放期间日志是读方，不二次记录）；chainSeq 按链内最大步号续排 */
  restoreSession(s: ContextSessionState): void {
    this.chain = s.chain.map((st) => ({ ...st }));
    this.chainFrom = s.chainFrom;
    this.compacted = s.compacted.map((i) => ({ ...i }));
    this.chainSeq = this.chain.reduce((m, st) => Math.max(m, st.step), 0);
  }

  chainView(): HistoryStep[] {
    return this.chain.slice(this.chainFrom);
  }

  /** 会话链尾追（唯一写入口）：行号由链内序号定死，追加后不重排（裁剪后允许跳号） */
  appendChain(entries: Array<{ action?: string; observation: string }>): void {
    const pushed: HistoryStep[] = [];
    for (const e of entries) {
      const step = { step: ++this.chainSeq, ...(e.action !== undefined ? { action: e.action } : {}), observation: e.observation };
      this.chain.push(step);
      pushed.push(step);
    }
    if (pushed.length > 0) this.changeSink?.({ kind: 'append', steps: pushed });
  }

  /** 压缩协调：压缩块已代表的链前缀条目数，推进水位防「链+压缩块」双份 */
  trimChainFront(n: number): void {
    if (n <= 0) return;
    this.chainFrom = Math.min(this.chainFrom + n, this.chain.length);
    this.changeSink?.({ kind: 'compact', chainFrom: this.chainFrom, compacted: this.compacted });
  }

  /** 会话级重置（/new）：清链、压缩水位、压缩块与待注入技能块；账本与最近文件登记保留 */
  resetSession(): void {
    this.chain = [];
    this.chainFrom = 0;
    this.chainSeq = 0;
    this.compacted = [];
    this.pendingSkill = null;
  }

  /** 压缩块观测（只读）：当前压缩块代表的条目数（reactor 压缩事件计数口径） */
  compactedUpToCount(): number {
    return this.compacted.length;
  }

  /** 压缩事件计数（只读观测）：首个压缩事件记 1、新一轮压缩递增；同一压缩事件幂等重放（replay）不计数 */
  compactionCount(): number {
    return this.compactions;
  }

  /** 统一装配（fork 模型段序）：loader → rules → 压缩块 → history（会话链经 reactor 缺省 seed 流入）→ 技能块（尾追）
   *  goal 槽与记忆段已取消（CLAUDE.md §11：真实任务文本走链尾「当前指令行」，链即记忆） */
  assemble(history: ContextItem[] = [], relPath?: string): ContextItem[] {
    const items: ContextItem[] = [];
    items.push(...this.loader.load());
    if (relPath) items.push(...this.rules.forPath(relPath));
    items.push(...this.compacted);
    items.push(...history);
    if (this.pendingSkill !== null) {
      items.push({ kind: 'system', content: this.pendingSkill });
      this.pendingSkill = null;
    }
    return items;
  }
}

/** 链行 → history 条目的唯一拼装格式（reactor toHistory 与 TUI /compact 补链共用，防两处漂移） */
export function chainToHistoryItems(steps: HistoryStep[]): ContextItem[] {
  return steps.map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` }));
}

export interface RunCompactionResult {
  chunks: ContextChunk[];
  /** 摘要来源三态（透传 applyCompaction）：model / deterministic / replay */
  via: 'model' | 'deterministic' | 'replay';
}

/** 压缩协调单点（规格 §4.2/D5）：确定性选块 → 摘要分叉（模型优先，失败回退）→ 门禁重注入 → 折叠链前缀。
 *  reactor 自动压缩与 TUI /compact 两入口只传参不各自拼装（防拼装漂移，memory 双写教训）；
 *  replay 幂等重放不折链（防重复推进水位）。 */
export async function runCompaction(
  cm: ContextManager,
  items: ContextItem[],
  opts: { summaryTokenBudget: number; rereadTokenBudget: number; chainFoldedCount?: number; summaryModel?: ModelAdapter; focus?: string },
): Promise<RunCompactionResult> {
  // 归档先行且仅在将真实折链时写（replay 幂等重放不产孤儿归档）；写失败降级无指针行，压缩永不因归档失败而失败
  let traceLine: string | undefined;
  const folded = opts.chainFoldedCount ?? 0;
  if (folded > 0 && cm.chainView().length > 0) {
    try {
      const rows = cm.chainView().slice(0, Math.min(folded, cm.chainView().length));
      const archDir = path.join(resolveDataDir(cm.root), 'archives');
      fs.mkdirSync(archDir, { recursive: true });
      const digest = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 8);
      const file = path.join(archDir, `compaction-${rows.length}-${digest}.jsonl`);
      fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      traceLine = `Full trace: ${file}`;
    } catch {
      traceLine = undefined; // 归档失败降级：无指针行，压缩照常
    }
  }
  const chunks = await cm.window.compact(items, { summaryTokenBudget: opts.summaryTokenBudget });
  const via = await cm.applyCompaction(chunks, {
    rereadTokenBudget: opts.rereadTokenBudget,
    summaryTokenBudget: opts.summaryTokenBudget,
    ...(opts.summaryModel ? { summaryModel: opts.summaryModel } : {}),
    ...(traceLine !== undefined ? { traceLine } : {}),
    ...(opts.focus !== undefined ? { focus: opts.focus } : {}),
  });
  if (via !== 'replay' && opts.chainFoldedCount !== undefined && opts.chainFoldedCount > 0) {
    cm.trimChainFront(opts.chainFoldedCount);
  }
  return { chunks, via };
}
