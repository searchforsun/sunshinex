import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMemoryPath } from './paths';

/**
 * 记忆路径分类器（规格 §4.1）纯判定用例：零 IO、零副作用。
 * 入参契约同 chain.resolveSafe：absPath 须为 realpath 归一后的绝对路径，此处只做前缀归类。
 * 断言面五组：主目录直属文件 / 非记忆路径（同前缀不同目录、目录本身、工作区路径）/ 子代理目录与 scope 收窄 /
 * 目录形态边界（memory/、agents/、agents/<id>/ 均非记录）/ dataDir 传参形态抖动。
 * 路径一律 path.join 构造（win32 兼容），不手拼分隔符。
 */

const dataDir = path.join(path.sep, 'data');

test('主记忆目录直属文件 → main', () => {
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memory', 'a.md')), 'main');
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memory', 'MEMORY.md')), 'main', '索引文件同属主记录面');
});

test('非记忆路径 → null（数据目录其它子树与工作区）', () => {
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'skills', 'a.md')), null);
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memory')), null, '目录本身不是记录');
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memoryx', 'a.md')), null, '同前缀不同目录不算');
  assert.equal(isMemoryPath(dataDir, path.join(path.sep, 'data-bak', 'memory', 'a.md')), null, '同级同名前缀不算');
  assert.equal(isMemoryPath(dataDir, path.join(path.sep, 'work', 'a.md')), null, '工作区路径不算');
});

test('子代理目录 → agents/<id>；scope 收窄后只放行自身', () => {
  const p = path.join(dataDir, 'memory', 'agents', 'reviewer', 'a.md');
  assert.equal(isMemoryPath(dataDir, p), 'agents/reviewer');
  assert.equal(isMemoryPath(dataDir, p, 'agents/reviewer'), 'agents/reviewer');
  assert.equal(isMemoryPath(dataDir, p, 'agents/other'), null);
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memory', 'a.md'), 'agents/reviewer'), null, 'scope 收窄时主目录被拒');
  assert.equal(
    isMemoryPath(dataDir, path.join(dataDir, 'memory', 'agents', 'other', 'a.md'), 'agents/reviewer'),
    null,
    'scope 收窄时其它子代理被拒',
  );
  assert.equal(
    isMemoryPath(dataDir, path.join(dataDir, 'memory', 'agents', 'other', 'a.md')),
    'agents/other',
    '无 scope 时按自身归属分类',
  );
  assert.equal(
    isMemoryPath(dataDir, path.join(dataDir, 'memory', 'agents', 'reviewer', 'nested', 'a.md')),
    'agents/reviewer',
    '子代理子树内嵌套仍归自身',
  );
});

test('目录本身（memory/、agents/、agents/<id>/）→ null', () => {
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memory')), null);
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memory', 'agents')), null, 'agents/ 目录本身不是记录');
  assert.equal(
    isMemoryPath(dataDir, path.join(dataDir, 'memory', 'agents', 'reviewer')),
    null,
    'agents/<id>/ 目录本身不是记录',
  );
  assert.equal(
    isMemoryPath(dataDir, path.join(dataDir, 'memory', 'agents', 'reviewer'), 'agents/reviewer'),
    null,
    'scope 命中也不放行目录本身',
  );
  assert.equal(
    isMemoryPath(dataDir, path.join(dataDir, 'memoryx', 'agents', 'reviewer', 'a.md')),
    null,
    '同前缀目录下的 agents 也不算',
  );
});

test('dataDir 传参形态（带尾分隔）不改变判定', () => {
  assert.equal(isMemoryPath(dataDir + path.sep, path.join(dataDir, 'memory', 'a.md')), 'main');
  assert.equal(
    isMemoryPath(dataDir + path.sep, path.join(dataDir, 'memory', 'agents', 'reviewer', 'a.md')),
    'agents/reviewer',
  );
});

test('两侧同归一：相对 dataDir 也命中（不再静默全拒）', () => {
  // 契约缺陷（2026-09-18 审查次要项）：原实现只归一 absPath、dataDir 走字面前缀，相对 dataDir 时判定恒 null。
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-paths-rel-'));
  const prevCwd = process.cwd();
  try {
    process.chdir(parent);
    assert.equal(isMemoryPath('.', path.join('.', 'memory', 'a.md')), 'main', 'dataDir 相对当前目录仍命中');
    assert.equal(
      isMemoryPath('.', path.join('.', 'memory', 'agents', 'reviewer', 'a.md')),
      'agents/reviewer',
      '相对形态下子代理归类不变',
    );
    assert.equal(isMemoryPath('.', path.join('.', 'memory', 'a.md'), 'agents/reviewer'), null, 'scope 收窄在相对形态下同样生效');
    assert.equal(isMemoryPath('.', path.join('memory', 'a.md')), 'main', '另一侧相对形态（无 ./ 前缀）同样归一');
    assert.equal(isMemoryPath('.', path.join('.', 'skills', 'a.md')), null, '相对形态下非记忆子树仍不命中');
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
