import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorktree, removeWorktreeForSession } from './worktree';
import { resolveDataDir } from '../config/data-dir';

/** 会话删档连带清树(2026-11-10 用户裁定 worktree 会话随 DELETE 退役):
 *  createWorktree 建树 → removeWorktreeForSession(树路径) 按主仓 registry 反查清理;
 *  普通仓库根(非登记树)=not-worktree;脏树 kept-dirty 保护 */

function mkRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-wt-'));
  const g = (...a: string[]): void => {
    execFileSync('git', ['-C', root, ...a], { stdio: 'ignore', windowsHide: true });
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'TEST_user');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  return root;
}

test('removeWorktreeForSession:登记树清理;普通根 not-worktree;脏树 kept-dirty', () => {
  const root = mkRepo();
  const dataDir = resolveDataDir(root);
  try {
    const made = createWorktree(root, dataDir, 'sess-clean');
    assert.ok(made.ok);
    if (!made.ok) return;
    // 普通仓库根(主仓本身,不在登记表)→ not-worktree
    assert.deepEqual(removeWorktreeForSession(root), { kind: 'not-worktree' });
    // 干净登记树 → removed,目录消失
    assert.deepEqual(removeWorktreeForSession(made.value.path), { kind: 'removed' });
    assert.equal(fs.existsSync(made.value.path), false);
    // 脏树(未提交改动)→ kept-dirty,目录保留进登记表(keptReason)
    const dirty = createWorktree(root, dataDir, 'sess-dirty');
    assert.ok(dirty.ok);
    if (!dirty.ok) return;
    fs.writeFileSync(path.join(dirty.value.path, 'wip.txt'), 'uncommitted\n');
    assert.deepEqual(removeWorktreeForSession(dirty.value.path), { kind: 'kept-dirty' });
    assert.equal(fs.existsSync(dirty.value.path), true, '脏树保留不强删');
  } finally {
    try {
      execFileSync('git', ['-C', root, 'worktree', 'prune'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // 兜底
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(dataDir, 'worktrees'), { recursive: true, force: true });
  }
});
