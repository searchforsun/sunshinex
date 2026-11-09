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
