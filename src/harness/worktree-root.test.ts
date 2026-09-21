import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { DryRun } from './security/dryrun';
import { createWorktree, worktreesRoot, readRegistry } from './worktree';
import { Harness } from './index';
import { ScriptedAdapter } from '../model/adapter';
import { dataDirReal } from '../config/data-dir';
import { isWithin } from '../paths';

/**
 * 安全链活动 root 判定 + Harness 接缝（计划 T2，规格 §11/D6-D9）：
 * 判定序 = 记忆窄口 → 活动根命中放行 → 活动根在场主根写拒 → 既有 root 语义（活动根缺省时与今日逐字节一致）；
 * Harness `enterWorktree`/`exitWorktree`/`cleanupWorktrees` 三接缝引用不重建即生效；
 * fork 子 Reactor 工作目录事实经 `rootProvider` 锚活动根。
 * 范式：tmpdir 作 root、SUNSHINEX_DATA_DIR 重定向、finally 还原（沿 chain.datadir.test.ts 先例）；
 * git 集成用例一律临时仓内跑，不触用户真实仓（沿 worktree.test.ts 先例）。
 */

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout ?? '').trim();
}

/** 真 git 仓（初始提交就绪）：沿 worktree.test.ts makeRepo 先例 */
function makeRepo(): string {
  const root = mktmp('sunshinex-wtroot-repo-');
  git(root, '-c', 'init.defaultBranch=main', 'init', '-q');
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  git(root, '-c', 'user.email=t@local', '-c', 'user.name=t', 'add', '.');
  git(root, '-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

/** 链级用例骨架：SUNSHINEX_DATA_DIR 钉 tmp、记忆开关复位、finally 逐项还原 */
function withChain(fn: (chain: SafetyChain, root: string, tmp: string) => void): void {
  const tmp = mktmp('sunshinex-wtroot-chain-');
  const prevDataDir = process.env.SUNSHINEX_DATA_DIR;
  const prevAuto = process.env.SUNSHINEX_AUTO_MEMORY;
  process.env.SUNSHINEX_DATA_DIR = tmp;
  delete process.env.SUNSHINEX_AUTO_MEMORY; // 记忆总开关缺省开（窄口用例前置）
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'main.txt'), 'main\n');
    const chain = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
    fn(chain, root, tmp);
  } finally {
    if (prevDataDir === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevDataDir;
    if (prevAuto === undefined) delete process.env.SUNSHINEX_AUTO_MEMORY;
    else process.env.SUNSHINEX_AUTO_MEMORY = prevAuto;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 模拟 worktree 目录（链级判界只需目录存在；树的 git 生命周期归 T1 用例覆盖） */
function fakeTree(tmp: string): string {
  const tree = path.join(worktreesRoot(tmp), 'demo');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, 'tracked.txt'), 'tree\n');
  return tree;
}

test('T2-1 enterWorktree：活动根写放行且 safePath 锚活动根；主根写拒（回执提及 worktree）；exit 恢复', () => {
  withChain((chain, root, tmp) => {
    const tree = fakeTree(tmp);
    chain.enterWorktree(tree);

    const inTree = chain.evaluate('Write', { path: path.join(tree, 'new.txt') });
    assert.equal(inTree.allowed, true, `活动根内新建写应放行：${inTree.allowed ? '' : inTree.reason}`);
    if (inTree.allowed) assert.ok(inTree.safePath !== undefined && isWithin(tree, inTree.safePath), `safePath 应锚活动根：${String(inTree.safePath)}`);

    const inMain = chain.evaluate('Write', { path: path.join(root, 'app', 'main.txt') });
    assert.equal(inMain.allowed, false, '活动根在场：主根写应拒（界外语义）');
    assert.ok(
      !inMain.allowed && inMain.reason.includes('worktree'),
      `拒绝回执应提及 worktree 会话：${!inMain.allowed ? inMain.reason : ''}`,
    );

    chain.exitWorktree();
    const backMain = chain.evaluate('Write', { path: path.join(root, 'app', 'main.txt') });
    assert.equal(backMain.allowed, true, 'exit 后恢复既有语义（root 内写放行）');
    const backTree = chain.evaluate('Write', { path: path.join(tree, 'new.txt') });
    assert.equal(backTree.allowed, false, 'exit 后 worktree 内写恢复越界拒');
  });
});

test('T2-2 读面恒开放：活动根在场主根与活动根均可读；缺省态与既有语义逐字节一致', () => {
  withChain((chain, root, tmp) => {
    const tree = fakeTree(tmp);
    // 缺省基线：root 外且 dataDir 外的路径读拒，拒绝文案既定
    const external = path.join(path.dirname(tmp), 'unrelated-outside.txt');
    const baseRead = chain.evaluate('Read', { path: external });
    assert.equal(baseRead.allowed, false, '缺省基线：外部路径读拒');
    const baseReason = !baseRead.allowed ? baseRead.reason : '';
    assert.equal(chain.evaluate('Read', { path: path.join(root, 'app', 'main.txt') }).allowed, true, '缺省基线：主根读放行');

    chain.enterWorktree(tree);
    assert.equal(chain.evaluate('Read', { path: path.join(tree, 'tracked.txt') }).allowed, true, '活动根读放行');
    const mainRead = chain.evaluate('Read', { path: path.join(root, 'app', 'main.txt') });
    assert.equal(mainRead.allowed, true, '读面恒开放：活动根在场主根仍可读（规格 §11 对比审查语义）');
    const extRead = chain.evaluate('Read', { path: external });
    assert.equal(extRead.allowed, false, '活动根在场：真正外部路径仍拒');
    assert.equal(!extRead.allowed ? extRead.reason : '', baseReason, '拒绝文案与缺省态逐字节一致（零漂移）');
    chain.exitWorktree();

    assert.equal(chain.evaluate('Read', { path: path.join(root, 'app', 'main.txt') }).allowed, true, 'exit 后读语义复原');
  });
});

test('T2-3 记忆写窄口先于活动根判定：activeRoot 在场记忆路径定性不变；dataDir 非记忆子树写仍拒', () => {
  withChain((chain, root, tmp) => {
    const tree = fakeTree(tmp);
    chain.enterWorktree(tree);

    // 记忆窄口（2026-09-18 审查裁决序）先于活动根判定：命中 memory/** 即按记忆语义定论
    const mem = path.join(dataDirReal(root), 'memory', 'notes.md');
    const dMem = chain.evaluate('Write', { path: mem });
    assert.equal(dMem.allowed, true, `activeRoot 在场不改变记忆写定性（总开关开、scope 内）：${dMem.allowed ? '' : dMem.reason}`);

    // dataDir 非记忆子树写仍拒：活动根不放大 dataDir 写面
    const nonMem = path.join(dataDirReal(root), 'tool-outputs', 'x.bin');
    const dNon = chain.evaluate('Write', { path: nonMem });
    assert.equal(dNon.allowed, false, 'dataDir 非记忆子树写仍拒（活动根不放大写面）');
  });
});

test('T2-4 Harness 接缝：enter/exit 引用不重建即生效；activeRoot 只读访问器缺省 undefined', async () => {
  const tmp = mktmp('sunshinex-wtroot-harness-');
  const prev = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const repo = makeRepo();
    const h = new Harness({ root: repo, mode: 'dontAsk', model: new ScriptedAdapter([]), learnSkills: false });
    assert.equal(h.activeRoot, null, '缺省无活动根');

    const created = createWorktree(repo, tmp, 'sess', { sessionId: 's-1' });
    assert.ok(created.ok, `createWorktree 失败：${created.ok ? '' : created.error.message}`);
    if (!created.ok) return;
    const tree = created.value.path;

    const safetyRef = h.safety;
    const runnerRef = h.runner;
    h.enterWorktree(tree);
    assert.equal(h.activeRoot, tree, 'enter 后活动根即位');
    assert.equal(h.safety, safetyRef, 'safety 引用不重建即生效');
    assert.equal(h.runner, runnerRef, 'runner 引用不重建');
    assert.equal(h.safety.evaluate('Write', { path: path.join(tree, 'n.txt') }).allowed, true, '同一链实例切换即生效：活动根内写放行');
    assert.equal(h.safety.evaluate('Write', { path: path.join(repo, 'm.txt') }).allowed, false, '同一链实例：主根写拒');

    h.exitWorktree();
    assert.equal(h.activeRoot, null, 'exit 后活动根复位');
    assert.equal(h.safety.evaluate('Write', { path: path.join(repo, 'm.txt') }).allowed, true, 'exit 后恢复既有语义');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T2-5 fork 工作目录事实=活动根（rootProvider）；cleanupWorktrees 只清本实例树、脏树留 keptReason', async () => {
  const tmp = mktmp('sunshinex-wtroot-cleanup-');
  const prev = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const repo = makeRepo();
    // 捕获桩：子 Reactor 首帧 complete 的 prompt 含工作目录事实行（reactor 两处 'Current working directory (project root)'）
    let childPrompt = '';
    const model = {
      provider: 'capture',
      async complete(prompt: string) {
        childPrompt = prompt;
        return JSON.stringify({ done: true, reply: 'child done' });
      },
    };
    const h = new Harness({ root: repo, mode: 'dontAsk', model, learnSkills: false });

    const own = createWorktree(repo, tmp, 'own', {});
    const foreign = createWorktree(repo, tmp, 'foreign', {});
    assert.ok(own.ok, `own 创建失败：${own.ok ? '' : own.error.message}`);
    assert.ok(foreign.ok, `foreign 创建失败：${foreign.ok ? '' : foreign.error.message}`);
    if (!own.ok || !foreign.ok) return;

    h.enterWorktree(own.value.path);
    // fork 工作目录事实：Runner 经 rootProvider 取活动根装配子 Reactor（deps.rootProvider?.() ?? deps.root）
    h.runner.attachParent(() => ({ maxSteps: 5, tokenCap: 100_000 }));
    const r = await h.runner.runSubagent({ prompt: 'child task', label: 'w' });
    assert.ok(r.ok, `fork 应完成：${r.ok ? '' : r.error.message}`);
    assert.ok(
      childPrompt.includes(`(project root): ${own.value.path}`),
      `fork 首帧工作目录应锚活动根（rootProvider）；实际片段：${childPrompt.slice(0, 200)}`,
    );
    h.exitWorktree();

    // cleanup：仅本实例进入过的树；干净删（登记移除）、脏留（keptReason）
    h.cleanupWorktrees();
    let reg = readRegistry(tmp);
    assert.ok(!reg.some((e) => e.name === 'own'), '本实例干净树应被清理（登记移除）');
    assert.ok(!fs.existsSync(path.join(worktreesRoot(tmp), 'own')), '本实例干净树目录应删除');
    assert.ok(reg.some((e) => e.name === 'foreign'), '非本实例树登记不动');
    assert.ok(fs.existsSync(path.join(worktreesRoot(tmp), 'foreign')), '非本实例树目录保留');

    const messy = createWorktree(repo, tmp, 'messy', {});
    assert.ok(messy.ok, `messy 创建失败：${messy.ok ? '' : messy.error.message}`);
    if (!messy.ok) return;
    // 实例归属登记（T4 起 create→enter 接线后自动成立）：本会话创建即经 enterWorktree 进清理范围
    h.enterWorktree(messy.value.path);
    h.exitWorktree();
    fs.writeFileSync(path.join(worktreesRoot(tmp), 'messy', 'extra.txt'), 'x\n');
    h.cleanupWorktrees();
    reg = readRegistry(tmp);
    const kept = reg.find((e) => e.name === 'messy');
    assert.ok(kept, '脏树应保留登记');
    assert.equal(kept && kept.keptReason, 'dirty', '脏树 keptReason=dirty');
    assert.ok(fs.existsSync(path.join(worktreesRoot(tmp), 'messy')), '脏树目录保留待清扫');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
