import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager } from './index';
import type { CtxSnapshot } from './index';
import type { StorageAdapter } from '../../storage/adapter';

/** 快照导出/回种 + reloadContext snap 事件（2026-10-31 spec Task 3）：
 *  字节级往返（跨重建逐位稳定）、回种不触发订阅（重放零双写）、reloadContext 发 snap 信号（订阅面落 ctx-snap 行）。 */

// store 形参未用（持久化双轨已并轨至 journal 事件流）——哑对象透传即可
const fakeStore = {} as StorageAdapter;

test('snapshotExport/restoreSnapshot: 字节级往返', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  const snap = cm.snapshotExport();
  const cm2 = new ContextManager('/nonexistent-root', fakeStore);
  assert.equal(cm2.restoreSnapshot(snap), true);
  // 字节级不变量：装配快照逐位相等
  assert.equal(JSON.stringify(cm2.snapshotExport()), JSON.stringify(snap));
});

test('restoreSnapshot 不触发订阅（重放零双写）', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  let events = 0;
  cm.onContextChange(() => {
    events += 1;
  });
  cm.restoreSnapshot(cm.snapshotExport());
  assert.equal(events, 0);
});

test('reloadContext 发出 snap 事件（压缩/显式刷新后的落档信号）', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  const kinds: string[] = [];
  cm.onContextChange((c) => kinds.push(c.kind));
  cm.reloadContext();
  assert.deepEqual(kinds, ['snap']);
});

test('restoreSnapshot 载荷不合法（条目 kind 越界）整包拒收返回 false', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  const bad: CtxSnapshot = {
    items: [{ part: 'instructions', kind: 'bogus', content: 'x' }],
    sig: { skills: '', memory: '', sunshinex: null, globalSunshine: null },
  };
  assert.equal(cm.restoreSnapshot(bad), false);
  // 拒收后快照不被部分污染（整包原子）
  assert.equal(cm.snapshotView().length, cm.snapshotExport().items.length);
});
