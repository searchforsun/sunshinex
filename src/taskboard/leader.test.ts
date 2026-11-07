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
  assert.deepEqual(valueImports, ['../taskboard/leader']);
  const leader = fs.readFileSync(path.join(root, 'taskboard', 'leader.ts'), 'utf8');
  assert.ok(!/^import /m.test(leader), 'leader.ts 必须零导入');
});
