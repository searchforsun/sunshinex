import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createWorktree,
  detectIsolation,
  isDirty,
  isValidWorktreeName,
  readRegistry,
  removeWorktree,
  slugifyLabel,
  worktreesRoot,
} from './worktree';

const mktmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout ?? '').trim();
}

/** 真 git 仓（初始提交就绪）：git 集成用例一律临时仓内跑，不触用户真实仓 */
function makeRepo(): string {
  const root = mktmp('sunshinex-wt-repo-');
  git(root, '-c', 'init.defaultBranch=main', 'init', '-q');
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  git(root, '-c', 'user.email=t@local', '-c', 'user.name=t', 'add', '.');
  git(root, '-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

test('createWorktree：合法名建树 + 分支分叉 + 建树后 detectIsolation 为真', () => {
  const root = makeRepo();
  const dataDir = mktmp('sunshinex-wt-data-');
  const r = createWorktree(root, dataDir, 'demo', { sessionId: 'sess-1' });
  assert.ok(r.ok, `create failed: ${r.ok ? '' : r.error.message}`);
  if (!r.ok) return;
  const tree = path.join(worktreesRoot(dataDir), 'demo');
  assert.equal(r.value.path, tree);
  assert.equal(r.value.branch, 'worktree-demo');
  assert.ok(fs.existsSync(path.join(tree, 'README.md')), 'worktree 检出主仓文件');
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '主仓分支不受影响');
  assert.equal(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worktree-demo');
  assert.equal(detectIsolation(tree), true, '建树后 git-dir ≠ git-common-dir');
  assert.equal(detectIsolation(root), false, '主仓检测为假');
  const entry = readRegistry(dataDir).find((e) => e.name === 'demo');
  assert.ok(entry, 'registry 登记在场');
  assert.equal(entry.sessionId, 'sess-1');
  assert.equal(entry.branch, 'worktree-demo');
  assert.equal(entry.path, tree);
  assert.ok(entry.createdAt && !Number.isNaN(Date.parse(entry.createdAt)), 'createdAt 可解析');
  assert.equal(entry.keptReason, undefined);
});

test('createWorktree 错误码矩阵：EXISTS / INVALID_NAME / NOT_A_REPO / GIT_FAIL', () => {
  const root = makeRepo();
  const dataDir = mktmp('sunshinex-wt-data2-');
  assert.ok(createWorktree(root, dataDir, 'dup').ok);
  const dup = createWorktree(root, dataDir, 'dup');
  assert.ok(!dup.ok && dup.error.code === 'WORKTREE_EXISTS', '撞名已存在');
  for (const bad of ['Bad', 'with space', '..', '', 'a'.repeat(65), '-lead']) {
    const r = createWorktree(root, dataDir, bad);
    assert.ok(!r.ok && r.error.code === 'WORKTREE_INVALID_NAME', `expected INVALID_NAME for ${JSON.stringify(bad)}, got ${r.ok ? 'ok' : r.error.code}`);
  }
  const notRepo = mktmp('sunshinex-wt-plain-');
  const r = createWorktree(notRepo, mktmp('sunshinex-wt-data3-'), 'ok-name');
  assert.ok(!r.ok && r.error.code === 'WORKTREE_NOT_A_REPO', '非 git 仓');
  // unborn HEAD：是仓但无提交可分叉 → git worktree add 失败 → GIT_FAIL（stderr 截断附言）
  const unborn = mktmp('sunshinex-wt-unborn-');
  git(unborn, '-c', 'init.defaultBranch=main', 'init', '-q');
  const g = createWorktree(unborn, mktmp('sunshinex-wt-data4-'), 'ok-name');
  assert.ok(!g.ok && g.error.code === 'WORKTREE_GIT_FAIL', `expected GIT_FAIL, got ${g.ok ? 'ok' : g.error.code}`);
  assert.ok(g.error.message.length > 0, 'message 附 stderr 截断');
});

test('detectIsolation：submodule（superproject 非空）按普通仓处理', () => {
  const child = makeRepo();
  const parent = makeRepo();
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'sub');
  git(parent, '-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-q', '-m', 'add sub');
  assert.equal(detectIsolation(path.join(parent, 'sub')), false, 'submodule 不是 worktree（Step 0 护栏）');
});

test('removeWorktree：干净即删（含分支 + registry 移除）；脏即保留并记 keptReason', () => {
  const root = makeRepo();
  const dataDir = mktmp('sunshinex-wt-data5-');
  assert.ok(createWorktree(root, dataDir, 'clean').ok);
  const tree = path.join(worktreesRoot(dataDir), 'clean');
  const r = removeWorktree(root, dataDir, 'clean');
  assert.ok(r.ok && r.value === 'removed', `expected removed, got ${r.ok ? r.value : r.error.code}`);
  assert.ok(!fs.existsSync(tree), '树已删');
  const gone = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'worktree-clean']);
  assert.notEqual(gone.status, 0, '分支已删');
  assert.deepEqual(readRegistry(dataDir).map((e) => e.name), [], 'registry 条目移除');
  // 脏树：untracked 文件即 porcelain 非空
  assert.ok(createWorktree(root, dataDir, 'dirty').ok);
  const tree2 = path.join(worktreesRoot(dataDir), 'dirty');
  fs.writeFileSync(path.join(tree2, 'edit.txt'), 'wip\n');
  const r2 = removeWorktree(root, dataDir, 'dirty');
  assert.ok(r2.ok && r2.value === 'kept-dirty');
  assert.ok(fs.existsSync(tree2), '脏树保留');
  const reg = readRegistry(dataDir).find((e) => e.name === 'dirty');
  assert.equal(reg?.keptReason, 'dirty');
});

test('registry 读写：缺失容错为空表 + 损坏 JSON 重建不抛', () => {
  const dataDir = mktmp('sunshinex-wt-data6-');
  assert.deepEqual(readRegistry(dataDir), [], '文件缺失 → 空表');
  const file = path.join(worktreesRoot(dataDir), 'registry.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{oops');
  assert.deepEqual(readRegistry(dataDir), [], '损坏 → 重建空表不抛');
  assert.equal(fs.readFileSync(file, 'utf8'), '[]\n', '损坏文件已修复为空表');
});

test('slugifyLabel：非法折叠、连续归一、截断留随机尾位', () => {
  assert.equal(slugifyLabel('My Agent!'), 'my-agent');
  assert.equal(slugifyLabel('a  --  b'), 'a-b');
  assert.equal(slugifyLabel('___'), 'wt');
  assert.equal(slugifyLabel(''), 'wt');
  const long = slugifyLabel('x'.repeat(100));
  assert.ok(long.length <= 32, `截断留尾位: ${long.length}`);
  assert.match(long, /^[a-z0-9][a-z0-9-]*$/);
});

test('createWorktree：.sunshinex/settings.json 存在才拷（字节一致）且不致脏（规格 §6.3）', () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshinex', 'settings.json'), '{"mode":"manual"}\n');
  const dataDir = mktmp('sunshinex-wt-data7-');
  const r = createWorktree(root, dataDir, 'cfg');
  assert.ok(r.ok, `create failed: ${r.ok ? '' : r.error.message}`);
  if (!r.ok) return;
  assert.equal(r.value.copiedSettings, true, '拷贝事实如实上报');
  const tree = path.join(worktreesRoot(dataDir), 'cfg');
  assert.equal(
    fs.readFileSync(path.join(tree, '.sunshinex', 'settings.json'), 'utf8'),
    '{"mode":"manual"}\n',
    '字节一致',
  );
  assert.equal(isDirty(tree), false, '拷贝面经 worktree 本地 exclude 屏蔽，不记脏');
  const rootNoCfg = makeRepo(); // 独立无配置仓：验证「存在才拷」的缺省侧
  const r2 = createWorktree(rootNoCfg, dataDir, 'nocfg');
  assert.ok(r2.ok && r2.value.copiedSettings === false, '缺省不拷');
});

test('isDirty：porcelain 空 false / 非空 true / 非 git 仓 true（删除判据 fail-closed）', () => {
  const root = makeRepo();
  assert.equal(isDirty(root), false);
  fs.writeFileSync(path.join(root, 'u.txt'), 'x\n');
  assert.equal(isDirty(root), true, 'untracked 即脏');
  assert.equal(isDirty(mktmp('sunshinex-wt-plain2-')), true, 'git 失败按脏兜底');
});

test('isValidWorktreeName：语法边界（^/^[a-z0-9][a-z0-9-]{0,63}$/）', () => {
  assert.equal(isValidWorktreeName('a'), true);
  assert.equal(isValidWorktreeName('wt-01'), true);
  assert.equal(isValidWorktreeName('a'.repeat(64)), true);
  assert.equal(isValidWorktreeName('a'.repeat(65)), false);
  assert.equal(isValidWorktreeName('-a'), false);
  assert.equal(isValidWorktreeName('A'), false);
  assert.equal(isValidWorktreeName('a_b'), false);
  assert.equal(isValidWorktreeName(''), false);
});
