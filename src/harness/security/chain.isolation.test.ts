import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafetyChain } from './chain';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ProcessSandbox } from './sandbox';
import { DryRun } from './dryrun';

/** 隔离子链执行面判界（规格 2026-09-23-subagent-worktree-isolation §5/D6，对标 CC v2.1.203）：
 * withRoot 换根克隆携带 isolatedRoot 标记——三查仅隔离子链生效，主链与普通子链零介入 */

function chain(root: string, mode: 'manual' | 'dontAsk' = 'dontAsk'): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), mode), new ProcessSandbox(), new DryRun(), root);
}

function mktmp(p: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

test('withRoot 克隆：execCwd 锚专属树，原实例零突变', () => {
  const main = mktmp('iso-main-');
  const tree = mktmp('iso-tree-');
  const ch = chain(main);
  const child = ch.withRoot(tree);
  assert.equal(child.execCwd(), tree, '子链 cwd 锚树');
  assert.equal(ch.execCwd(), main, '原实例 cwd 不变');
});

test('隔离子链判界：cd 越树 / git 指针越树 / 环境赋值越树 → EXEC_OUT_OF_TREE', async () => {
  const main = mktmp('iso-main-');
  const tree = mktmp('iso-tree-');
  const child = chain(main).withRoot(tree);
  for (const cmd of [
    `cd ${main} && git status`,
    `git --git-dir=${main}/.git log`,
    `git --git-dir ${main}/.git log`,
    `git -C ${main} status`,
    `git -c core.worktree=${main} status`,
    `GIT_DIR=${main}/.git git log`,
    `GIT_WORK_TREE=${main} git status`,
    'echo $(git log)',
  ]) {
    const r = await child.run(cmd);
    assert.ok(!r.ok, `应拒绝：${cmd}`);
    assert.equal(r.ok ? '' : r.error.code, 'EXEC_OUT_OF_TREE');
    assert.match(r.ok ? '' : r.error.message, /isolated worktree/, `拒绝原因可读：${cmd}`);
  }
});

test('隔离子链：树内命令与普通命令放行', async () => {
  const main = mktmp('iso-main-');
  const tree = mktmp('iso-tree-');
  const git = (...args: string[]): void => {
    const r = spawnSync('git', ['-C', tree, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git init fixture failed: ${r.stderr}`);
  };
  git('init', '-q');
  const child = chain(main).withRoot(tree);
  const inTree = await child.run(`git -C ${tree} status`);
  assert.ok(inTree.ok, '树内 git 指针放行');
  const plain = await child.run('echo hi');
  assert.ok(plain.ok && plain.value.stdout.includes('hi'), '普通命令放行');
  const cdTree = await child.run(`cd ${tree} && git status`);
  assert.ok(cdTree.ok, 'cd 进树内放行');
});

test('主链与普通子链不受判界约束：跨树命令照常执行', async () => {
  const main = mktmp('iso-main-');
  const tree = mktmp('iso-tree-');
  spawnSync('git', ['-C', tree, 'init', '-q'], { encoding: 'utf8' });
  const mainChain = chain(main);
  const cross = await mainChain.run(`cd ${tree} && echo ok`);
  assert.ok(cross.ok, '主链无隔离标记，判界零介入');
  const plain = chain(main);
  const r = await plain.run(`git --git-dir=${tree}/.git rev-parse --absolute-git-dir`);
  assert.ok(r.ok, '非隔离子链同样零介入');
});
