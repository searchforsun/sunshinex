import * as fs from 'fs';
import * as path from 'path';

/**
 * 归档存储接缝（D26/J10 IO 收敛）：压缩折链全量归档（compaction-*.jsonl）写入/枚举/重读的读写单点，
 * 形态与 StorageAdapter 对齐（小接口 + 零依赖 fs 实现可替换）。归档文件命名法（含行数与内容摘要）归
 * 调用方（压缩协调）所有——id 即文件名原样落盘；本层只管落点（<dataDir>/archives/）、目录与字节内容。
 */
export interface ArchiveStore {
  /** 写入一份归档（id=文件名）：目录幂等创建 + 整文件落盘，返回归档绝对路径（压缩块「Full trace」指针行取此值） */
  write(id: string, content: string): string;
  /** 列出既有归档（id=文件名 + 绝对路径）；目录尚未创建为空表（读侧无副作用） */
  list(): Array<{ id: string; path: string }>;
  /** 按绝对路径读回全文（压缩后重读最近文件同走此口）；不存在/不可读抛错，由调用方按各自语义兜底（与裸 readFileSync 同） */
  read(file: string): string;
}

/** fs 实现：归档恒落 <dataDir>/archives/，目录随首次写入幂等创建（IO 本体单点收敛于 storage 层） */
class FsArchiveStore implements ArchiveStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'archives');
  }

  write(id: string, content: string): string {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, id);
    fs.writeFileSync(file, content);
    return file;
  }

  list(): Array<{ id: string; path: string }> {
    try {
      return fs.readdirSync(this.dir).map((name) => ({ id: name, path: path.join(this.dir, name) }));
    } catch {
      return []; // 目录尚未创建：归档集为空（读侧不建目录）
    }
  }

  read(file: string): string {
    return fs.readFileSync(file, 'utf8');
  }
}

/** 生产装配工厂（与 FileStore 同为「接口 + 零依赖默认实现」形态）：门面构造缺省取用，测试可换 spy 版 */
export function createFsArchiveStore(dataDir: string): ArchiveStore {
  return new FsArchiveStore(dataDir);
}
