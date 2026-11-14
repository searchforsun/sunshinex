import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** session/entry 经 GUI chat-reducer 进浏览器包:它的值导入链必须零 Node 依赖(2026-11-08 vite 构建失败根因——
 *  LEADER_RECIPIENT 曾从 teammate.ts 导入,连带 fs/path/worktree 进入 GUI 包) */
test('session/entry 只从零依赖叶模块取 LEADER_RECIPIENT;leader.ts 无 import', () => {
  const root = path.join(__dirname, '..', '..', 'src');
  const entry = fs.readFileSync(path.join(root, 'session', 'entry.ts'), 'utf8');
  const valueImports = [...entry.matchAll(/^import (?!type )[^;]*from '([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(valueImports, ['../types', '../taskboard/leader', './wake']); // ../types 零依赖叶(artifactKey 值导入,2026-11-14 kind 化);./wake 唤醒标签常量单点(isQuietNotice 过滤端同源,2026-11-15 技术债轮)——两叶均浏览器包安全,下行钉保证
  const wake = fs.readFileSync(path.join(root, 'session', 'wake.ts'), 'utf8');
  assert.ok(!/^import (?!type )/m.test(wake), 'wake.ts 值导入必须为零(仅 type 导入),保浏览器包安全');
  const leader = fs.readFileSync(path.join(root, 'taskboard', 'leader.ts'), 'utf8');
  assert.ok(!/^import /m.test(leader), 'leader.ts 必须零导入');
});
