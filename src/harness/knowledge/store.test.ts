import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileStore } from '../../storage/adapter';
import { registerVectorBackend, createVectorBackend, LocalJsonVectorStore } from './store';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-vec-'));
}

test('注册表：注册后按名创建；未注册名装配期 fail-fast 抛错（禁静默回退）', () => {
  registerVectorBackend('mem-test', (s) => new LocalJsonVectorStore(s));
  const s = createVectorBackend('mem-test', new FileStore(tmp()));
  assert.ok(s);
  assert.throws(() => createVectorBackend('no-such-backend', new FileStore(tmp())), /未注册的向量后端/);
});

test('local-json：upsert→search topK 语义与余弦排序', () => {
  const s = new LocalJsonVectorStore(new FileStore(tmp()));
  s.upsert('a', [1, 0], { text: 'alpha' });
  s.upsert('b', [0, 1], { text: 'beta' });
  s.upsert('c', [0.9, 0.1], { text: 'gamma' });
  const hits = s.search([1, 0], 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'a');
  assert.equal(hits[1].id, 'c');
  assert.ok(hits[0].score > hits[1].score);
  assert.equal(s.size(), 3);
});

test('local-json：topK 超过库容返回全部；topK=0 返回空', () => {
  const s = new LocalJsonVectorStore(new FileStore(tmp()));
  s.upsert('a', [1, 0], { text: 'alpha' });
  assert.equal(s.search([1, 0], 10).length, 1);
  assert.equal(s.search([1, 0], 0).length, 0);
});

test('local-json：flush→load 持久化往返（独立实例）', () => {
  const dir = tmp();
  const s1 = new LocalJsonVectorStore(new FileStore(dir));
  s1.upsert('a', [3, 4], { text: 'alpha doc' });
  s1.flush();
  const s2 = new LocalJsonVectorStore(new FileStore(dir));
  assert.equal(s2.size(), 0);
  s2.load();
  assert.equal(s2.size(), 1);
  const hits = s2.search([3, 4], 1);
  assert.equal(hits[0].id, 'a');
  assert.ok(Math.abs(hits[0].score - 1) < 1e-9);
});

test('local-json：归一化不受向量尺度影响（[1,0] 与 [100,0] 同分）', () => {
  const s = new LocalJsonVectorStore(new FileStore(tmp()));
  s.upsert('a', [1, 0], { text: 'unit' });
  s.upsert('b', [100, 0], { text: 'scaled' });
  const hits = s.search([1, 0], 2);
  assert.ok(Math.abs(hits[0].score - hits[1].score) < 1e-9);
});

test('local-json：upsert 同 id 覆盖（幂等）', () => {
  const s = new LocalJsonVectorStore(new FileStore(tmp()));
  s.upsert('a', [1, 0], { text: 'old' });
  s.upsert('a', [0, 1], { text: 'new' });
  assert.equal(s.size(), 1);
  const hits = s.search([0, 1], 1);
  assert.equal(hits[0].text, 'new');
});
