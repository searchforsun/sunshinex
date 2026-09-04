import { StorageAdapter } from '../../storage/adapter';

/** 会话状态：transcript 持久化 + 恢复 */
export class SessionStore {
  constructor(private store: StorageAdapter) {}

  save(id: string, data: unknown): void {
    this.store.write(`session.${id}`, data);
  }

  load<T>(id: string, fallback: T): T {
    return this.store.read<T>(`session.${id}`, fallback);
  }
}
