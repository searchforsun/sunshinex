import * as fs from 'fs';
import * as path from 'path';

export interface StorageAdapter {
  read<T>(key: string, fallback: T): T;
  write<T>(key: string, value: T): void;
}

/** 文件 JSON 存储（零依赖默认实现） */
export class FileStore implements StorageAdapter {
  constructor(private baseDir: string) {}

  read<T>(key: string, fallback: T): T {
    const p = path.join(this.baseDir, `${key}.json`);
    if (!fs.existsSync(p)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    } catch {
      // 并发写入的截断中间态或历史撕裂文件：键值存储语义下降级回退 fallback，下次 write 整文件覆盖自愈
      return fallback;
    }
  }

  write<T>(key: string, value: T): void {
    const target = path.join(this.baseDir, `${key}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 原子写：先写同目录临时文件再 rename 替换——并发读者只见旧或新完整内容，永不撞截断中间态
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
  }
}
