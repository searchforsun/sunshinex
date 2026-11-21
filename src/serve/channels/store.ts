/** 通道 bindings 运行时档存储(spec 2026-11-21-channels §4):IM 聊天 ↔ sunshine 会话绑定
 *  的持久化单点——load 带 ENOENT 容忍 + 坏档 quarantine + persist tmp+rename 原子写,
 *  骨架与 schedules/store.ts 同款,仅数据形状换为 {version:1, bindings: Binding[]}。
 *  供 Task 5 router 做绑定读写;文件 channels-bindings.json。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { userConfigDir } from '../../config/env';
import type { Binding } from './model';

export interface ChannelsBindingsStoreFile {
  version: 1;
  bindings: Binding[];
}

export function channelsBindingsFile(): string {
  const override = process.env.SUNSHINEX_DATA_DIR;
  return path.join(override !== undefined && override !== '' ? path.resolve(override) : userConfigDir(), 'channels-bindings.json');
}

export class ChannelsBindingsStore {
  private data: ChannelsBindingsStoreFile;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  /** 坏档改名落点:`channels-bindings.json` → `channels-bindings.corrupt-<ts>.json`(同目录,尽力而为) */
  private corruptFile(): string {
    const base = path.basename(this.file);
    const stem = base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
    return path.join(path.dirname(this.file), `${stem}.corrupt-${Date.now()}.json`);
  }

  private load(): ChannelsBindingsStoreFile {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      /* 缺失是常态(首启空库);其余读失败(权限/类型等)按坏档隔离,绝不阻塞启动 */
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bindings: [] };
      console.warn('[channels-bindings] unreadable store, starting empty:', e instanceof Error ? e.message : String(e));
      this.quarantine();
      return { version: 1, bindings: [] };
    }
    try {
      const raw = JSON.parse(text) as unknown;
      if (raw === null || typeof raw !== 'object' || (raw as ChannelsBindingsStoreFile).version !== 1 || !Array.isArray((raw as ChannelsBindingsStoreFile).bindings)) {
        throw new Error('unsupported channels bindings file');
      }
      /* 宽容过滤口径同 schedules:条目须为对象,且 key 与 sessionId 为非空 string 才收,其余字段可选 */
      const bindings = (raw as ChannelsBindingsStoreFile).bindings
        .filter((b) => b !== null && typeof b === 'object' && !Array.isArray(b)
          && typeof b.key === 'string' && b.key !== ''
          && typeof b.sessionId === 'string' && b.sessionId !== '');
      return { version: 1, bindings };
    } catch (e) {
      console.warn('[channels-bindings] corrupt store, starting empty:', e instanceof Error ? e.message : String(e));
      this.quarantine();
      return { version: 1, bindings: [] };
    }
  }

  /** 坏档隔离:尽力改名到 `channels-bindings.corrupt-<ts>.json`;失败也按空库启动 */
  private quarantine(): void {
    try {
      fs.renameSync(this.file, this.corruptFile());
    } catch {
      /* 改名失败也按空库启动 */
    }
  }

  all(): Binding[] {
    return this.data.bindings;
  }

  get(key: string): Binding | undefined {
    return this.data.bindings.find((b) => b.key === key);
  }

  upsert(b: Binding): void {
    const i = this.data.bindings.findIndex((x) => x.key === b.key);
    if (i >= 0) this.data.bindings[i] = b;
    else this.data.bindings.push(b);
    this.persist();
  }

  remove(key: string): boolean {
    const i = this.data.bindings.findIndex((x) => x.key === key);
    if (i < 0) return false;
    this.data.bindings.splice(i, 1);
    this.persist();
    return true;
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[channels-bindings] persist failed:', e instanceof Error ? e.message : String(e));
    }
  }
}
