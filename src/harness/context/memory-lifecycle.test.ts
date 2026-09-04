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
