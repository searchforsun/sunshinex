import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { KbHit } from '../../types';
import { registerVectorBackend, VectorStore } from './store';

/** f32 向量 → vec0 hex blob 字面量：参数化绑定在 vec0 xUpdate 主键校验下不可用（G1 spike 结论），字面量是唯一插入通道 */
function f32hex(v: number[]): string {
  return "x'" + Buffer.from(new Float32Array(v).buffer).toString('hex') + "'";
}

const SCHEMA = (dim: number) => `CREATE VIRTUAL TABLE IF NOT EXISTS kb_vec USING vec0(embedding float[${dim}])`;

/**
 * sqlite-vec 后端：vec0 KNN（欧氏距离），单文件持久化 `vectors.db`。
 * 语义与 local-json 对齐：实例仅经 load() 挂接既有库（load 前为空视图）；id↔rowid 经 kb_meta 映射（vec0 仅接受整数 rowid）。
 * score = 1/(1+distance)：与距离单调反相，保持「越大越相关」契约。
 */
export class SqliteVecStore implements VectorStore {
  private db: DatabaseSync | null = null;
  private dim = 0;
  private loaded = false;
  private memCount = 0;

  constructor(private dataDir: string) {}

  private open(): DatabaseSync {
    if (this.db) return this.db;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(this.dataDir, 'vectors.db'), { allowExtension: true });
    // vec0 缺失即抛（fail-fast）：后端不可用必须在装配/首写期暴露，禁静默降级
    db.loadExtension(require('sqlite-vec').getLoadablePath());
    db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS kb_meta(rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, text TEXT)');
    this.db = db;
    return db;
  }

  private ensureTable(dim: number): void {
    const db = this.open();
    if (this.dim === 0) {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'dim'").get() as { value: string } | undefined;
      if (row && Number(row.value) !== dim) throw new Error(`维度不一致：库内 ${row.value}，请求 ${dim}`);
      this.dim = dim;
      db.exec(SCHEMA(dim));
      db.prepare("INSERT INTO meta(key, value) VALUES ('dim', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(dim));
    }
    if (this.dim !== dim) throw new Error(`维度不一致：库内 ${this.dim}，请求 ${dim}`);
  }

  upsert(id: string, vec: number[], meta: Record<string, unknown>): void {
    this.ensureTable(vec.length);
    const db = this.db as DatabaseSync;
    const text = String(meta.text ?? '');
    const row = db.prepare('SELECT rowid FROM kb_meta WHERE id = ?').get(id) as { rowid: number } | undefined;
    let rowid: number;
    let isNew = false;
    if (row) {
      db.prepare('UPDATE kb_meta SET text = ? WHERE id = ?').run(text, id);
      rowid = row.rowid;
    } else {
      db.prepare('INSERT INTO kb_meta(id, text) VALUES (?, ?)').run(id, text);
      rowid = (db.prepare('SELECT rowid FROM kb_meta WHERE id = ?').get(id) as { rowid: number }).rowid;
      isNew = true;
    }
    if (row) db.prepare('DELETE FROM kb_vec WHERE rowid = ?').run(rowid);
    // vec0 xUpdate 对主键列拒绝参数绑定（G1 spike 未覆盖该通道，G2 实测）：rowid 为库内自映射整数，字面量拼接无注入面
    if (!Number.isInteger(rowid)) throw new Error(`非法 rowid：${rowid}`);
    db.exec(`INSERT INTO kb_vec(rowid, embedding) VALUES (${rowid}, ${f32hex(vec)})`);
    if (isNew && !this.loaded) this.memCount += 1;
  }

  search(vec: number[], topK: number): KbHit[] {
    if (topK <= 0 || this.dim === 0 || !this.db) return [];
    const rows = this.db
      .prepare('SELECT rowid, distance FROM kb_vec WHERE embedding MATCH ? AND k = ?')
      .all(JSON.stringify(vec), topK) as Array<{ rowid: number; distance: number }>;
    return rows.map((r) => {
      const m = this.db?.prepare('SELECT id, text FROM kb_meta WHERE rowid = ?').get(r.rowid) as { id: string; text: string } | undefined;
      return { id: m?.id ?? String(r.rowid), text: m?.text ?? '', score: 1 / (1 + r.distance) };
    });
  }

  size(): number {
    if (!this.loaded) return this.memCount;
    if (!this.db || this.dim === 0) return 0;
    return Number((this.db.prepare('SELECT COUNT(*) AS c FROM kb_vec').get() as { c: number }).c);
  }

  load(): void {
    try {
      const db = this.open();
      const row = db.prepare("SELECT value FROM meta WHERE key = 'dim'").get() as { value: string } | undefined;
      this.dim = row ? Number(row.value) : 0;
      this.loaded = true;
    } catch {
      // 损坏存储降级空库：load 契约不抛（索引可由 indexDir 重建，不阻塞装配）
      this.db = null;
      this.dim = 0;
      this.loaded = true;
    }
  }

  flush(): void {
    if (this.db) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
}

registerVectorBackend('sqlite-vec', () => new SqliteVecStore(process.env.KB_DATA_DIR ?? '.data/kb'));
