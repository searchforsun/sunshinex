import { StorageAdapter } from '../../storage/adapter';

/** 会话状态：transcript 持久化 + 恢复 */
export class SessionStore {
  private hits = 0;
  private misses = 0;

  constructor(private store: StorageAdapter) {}

  save(id: string, data: unknown): void {
    this.store.write(`session.${id}`, data);
  }

  /** 缓存命中率 = hit / (hit + miss)；零样本返回 0 */
  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  load<T>(id: string, fallback: T): T {
    // 命中判定用每次新生成的哨兵对象：store 返回值与之引用相等即未命中（JSON 往返值不可能等于进程内新对象）
    const miss = Symbol('miss');
    const value = this.store.read<unknown>(`session.${id}`, miss);
    if (value === miss) {
      this.misses++;
      return fallback;
    }
    this.hits++;
    return value as T;
  }
}
