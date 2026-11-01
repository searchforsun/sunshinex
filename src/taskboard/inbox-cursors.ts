import * as fs from 'fs';
import * as path from 'path';

/** 成员 inbox 消费位点:会话 teams 根下 inbox-cursors.json。键为成员名,值为已消费的最大消息 ts。
 *  未 adopt / 未传文件前零落盘（harness 未绑 journal 态）。 */
export class InboxCursorStore {
  private cursors?: Record<string, number>;
  private file: string | undefined;

  constructor(file?: string) {
    this.file = file;
  }

  /** 会话收养：切位点文件并丢弃内存缓存（下次 load 自新文件）。 */
  adopt(file: string): void {
    this.file = file;
    this.cursors = undefined;
  }

  load(agent: string): number {
    if (this.file === undefined) return 0;
    return this.read()[agent] ?? 0;
  }

  save(agent: string, ts: number): void {
    if (this.file === undefined) return;
    const all = this.read();
    if (ts <= (all[agent] ?? 0)) return;
    all[agent] = ts;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  private read(): Record<string, number> {
    if (this.cursors !== undefined) return this.cursors;
    this.cursors = {};
    if (this.file === undefined) return this.cursors;
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.cursors;
      throw e;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v)) this.cursors[k] = v;
        }
      }
    } catch {
      // 损坏文件按空位点;下一次 save 覆盖
    }
    return this.cursors;
  }
}
