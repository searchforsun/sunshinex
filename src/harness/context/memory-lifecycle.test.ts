import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryLifecycle } from './memory-lifecycle';
import { FileStore } from '../../storage/adapter';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ml-'));
}

test('MemoryLifecycle 记录并读取索引', () => {
  const store = new FileStore(tmpdir());
  const m = new MemoryLifecycle(store);
  m.record('project', '记住用户偏好 TDD');
  assert.deepEqual(m.index(), ['project: 记住用户偏好 TDD']);
});

test('MemoryLifecycle 索引上限 200 行，淘汰最旧', () => {
  const store = new FileStore(tmpdir());
  const m = new MemoryLifecycle(store);
  for (let i = 0; i < 201; i++) m.record('project', `n${i}`);
  const idx = m.index();
  assert.equal(idx.length, 200);
  assert.equal(idx[0], 'project: n1');
  assert.equal(idx[199], 'project: n200');
});

test('record 按主题路由：project→working，compaction→episodic', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  m.record('project', '偏好 TDD');
  m.record('compaction', '摘要 checksum=abc');
  assert.deepEqual(m.counts(), { working: 1, episodic: 1, skill: 0 });
});

test('index 聚合顺序：skill → episodic → working', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  m.record('project', '工作条目');
  m.record('compaction', '事件条目');
  assert.equal(m.promote('事件条目'), true);
  assert.deepEqual(m.index(), ['compaction: 事件条目', 'project: 工作条目']);
});

test('promote：命中提升 episodic → skill，未命中返回 false', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  m.record('compaction', '关键事实 root 越界即拒绝');
  assert.equal(m.promote('不存在'), false);
  assert.equal(m.promote('关键事实'), true);
  assert.deepEqual(m.counts(), { working: 0, episodic: 0, skill: 1 });
  assert.equal(m.promote('关键事实'), false, '已提升后 episodic 无此条目');
});

test('skill 层上限 50，FIFO 淘汰最旧', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  for (let i = 0; i < 52; i++) m.record('compaction', `事实 marker${i}end`);
  for (let i = 0; i < 52; i++) assert.equal(m.promote(`marker${i}end`), true);
  const c = m.counts();
  assert.equal(c.skill, 50);
  assert.equal(c.episodic, 0);
  assert.equal(m.index()[0], 'compaction: 事实 marker2end', '最旧两条被 FIFO 淘汰');
});

test('endTask 清退 working，episodic/skill 保留', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  m.record('project', '易失记录');
  m.record('compaction', '持久事件');
  assert.equal(m.promote('持久事件'), true);
  m.endTask();
  assert.deepEqual(m.counts(), { working: 0, episodic: 0, skill: 1 });
  assert.deepEqual(m.index(), ['compaction: 持久事件']);
});

test('legacy 单桶索引自动迁移：按前缀路由，legacy 键清空且幂等', () => {
  const store = new FileStore(tmpdir());
  store.write('memory.index', ['project: 旧工作记录', 'compaction: 旧压缩事件']);
  const m = new MemoryLifecycle(store);
  assert.deepEqual(m.counts(), { working: 1, episodic: 1, skill: 0 });
  assert.deepEqual(m.index(), ['compaction: 旧压缩事件', 'project: 旧工作记录']);
  assert.deepEqual(store.read<string[]>('memory.index', ['x']), [], 'legacy 键写空防重复迁移');
  const m2 = new MemoryLifecycle(store);
  assert.deepEqual(m2.counts(), { working: 1, episodic: 1, skill: 0 });
});
