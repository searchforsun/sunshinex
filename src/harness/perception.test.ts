import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PerceptionEngine, SCAN_SKIP_DIRS } from './perception';

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

test('scan 跳过工具链与运行时产物目录（含 .superpowers 过程物料）', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'src.ts'), '');
  const skips = ['.pnpm-store', 'node_modules', '.data', '.longtask', '.superpowers'];
  for (const skip of skips) {
    fs.mkdirSync(path.join(dir, skip, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(dir, skip, 'inner', 'artifact.bin'), '');
  }
  const p = new PerceptionEngine(dir).scan();
  assert.ok(p.files.includes('src.ts'));
  for (const skip of skips) {
    assert.ok(!p.files.some((f) => f.includes(skip + '/')), `${skip} 应被跳过`);
  }
});

test('SCAN_SKIP_DIRS 与仓库 .gitignore 目录条目绑定（防双源漂移锚点）', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8');
  const gitDirs = gi
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && l.endsWith('/'))
    .map((l) => l.replace(/\/+$/, ''));
  assert.ok(gitDirs.length >= 6, '.gitignore 应解析出目录条目（防读到空文件假绿）');
  for (const d of gitDirs) {
    assert.ok(SCAN_SKIP_DIRS.has(d), `.gitignore 目录条目 ${d}/ 未纳入感知跳过集——请同步 SCAN_SKIP_DIRS`);
  }
  assert.ok(SCAN_SKIP_DIRS.has('.git'), '.git 恒不入感知');
});
