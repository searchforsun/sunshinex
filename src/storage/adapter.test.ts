import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStore } from './adapter';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-store-'));
}

test('FileStore 写入后可读取', () => {
  const dir = tmpdir();
  const store = new FileStore(dir);
  store.write('k', { a: 1 });
  assert.deepEqual(store.read('k', null), { a: 1 });
});

test('FileStore 未写入时返回 fallback', () => {
  const dir = tmpdir();
  const store = new FileStore(dir);
  assert.equal(store.read('missing', 'fb'), 'fb');
});
