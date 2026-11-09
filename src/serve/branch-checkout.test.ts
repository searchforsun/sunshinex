import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkoutBranch, gitBranches } from './session-changes';

/** 分支切换/新建(欢迎页分支弹窗:筛选行「+」新建并切换,2026-11-09 用户裁定) */
function mkRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-branch-'));
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

test('checkoutBranch create=true:新建并切换;同名再建被 git 拒;非法名先验拒;create 缺省只切不建', async () => {
  const root = mkRepo();
  try {
    const made = await checkoutBranch(root, 'feat/new-x', true);
    assert.equal(made.ok, true);
    const after = await gitBranches(root);
    assert.equal(after.current, 'feat/new-x', '新建后即为当前分支');
    assert.ok(after.branches.includes('feat/new-x'));
    const dup = await checkoutBranch(root, 'feat/new-x', true);
    assert.equal(dup.ok, false, '同名分支已存在:git checkout -b 拒');
    const bad = await checkoutBranch(root, '-oops', true);
    assert.equal(bad.ok, false, '以 - 起头的名字先验拒(防参数注入)');
    const missing = await checkoutBranch(root, 'nope-not-here');
    assert.equal(missing.ok, false, 'create 缺省:不存在的分支只切不建');
    const back = await checkoutBranch(root, 'main');
    assert.equal(back.ok, true);
    assert.equal((await gitBranches(root)).current, 'main');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('两区清单+暂存/取消暂存/丢弃未暂存/只提交暂存(审查页两区,2026-11-09)', async () => {
  const { listChanges, stageChanges, unstageChanges, discardUnstaged, commitChanges, changeContent } = await import('./session-changes');
  const root = mkRepo();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\ny\n'); // 已跟踪改动
    fs.writeFileSync(path.join(root, 'new.txt'), 'n\n'); // untracked
    let l = await listChanges(root);
    assert.ok(l.ok);
    if (!l.ok) return;
    assert.deepEqual(l.value.staged?.map((f) => f.path), []);
    assert.deepEqual(l.value.unstaged?.map((f) => f.path).sort(), ['a.txt', 'new.txt']);
    assert.ok((await stageChanges(root, ['a.txt'])).ok);
    l = await listChanges(root);
    if (!l.ok) return;
    assert.deepEqual(l.value.staged?.map((f) => f.path), ['a.txt'], '单文件暂存进已暂存区');
    assert.deepEqual(l.value.unstaged?.map((f) => f.path), ['new.txt']);
    const sc = await changeContent(root, 'a.txt', 'staged');
    assert.ok(sc.ok && sc.value.oldContent === 'x\n' && sc.value.newContent === 'x\ny\n', 'staged 区 diff=HEAD 对暂存区');
    assert.ok((await unstageChanges(root)).ok);
    l = await listChanges(root);
    if (!l.ok) return;
    assert.deepEqual(l.value.staged?.map((f) => f.path), [], '取消暂存:暂存区清空');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x\ny\n', '取消暂存不丢工作区改动');
    assert.ok((await stageChanges(root, ['a.txt'])).ok);
    const c = await commitChanges(root, 'TEST_ staged only', true);
    assert.ok(c.ok);
    l = await listChanges(root);
    if (!l.ok) return;
    assert.deepEqual(l.value.unstaged?.map((f) => f.path), ['new.txt'], '只提交暂存:untracked 不被顺带提交');
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    assert.ok((await discardUnstaged(root)).ok);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x\ny\n', '丢弃未暂存:回暂存区版本');
    assert.equal(fs.existsSync(path.join(root, 'new.txt')), false, '丢弃未暂存:untracked 删除');
    assert.equal((await stageChanges(root, ['../outside'])).ok, false, '越根路径拒');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('切分支被未提交改动阻断=DIRTY_TREE;commitAndCheckout 先提交再切换', async () => {
  const { commitAndCheckout } = await import('./session-changes');
  const root = mkRepo();
  const g = (...a: string[]): void => {
    execFileSync('git', ['-C', root, ...a], { stdio: 'ignore', windowsHide: true });
  };
  try {
    g('checkout', '-q', '-b', 'other');
    fs.writeFileSync(path.join(root, 'a.txt'), 'other-version\n');
    g('commit', '-q', '-am', 'other');
    g('checkout', '-q', 'main');
    fs.writeFileSync(path.join(root, 'a.txt'), 'dirty-local\n');
    const r = await checkoutBranch(root, 'other');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'DIRTY_TREE');
    const c = await commitAndCheckout(root, 'other', false, 'TEST_ wip before switch');
    assert.equal(c.ok, true);
    assert.equal((await gitBranches(root)).current, 'other');
    g('checkout', '-q', 'main');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'dirty-local\n', '切走前的改动已提交在原分支');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
