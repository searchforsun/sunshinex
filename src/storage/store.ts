import * as fs from 'fs';
import * as path from 'path';
import { FileStore, StorageAdapter } from './adapter';

/** @deprecated 使用 FileStore，保留别名兼容旧引用 */
export class LocalStore implements StorageAdapter {
  private delegate: StorageAdapter;
  constructor(baseDir: string) {
    this.delegate = new FileStore(baseDir);
  }
  read<T>(key: string, fallback: T): T { return this.delegate.read(key, fallback); }
  write<T>(key: string, value: T): void { this.delegate.write(key, value); }
}
