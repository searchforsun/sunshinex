import * as fs from 'fs';
import * as path from 'path';

/** 本地存储底座：JSON 文件读写占位（含 KV / 记忆 / 日志接口） */
export class LocalStore {
  constructor(private baseDir: string) {}

  private ensure(): void {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  read<T>(key: string, fallback: T): T {
    const p = path.join(this.baseDir, `${key}.json`);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  }

  write<T>(key: string, value: T): void {
    this.ensure();
    fs.writeFileSync(path.join(this.baseDir, `${key}.json`), JSON.stringify(value, null, 2));
  }
}
