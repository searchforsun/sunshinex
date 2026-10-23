import { StorageAdapter } from '../storage/adapter';

/** 单次 run 账目条目：成本（tokens）与路由观测（决策）随 run 收尾聚合落盘 */
interface RunLedgerEntry {
  id: string;
  createdAt: string;
  goal: string;
  done: boolean;
  steps: number;
  tokensUsed: number;
  durationMs: number;
  route?: { tier: string; reason: string };
}

/** per-run 成本账本：条目落 runs/<id>，索引落 runs/_index（spec §3.3 记账面，selfcheck 汇总行数据源） */
export class RunLedger {
  constructor(private store: StorageAdapter) {}

  record(entry: Omit<RunLedgerEntry, 'id' | 'createdAt'>): string {
    const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const full: RunLedgerEntry = { ...entry, id, createdAt: new Date().toISOString() };
    this.store.write(`runs/${id}`, full);
    const index = this.store.read<string[]>('runs/_index', []);
    index.push(id);
    this.store.write('runs/_index', index);
    // O5:汇总缓存档增量维护（summary 单读 O(1);校验/自愈面见 summary 注）
    const cached = this.store.read<{ runs?: number; tokens?: number }>('runs/_summary', {});
    this.store.write('runs/_summary', { runs: index.length, tokens: (cached.tokens ?? 0) + entry.tokensUsed });
    return id;
  }

  /** 汇总：run 条数与 token 合计（空账本返回零值不抛）。O5 增量化——缓存档 runs/_summary 单读
   *  O(1)（record 顺手增量维护）;校验面=索引长度,不符（旧档无缓存/半写档）→ 一次性 O(n) 逐 id
   *  重算并回填缓存自愈。TUI 状态刷新/自检汇总每次调 summary,旧实现 O(n) 随账本终身线性劣化 */
  summary(): { runs: number; tokens: number } {
    const index = this.store.read<string[]>('runs/_index', []);
    const cached = this.store.read<{ runs?: number; tokens?: number }>('runs/_summary', {});
    if (cached.runs === index.length) return { runs: index.length, tokens: cached.tokens ?? 0 };
    let tokens = 0;
    for (const id of index) {
      tokens += this.store.read<Pick<RunLedgerEntry, 'tokensUsed'>>(`runs/${id}`, { tokensUsed: 0 }).tokensUsed ?? 0;
    }
    this.store.write('runs/_summary', { runs: index.length, tokens });
    return { runs: index.length, tokens };
  }
}
