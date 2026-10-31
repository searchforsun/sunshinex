import * as fs from 'fs';
import * as path from 'path';

/** 队友 inbox 消费位点:<teams>/inbox-cursors.json。键为 teammate 名,值为已消费的最大消息 ts。 */
export class InboxCursorStore {
  private cursors?: Record<string, number>;

  constructor(private readonly file: string) {}

  load(agent: string): number {
    return this.read()[agent] ?? 0;
  }

  save(agent: string, ts: number): void {
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
