import * as fs from 'fs';
import * as path from 'path';
import { StorageAdapter } from '../../storage/adapter';
import { ContextItem } from '../../types';
import { ContextLoader } from './loader';
import { RulesRegistry } from './rules';
import { MemoryLifecycle } from './memory-lifecycle';
import { ContextWindow, ContextChunk, estimateTokens } from './window';
import { SessionStore } from './session';
import { maskText } from '../security/chain';

const RECENT_LIMIT = 5;
const REREAD_MAX_LINES = 500;
const MEMORY_INJECT_BUDGET = { skill: 600, episodic: 700, working: 700 }; // spec §2.5 常数表：分层配额注入（合计 2000 字符）

/** 上下文与记忆管理门面 */
export class ContextManager {
  readonly loader: ContextLoader;
  readonly rules: RulesRegistry;
  readonly memory: MemoryLifecycle;
  readonly window: ContextWindow;
  readonly session: SessionStore;

  private compacted: ContextItem[] = [];
  private recent: string[] = [];
  private pendingSkill: string | null = null;

  constructor(private readonly root: string, store: StorageAdapter) {
    this.loader = new ContextLoader(root);
    this.rules = new RulesRegistry(root);
    this.memory = new MemoryLifecycle(store);
    this.window = new ContextWindow();
    this.session = new SessionStore(store);
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

  /** 压缩重注入：checksum 门禁 → 摘要 + 重读最近文件 → 注入块（生效于后续轮次 assemble） */
  async applyCompaction(chunks: ContextChunk[], opts?: { rereadTokenBudget?: number }): Promise<void> {
    if (this.window.verifyChecksum(chunks) === 'replay') return; // 同一压缩事件幂等重放
    const items: ContextItem[] = [...this.window.reinject(chunks)];
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
    this.memory.record('compaction', `摘要 checksum=${this.window.checksum() ?? 'unknown'}，重读 ${items.length - 1} 个文件`);
  }

  /** 技能首帧注入槽：set 后的下一次 assemble 首位携带（kind=system），消费即清——技能正文不随后续帧重复 */
  setSkillBlock(content: string): void {
    this.pendingSkill = content;
  }

  /** 统一装配上下文：技能首帧块（如有）→ loader 分层指令 → rules 路径规则 → memory 记忆 → goal → 压缩注入块 → history */
  assemble(goal: string, history: ContextItem[] = [], relPath?: string): ContextItem[] {
    const items: ContextItem[] = [];
    if (this.pendingSkill !== null) {
      items.push({ kind: 'system', content: this.pendingSkill });
      this.pendingSkill = null;
    }
    items.push(...this.loader.load());
    if (relPath) items.push(...this.rules.forPath(relPath));
    const mem = this.memory.tail(MEMORY_INJECT_BUDGET);
    if (mem.length > 0) items.push({ kind: 'memory', content: mem.join('\n') });
    items.push({ kind: 'instruction', content: goal });
    items.push(...this.compacted);
    items.push(...history);
    return items;
  }
}
