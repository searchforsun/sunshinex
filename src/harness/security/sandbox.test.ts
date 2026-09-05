import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProcessSandbox } from './sandbox';
import { DryRun } from './dryrun';
import { ToolBackend } from '../../types';

test('ProcessSandbox 执行 echo 返回输出', async () => {
  const s = new ProcessSandbox();
  const r = await s.exec('echo hello');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.stdout, /hello/);
});

test('ProcessSandbox 执行不存在命令返回失败', async () => {
  const s = new ProcessSandbox();
  const r = await s.exec('nonexistent_cmd_xyz');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'EXEC_FAILED');
});

test('DryRun 预览返回原命令', () => {
  const d = new DryRun();
  assert.equal(d.preview('rm -rf /'), 'rm -rf /');
});

test('ProcessSandbox 是 ToolBackend（name=process，含文件三方法）', () => {
  const b: ToolBackend = new ProcessSandbox();
  assert.equal(b.name, 'process');
  assert.equal(typeof b.readFile, 'function');
  assert.equal(typeof b.writeFile, 'function');
  assert.equal(typeof b.listFiles, 'function');
});

test('writeFile/readFile 往返（含父目录自动创建）', () => {
  const b = new ProcessSandbox();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-1d-'));
  const file = path.join(dir, 'a/b/c.txt');
  b.writeFile(file, 'hello 1d');
  assert.equal(b.readFile(file), 'hello 1d');
});

test('listFiles glob 语义：** 跨目录段、跳过 node_modules', () => {
  const b = new ProcessSandbox();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-1d-glob-'));
  fs.mkdirSync(path.join(dir, 'sub/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'top.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'node_modules', 'skip.txt'), 'x');
  const rel = b.listFiles(dir, '**/*.txt').sort();
  assert.deepEqual(rel, ['sub/deep.txt', 'top.txt']);
});
