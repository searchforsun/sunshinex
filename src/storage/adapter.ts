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
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  }

  write<T>(key: string, value: T): void {
    fs.mkdirSync(path.dirname(path.join(this.baseDir, `${key}.json`)), { recursive: true });
    fs.writeFileSync(path.join(this.baseDir, `${key}.json`), JSON.stringify(value, null, 2));
  }
}
