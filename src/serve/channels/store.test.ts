import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChannelsBindingsStore } from './store';

function tmpStore(): { store: ChannelsBindingsStore; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-bind-'));
  const file = path.join(dir, 'channels-bindings.json');
  return { store: new ChannelsBindingsStore(file), file };
}

test('bindings: upsert/get/remove roundtrip', () => {
  const { store, file } = tmpStore();
  store.upsert({ key: 'm1:c1', sessionId: 's1', journalId: 'j1', updatedAt: 1 });
  assert.equal(store.get('m1:c1')?.sessionId, 's1');
  store.upsert({ key: 'm1:c1', sessionId: 's2', updatedAt: 2 }); // 同 key 覆写
  assert.equal(store.get('m1:c1')?.sessionId, 's2');
  assert.equal(store.all().length, 1);
  // 重开实例读回（落盘验证）
  const reopened = new ChannelsBindingsStore(file);
  assert.equal(reopened.get('m1:c1')?.sessionId, 's2');
  assert.equal(reopened.remove('m1:c1'), true);
  assert.equal(reopened.get('m1:c1'), undefined);
});

test('bindings: 坏档隔离为空库不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-bind-'));
  const file = path.join(dir, 'channels-bindings.json');
  fs.writeFileSync(file, 'not json', 'utf8');
  const store = new ChannelsBindingsStore(file);
  assert.deepEqual(store.all(), []);
});
