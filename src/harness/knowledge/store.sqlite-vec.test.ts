import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StorageAdapter } from '../../storage/adapter';
import { createVectorBackend } from './store';
import { SqliteVecStore } from './store.sqlite-vec';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sqlite-'));
}

const dummyStorage = { read: () => null, write: () => {} } as unknown as StorageAdapter;

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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteVecStore：维度不一致 fail-fast；损坏库 load 降级不抛', () => {
  const dir = tmpDir();
  try {
    const s = new SqliteVecStore(dir);
    s.upsert('a', [1, 0, 0], { text: 'dim3' });
    assert.throws(() => s.upsert('b', [1, 0], { text: 'dim2' }), /维度不一致/);
    fs.writeFileSync(path.join(dir, 'vectors.db'), Buffer.from('not-a-sqlite-file'));
    const s2 = new SqliteVecStore(dir);
    assert.doesNotThrow(() => s2.load(), '损坏存储的 load 必须降级不抛');
    assert.equal(s2.size(), 0, '损坏存储应回退空库');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KB_BACKEND 注册：sqlite-vec 工厂经注册表可创建（KB_DATA_DIR 装配）', () => {
  const dir = tmpDir();
  process.env.KB_DATA_DIR = dir;
  try {
    const s = createVectorBackend('sqlite-vec', dummyStorage);
    assert.ok(s instanceof SqliteVecStore);
    assert.equal(s.size(), 0);
  } finally {
    delete process.env.KB_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
