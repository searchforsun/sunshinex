import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { createVectorBackend } from './store';
import { SqliteVecStore } from './store.sqlite-vec';
// 装配模块注册在册后端（D18/J3：注册收敛在装配点）——本文件钉注册表路由，须先武装注册
import './index';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sqlite-'));
}

/** f32 向量 → vec0 hex 字面量（旧库手造夹具用，同 store.sqlite-vec.ts 口径） */
const f32hex = (a: number[]): string => "x'" + Buffer.from(new Float32Array(a).buffer).toString('hex') + "'";

test('SqliteVecStore：upsert/search 排序 + score 降序 + TopK 语义', () => {
  const dir = tmpDir();
  try {
    const s = new SqliteVecStore(dir);
    s.upsert('a', [1, 0], { text: 'alpha' });
    s.upsert('b', [0, 1], { text: 'beta' });
    s.upsert('c', [0.9, 0.1], { text: 'gamma' });
    const hits = s.search([1, 0], 2);
    assert.equal(hits.length, 2, 'topK=2 应返回 2 条');
    assert.equal(hits[0].id, 'a', '最近邻应排首位');
    assert.ok(hits[0].score >= hits[1].score, 'score 应降序');
    assert.equal(s.search([1, 0], 0).length, 0, 'topK=0 应返回空');
    assert.equal(s.search([1, 0], 99).length, 3, 'topK 超库容应返回全部');
    assert.equal(s.size(), 3);
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteVecStore：幂等覆盖 + 持久化往返（load 前空视图与 local-json 对齐）', () => {
  const dir = tmpDir();
  try {
    const s = new SqliteVecStore(dir);
    s.upsert('a', [1, 0], { text: 'alpha' });
    s.upsert('b', [0, 1], { text: 'beta' });
    // 覆盖向量取严格唯一最近（距离 0）：vec0 KNN 同距平局序未定义，契约断言不应依赖平局
    s.upsert('a', [0.9, 0.9], { text: 'alpha-v2' });
    assert.equal(s.size(), 2, '同 id 覆盖不应增加容量');
    assert.equal(s.search([0.9, 0.9], 1)[0].text, 'alpha-v2');
    s.flush();
    const s2 = new SqliteVecStore(dir);
    assert.equal(s2.size(), 0, '新实例在 load 前应为空');
    s2.load();
    assert.equal(s2.size(), 2, 'load 后应恢复全部条目');
    assert.equal(s2.search([0.9, 0.9], 1)[0].text, 'alpha-v2', '持久化后检索语义一致');
    s.close();
    s2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteVecStore：维度不一致 fail-fast；损坏库 load 降级不抛', () => {
  const dir = tmpDir();
  try {
    const s = new SqliteVecStore(dir);
    s.upsert('a', [1, 0, 0], { text: 'dim3' });
    assert.throws(() => s.upsert('b', [1, 0], { text: 'dim2' }), /Dimension mismatch/);
    s.close();
    fs.writeFileSync(path.join(dir, 'vectors.db'), Buffer.from('not-a-sqlite-file'));
    const s2 = new SqliteVecStore(dir);
    assert.doesNotThrow(() => s2.load(), '损坏存储的 load 必须降级不抛');
    assert.equal(s2.size(), 0, '损坏存储应回退空库');
    s2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('后端注册路由：装配模块注册的 sqlite-vec 经注册表按显式 dataDir 构造（J3：工厂不再读 env/锚 cwd）', () => {
  const dir = tmpDir();
  try {
    const s = createVectorBackend('sqlite-vec', dir);
    assert.ok(s instanceof SqliteVecStore, '应装配为 SqliteVecStore');
    assert.equal(s.size(), 0);
    s.close?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kb_meta 旧口径迁移（J8）：无 meta 列旧库 load 后回空库整体重建，重写后 meta 完整持久化', () => {
  const dir = tmpDir();
  try {
    // 手造 J8 之前的旧库：kb_meta 无 meta 列、kb_vec 有向量、meta 表有 dim 基点
    const old = new DatabaseSync(path.join(dir, 'vectors.db'), { allowExtension: true });
    old.loadExtension(require('sqlite-vec').getLoadablePath());
    old.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)');
    old.exec("INSERT INTO meta(key, value) VALUES ('dim', '2')");
    old.exec('CREATE TABLE kb_meta(rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, text TEXT)');
    old.exec('CREATE VIRTUAL TABLE kb_vec USING vec0(embedding float[2])');
    old.exec("INSERT INTO kb_meta(id, text) VALUES ('a', 'alpha-old')");
    old.exec(`INSERT INTO kb_vec(rowid, embedding) VALUES (1, ${f32hex([1, 0])})`);
    old.close();

    const s = new SqliteVecStore(dir);
    s.load();
    assert.equal(s.size(), 0, '旧口径库应整体废弃（索引可由 indexDir 重建），不得挂出半残索引');
    assert.equal(s.metaOf('a'), undefined, '旧条目不残留（无 meta 的旧行已随迁移废弃）');
    s.upsert('a', [1, 0], { text: 'alpha', file: 'docs/a.md' });
    s.flush();
    s.close();

    const s2 = new SqliteVecStore(dir);
    s2.load();
    assert.equal(s2.size(), 1, '迁移后新写正常');
    assert.equal(s2.metaOf('a')?.['file'], 'docs/a.md', '重写的 meta 应完整持久化');
    s2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
