import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorktree, listWorktreeBranches, removeWorktreeForSession } from './worktree';
import { resolveDataDir } from '../config/data-dir';
import * as crypto from 'crypto';

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

test('listWorktreeBranches 占用清单 + createWorktree branch=签出既有/BRANCH_HELD + 数据目录重定向标记', () => {
  const root = mkRepo();
  const dataDir = resolveDataDir(root);
  const g = (...a: string[]): void => {
    execFileSync('git', ['-C', root, ...a], { stdio: 'ignore', windowsHide: true });
  };
  try {
    g('checkout', '-q', '-b', 'feature');
    g('checkout', '-q', 'main');
    // 占用清单:主工作区(main)在册
    const occ = listWorktreeBranches(root);
    assert.equal(occ.mainBranch, 'main');
    assert.ok(occ.occupied['main'], '主工作区分支在占用清单');
    assert.equal(occ.occupied['feature'], undefined, '未签出分支不在清单');

    // branch=自由既有分支 → 直签该分支(非 worktree- 前缀),签出后进占用清单
    const free = createWorktree(root, dataDir, 'sess-free', { branch: 'feature' });
    assert.equal(free.ok, true);
    if (!free.ok) return;
    assert.equal(free.value.branch, 'feature');
    assert.ok(listWorktreeBranches(root).occupied['feature'], 'feature 现被新树签出');

    // branch=已被其他 worktree 签出的分支 → BRANCH_HELD(2026-11-10 用户裁定「提示已被签出」)
    const held = createWorktree(root, dataDir, 'sess-held', { branch: 'feature' });
    assert.equal(held.ok, false);
    if (!held.ok) assert.equal(held.error.code, 'BRANCH_HELD');

    // 重定向标记:树 .git 文件 gitdir 指向主仓 .git/worktrees/<name>/,旁边标记主仓根
    const dotGit = fs.readFileSync(path.join(free.value.path, '.git'), 'utf8');
    const gitdir = /^gitdir:\s*(.+)$/m.exec(dotGit)![1]!.trim();
    const marker = fs.readFileSync(path.join(gitdir, 'sunshinex-mainroot'), 'utf8').trim();
    assert.equal(path.resolve(marker), path.resolve(root));
    assert.equal(resolveDataDir(free.value.path), resolveDataDir(root), '树数据目录改指主项目');

    // branch=不存在 → 按名新建并签出
    const made = createWorktree(root, dataDir, 'sess-newbr', { branch: 'brand-new' });
    assert.equal(made.ok, true);
    if (!made.ok) return;
    assert.equal(made.value.branch, 'brand-new');
    assert.ok(listWorktreeBranches(root).occupied['brand-new']);
    void crypto;
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
