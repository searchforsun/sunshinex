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

test('FileStore 读到空文件/撕裂 JSON/坏内容返回 fallback 不抛错', () => {
  const dir = tmpdir();
  const store = new FileStore(dir);
  // 空文件：writeFileSync 截断瞬间被并发读者撞见的真实形态（Unexpected end of JSON input）
  fs.writeFileSync(path.join(dir, 'empty.json'), '');
  assert.deepEqual(store.read('empty', { n: -1 }), { n: -1 });
  // 撕裂 JSON：写入中途截断的半截内容
  fs.writeFileSync(path.join(dir, 'torn.json'), '{"runs": [1, 2');
  assert.deepEqual(store.read('torn', []), []);
  // 非 JSON 垃圾内容
  fs.writeFileSync(path.join(dir, 'garbage.json'), 'not json at all');
  assert.deepEqual(store.read('garbage', 'fb'), 'fb');
});

test('FileStore 写入为原子 rename：落盘内容完整可解析、无临时文件残留', () => {
  const dir = tmpdir();
  const store = new FileStore(dir);
  store.write('k', { big: 'x'.repeat(100_000) });
  const raw = fs.readFileSync(path.join(dir, 'k.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { big: 'x'.repeat(100_000) }, 'rename 落盘即完整内容');
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, '临时文件应随 rename 消费，不留残渣');
});
