import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PerceptionEngine } from './perception';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-perc-'));
}

test('scan 收集目录下文件', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.ts'), '');
  fs.writeFileSync(path.join(dir, 'b.json'), '');
  const p = new PerceptionEngine(dir).scan();
  assert.ok(p.files.includes('a.ts'));
  assert.ok(p.files.includes('b.json'));
});

test('无 package.json 时 dependencies 为空数组（降级）', () => {
  const dir = tmpdir();
  const p = new PerceptionEngine(dir).scan();
  assert.deepEqual(p.dependencies, []);
});
