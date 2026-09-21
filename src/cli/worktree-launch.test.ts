import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWorktreeLaunchRoot } from './worktree-launch';
import { usageText } from './index';
import type { CliArgs } from './index';
import { setLanguage, parseLanguage } from '../i18n';
import { createWorktree, worktreesRoot, readRegistry, detectIsolation } from '../harness/worktree';
import { Harness } from '../harness';
import type { ModelAdapter } from '../model/adapter';
import { runLoop } from './commands/run-loop';
import { runTui } from '../tui/entry';

/**
 * 入口一：--worktree 启动旗标（计划 T3，规格 §7/D5）：
 * 装配前解析（path.resolve(dir) 之后）→ createWorktree → root 替换为返回路径 → 既有装配链零改动全量继承；
 * 裸旗标自动名 `wt-` + 4 位随机（生成单点在 worktree.ts）；撞名 fail-fast WORKTREE_EXISTS；
 * 非 git 目录 fail-fast WORKTREE_NOT_A_REPO 不进装配（run 与 tui 两入口同口径）；
 * --continue 与 --worktree 互斥报错（规格 §7）；USAGE 增 --worktree[=<name>] 行。
 */

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout ?? '').trim();
}

function makeRepo(): string {
  const root = mktmp('sunshinex-t3-repo-');
  git(root, '-c', 'init.defaultBranch=main', 'init', '-q');
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  git(root, '-c', 'user.email=t@local', '-c', 'user.name=t', 'add', '.');
  git(root, '-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

/** env 钉扎骨架：数据目录重定向 + finally 逐项还原（沿 worktree-root.test.ts 先例） */
function withLaunch(fn: (tmp: string) => void | Promise<void>): Promise<void> {
  return (async () => {
    const tmp = mktmp('sunshinex-t3-launch-');
    const prev = process.env.SUNSHINEX_DATA_DIR;
    process.env.SUNSHINEX_DATA_DIR = tmp;
    try {
      await fn(tmp);
    } finally {
      if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
      else process.env.SUNSHINEX_DATA_DIR = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
}

function tuiArgs(positional: string[], flags: Record<string, string | boolean>): CliArgs {
  return { command: 'tui', positional, flags };
}

test('T3-1 裸 --worktree：自动名 wt-XXXX，root 替换为树路径且已隔离', () =>
  withLaunch((tmp) => {
    const repo = makeRepo();
    const root = resolveWorktreeLaunchRoot(tuiArgs([repo], { worktree: true }), repo);
    assert.notEqual(root, repo, 'root 应替换为 worktree 路径');
    assert.ok(root.startsWith(worktreesRoot(tmp) + path.sep), `应落在数据目录 worktrees 下：${root}`);
    assert.match(path.basename(root), /^wt-[a-z0-9]{4}$/, `自动名形态 wt-+4 位随机：${path.basename(root)}`);
    assert.equal(detectIsolation(root), true, '装配前树已建好（linked worktree）');
    const reg = readRegistry(tmp);
    assert.equal(reg.length, 1, '登记表恰一条');
    assert.equal(reg[0] && reg[0].branch, `worktree-${path.basename(root)}`);
  }));

test('T3-2 --worktree=<name>：指定名建树；撞名 fail-fast WORKTREE_EXISTS 不重建', () =>
  withLaunch((tmp) => {
    const repo = makeRepo();
    const root = resolveWorktreeLaunchRoot(tuiArgs([repo], { worktree: 'demo' }), repo);
    assert.equal(root, path.join(worktreesRoot(tmp), 'demo'));
    assert.equal(detectIsolation(root), true);
    assert.throws(() => resolveWorktreeLaunchRoot(tuiArgs([repo], { worktree: 'demo' }), repo), /WORKTREE_EXISTS/, '撞名应 fail-fast');
    assert.equal(readRegistry(tmp).length, 1, '撞名不产生第二条登记');
  }));

test('T3-3 非 git 目录：fail-fast WORKTREE_NOT_A_REPO 不建树', () =>
  withLaunch(() => {
    const dir = mktmp('sunshinex-t3-nogit-');
    try {
      assert.throws(() => resolveWorktreeLaunchRoot(tuiArgs([dir], { worktree: true }), dir), /WORKTREE_NOT_A_REPO/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

test('T3-4 --continue 与 --worktree 互斥：报错并双旗标提示（规格 §7）', () =>
  withLaunch(() => {
    const repo = makeRepo();
    assert.throws(
      () => resolveWorktreeLaunchRoot(tuiArgs([repo], { worktree: true, continue: true }), repo),
      (e: unknown) => e instanceof Error && e.message.includes('--continue') && e.message.includes('--worktree'),
    );
  }));

test('T3-5 无旗标恒等：root 原样返回、零建树零登记（既有行为逐字节保持）', () =>
  withLaunch((tmp) => {
    const repo = makeRepo();
    const root = resolveWorktreeLaunchRoot(tuiArgs([repo], {}), repo);
    assert.equal(root, repo);
    assert.equal(readRegistry(tmp).length, 0);
    assert.equal(fs.existsSync(worktreesRoot(tmp)), false, '未建 worktrees 目录');
  }));

test('T3-6 USAGE 增 --worktree[=<name>] 行（en/zh 双语在位）', () => {
  const prev = process.env.SUNSHINEX_LANGUAGE;
  try {
    setLanguage(parseLanguage('en'));
    assert.match(usageText(), /--worktree\[=<name>\]/, 'en USAGE 应含 --worktree[=<name>]');
    setLanguage(parseLanguage('zh'));
    assert.match(usageText(), /--worktree\[=<name>\]/, 'zh USAGE 应含 --worktree[=<name>]');
  } finally {
    setLanguage(parseLanguage(prev ?? 'en'));
  }
});

test('T3-7 run 入口接线：--worktree 非 git 目录 fail-fast 于装配前（不触模型）', () =>
  withLaunch(async () => {
    const dir = mktmp('sunshinex-t3-nogit-run-');
    try {
      await assert.rejects(
        runLoop({ command: 'run', positional: [dir], flags: { worktree: 'demo', goal: 'x' } }),
        /WORKTREE_NOT_A_REPO/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

test('T3-8 tui 入口接线：非 git fail-fast 与互斥报错均先于 TUI 装配', () =>
  withLaunch(async () => {
    const dir = mktmp('sunshinex-t3-nogit-tui-');
    try {
      await assert.rejects(runTui(tuiArgs([dir], { worktree: 'demo' })), /WORKTREE_NOT_A_REPO/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const repo = makeRepo();
    await assert.rejects(
      runTui(tuiArgs([repo], { worktree: true, continue: true })),
      (e: unknown) => e instanceof Error && e.message.includes('--continue'),
      '互斥报错应先于 SessionController/ink 装配',
    );
  }));

test('T6-N1 旗标会话首帧事实行=树路径且整场恒定（规格 §12 钉1；--worktree 装配等价形态）', () =>
  withLaunch((tmp) => {
    const repo = makeRepo();
    const root = resolveWorktreeLaunchRoot(tuiArgs([repo], { worktree: 'nail1' }), repo);
    assert.notEqual(root, repo, '旗标生效：root 应替换为树路径');
    // 旗标等价装配（D5）：树路径整体继承装配链，banner/事实行/沙箱 cwd 同源
    const prompts: string[] = [];
    const replies = [
      JSON.stringify({ tool: 'read', input: { path: 'README.md' } }),
      JSON.stringify({ done: true, reply: 'ok' }),
    ];
    let i = 0;
    const model: ModelAdapter = {
      provider: 'capture',
      async complete(prompt: string) {
        prompts.push(prompt);
        return replies[Math.min(i++, replies.length - 1)];
      },
    };
    const h = new Harness({ root, mode: 'dontAsk', model, learnSkills: false });
    return h.reactor.run({ goal: 'g' }, { maxSteps: 4 }).then((r) => {
      assert.equal(r.done, true);
      assert.equal(prompts.length, 2, `帧数应为 read/done=2：${prompts.length}`);
      const facts = prompts.map((p) => {
        const m = /Current working directory \(project root\): (.+)/.exec(p);
        assert.ok(m, `首帧应含工作目录事实行：${p.slice(0, 160)}`);
        return m[1]!.trim();
      });
      assert.equal(facts[0], root, `首帧事实行应为树路径：${facts[0]}`);
      assert.equal(new Set(facts).size, 1, '事实行整场逐字节不变');
      const reg = readRegistry(tmp);
      assert.equal(reg.length, 1, '旗标会话登记恰一条');
      assert.equal(reg[0] && reg[0].branch, 'worktree-nail1');
    });
  }));
