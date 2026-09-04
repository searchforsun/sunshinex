import { StorageAdapter } from '../../storage/adapter';

/** 统一记忆生命周期：索引 + 主题文件（working/episodic/skill 三级流转留待 1E） */
export class MemoryLifecycle {
  constructor(private store: StorageAdapter) {}

  index(): string[] {
    return this.store.read<string[]>('memory.index', []);
  }

  record(type: string, text: string): void {
    const idx = this.index();
    const entry = `${type}: ${text}`;
    if (idx.length >= 200) idx.shift(); // 索引上限 200 行
    idx.push(entry);
    this.store.write('memory.index', idx);
  }
}
