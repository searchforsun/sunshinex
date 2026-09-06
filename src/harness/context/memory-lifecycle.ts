import { StorageAdapter } from '../../storage/adapter';

/** 记忆分层：working（当前任务，易失）/ episodic（事件记忆，持久）/ skill（沉淀知识，仅经 promote 写入） */
export type MemoryTier = 'working' | 'episodic' | 'skill';

const TIER_KEY: Record<MemoryTier, string> = {
  working: 'memory.working',
  episodic: 'memory.episodic',
  skill: 'memory.skill',
};
const LEGACY_KEY = 'memory.index';
const CAP: Record<MemoryTier, number> = { working: 200, episodic: 200, skill: 50 };
const MEMORY_RECORD_MAX_CHARS = 500; // spec §2.5：record 入口单条限长

/** 统一记忆生命周期：working→episodic→skill 三级流转（A4 唯一记忆面，memory.* 键仅此类读写） */
export class MemoryLifecycle {
  constructor(private store: StorageAdapter) {
    this.migrate();
  }

  private tier(t: MemoryTier): string[] {
    return this.store.read<string[]>(TIER_KEY[t], []);
  }

  private save(t: MemoryTier, items: string[]): void {
    this.store.write(TIER_KEY[t], items);
  }

  record(type: string, text: string): void {
    const t: MemoryTier = type === 'project' ? 'working' : 'episodic';
    const items = this.tier(t);
    items.push(`${type}: ${text.slice(0, MEMORY_RECORD_MAX_CHARS)}`);
    if (items.length > CAP[t]) items.shift();
    this.save(t, items);
  }

  /** 聚合视图：skill → episodic → working（注入顺序 = 价值梯度） */
  index(): string[] {
    return [...this.tier('skill'), ...this.tier('episodic'), ...this.tier('working')];
  }

  /** 分层配额注入视图（spec §2.5）：各层内取尾（最新优先，软上限——整条纳入，最新一条永不因配额丢弃），层间按价值梯度拼接 skill→episodic→working */
  tail(maxChars: { skill: number; episodic: number; working: number }): string[] {
    const take = (t: MemoryTier): string[] => {
      const items = this.tier(t);
      const out: string[] = [];
      let used = 0;
      for (let i = items.length - 1; i >= 0 && used < maxChars[t]; i--) {
        out.unshift(items[i]);
        used += items[i].length;
      }
      return out;
    };
    return [...take('skill'), ...take('episodic'), ...take('working')];
  }

  /** episodic → skill 显式沉淀：按子串匹配第一条命中条目，原样移入 skill 层（上限 50 FIFO） */
  promote(match: string): boolean {
    const epi = this.tier('episodic');
    const i = epi.findIndex((l) => l.includes(match));
    if (i === -1) return false;
    const skill = this.tier('skill');
    skill.push(epi[i]);
    if (skill.length > CAP.skill) skill.shift();
    epi.splice(i, 1);
    this.save('episodic', epi);
    this.save('skill', skill);
    return true;
  }

  /** 任务收尾：清退 working 层；episodic/skill 持久保留 */
  endTask(): void {
    this.save('working', []);
  }

  counts(): { working: number; episodic: number; skill: number } {
    return {
      working: this.tier('working').length,
      episodic: this.tier('episodic').length,
      skill: this.tier('skill').length,
    };
  }

  /** legacy 单桶索引一次性迁移：按前缀路由到分层键；legacy 键写空（StorageAdapter 无删除语义，不加接口） */
  private migrate(): void {
    const legacy = this.store.read<string[]>(LEGACY_KEY, []);
    if (legacy.length === 0) return;
    if (this.tier('working').length + this.tier('episodic').length + this.tier('skill').length > 0) return;
    const routed: Record<MemoryTier, string[]> = { working: [], episodic: [], skill: [] };
    for (const line of legacy) routed[line.startsWith('project:') ? 'working' : 'episodic'].push(line);
    for (const t of ['working', 'episodic', 'skill'] as MemoryTier[]) {
      if (routed[t].length > CAP[t]) routed[t] = routed[t].slice(routed[t].length - CAP[t]);
      if (routed[t].length > 0) this.save(t, routed[t]);
    }
    this.store.write(LEGACY_KEY, []);
  }
}
