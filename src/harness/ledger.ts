import { StorageAdapter } from '../storage/adapter';

/** 单次 run 账目条目：成本（tokens）与路由观测（决策）随 run 收尾聚合落盘 */
export interface RunLedgerEntry {
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
    return id;
  }

  /** 汇总：run 条数与 token 合计（空账本返回零值不抛） */
  summary(): { runs: number; tokens: number } {
    const index = this.store.read<string[]>('runs/_index', []);
    let tokens = 0;
    for (const id of index) {
      tokens += this.store.read<Pick<RunLedgerEntry, 'tokensUsed'>>(`runs/${id}`, { tokensUsed: 0 }).tokensUsed ?? 0;
    }
    return { runs: index.length, tokens };
  }
}
