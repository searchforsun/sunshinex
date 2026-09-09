import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

/** f32 向量 → vec0 可接受的 hex blob 字面量（参数化绑定在 vec0 xUpdate 下不可用，见 G1 spike 结论） */
const f32hex = (a: number[]): string => "x'" + Buffer.from(new Float32Array(a).buffer).toString('hex') + "'";

test('sqlite-vec spike：vec0 加载 → 建表 → hex 插入 → KNN(k=?) 距离序', () => {
  const sv: { getLoadablePath(): string } = require('sqlite-vec');
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  db.loadExtension(sv.getLoadablePath());
  db.exec('CREATE VIRTUAL TABLE vt USING vec0(embedding float[4])');
  db.exec(`INSERT INTO vt(rowid, embedding) VALUES (1, ${f32hex([1, 0, 0, 0])}), (2, ${f32hex([0, 1, 0, 0])})`);

  const rows = db.prepare('SELECT rowid, distance FROM vt WHERE embedding MATCH ? AND k = ?').all(JSON.stringify([1, 0, 0, 0]), 2) as Array<{ rowid: number; distance: number }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rowid, 1, '同向向量距离最近应排首');
  assert.ok(rows[0].distance < rows[1].distance, 'distance 升序 = 越相关越前');
  assert.ok(Math.abs(rows[0].distance) < 1e-6, '同向向量距离≈0');
});

test('sqlite-vec spike：allowExtension 缺省关闭（安全缺省证据）', () => {
  const sv: { getLoadablePath(): string } = require('sqlite-vec');
  const db = new DatabaseSync(':memory:');
  assert.throws(() => db.loadExtension(sv.getLoadablePath()), /not allowed/i);
});
