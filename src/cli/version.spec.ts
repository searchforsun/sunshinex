import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const pkgDir = path.dirname(req.resolve('../../package.json'));
const pkg = req('../../package.json') as { version: string };
// 测试对象是编译产物（与 npm 安装副本同形态），先由 run-tests 全量构建保证 dist 新鲜
const entry = path.join(pkgDir, 'dist', 'cli', 'index.js');

function runCli(...args: string[]): string {
  return execFileSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
}

test('CLI：--version 打印 package.json 版本并退出', () => {
  const out = runCli('--version').trim();
  assert.equal(out, pkg.version);
});

test('CLI：-v 短旗等价 --version（短旗归一进 flags）', () => {
  const out = runCli('-v').trim();
  assert.equal(out, pkg.version);
});
