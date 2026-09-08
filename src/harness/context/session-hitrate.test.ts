import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from './session';
import { StorageAdapter } from '../../storage/adapter';

/** 测试桩：内存存储，模拟命中与未命中 */
class MemAdapter implements StorageAdapter {
  private map = new Map<string, unknown>();
  read<T>(key: string, fallback: T): T {
    return (this.map.has(key) ? this.map.get(key) : fallback) as T;
  }
  write<T>(key: string, value: T): void {
    this.map.set(key, value);
  }
}

test('hitRate 零样本返回 0（不得除零）', () => {
  const s = new SessionStore(new MemAdapter());
  assert.equal(s.hitRate(), 0);
});

test('未命中加载计入 miss：fallback 返回且命中率下降', () => {
  const s = new SessionStore(new MemAdapter());
  assert.deepEqual(s.load('nope', { v: 0 }), { v: 0 });
  assert.equal(s.hitRate(), 0); // 0 hit / 1 miss
});

test('命中加载计入 hit：先存后读命中一次', () => {
  const s = new SessionStore(new MemAdapter());
  s.save('a', { v: 1 });
  assert.deepEqual(s.load('a', null), { v: 1 });
  assert.equal(s.hitRate(), 1); // 1 hit / 0 miss
});

test('混合计数：1 hit 1 miss → 命中率 0.5', () => {
  const s = new SessionStore(new MemAdapter());
  s.save('hit', { ok: true });
  s.load('hit', null); // hit
  s.load('miss', null); // miss
  assert.equal(s.hitRate(), 0.5);
});
