import { StorageAdapter } from '../../storage/adapter';

/** 自动记忆：索引 + 主题文件（四类 type，阶段一简化为索引列表） */
export class AutoMemory {
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
