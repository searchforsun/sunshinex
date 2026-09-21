import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { readRegistry, worktreesRoot } from './worktree';
import type { ModelAdapter } from '../model/adapter';

/**
 * 入口三：子代理 isolation: worktree（计划 T5，规格 §9/D9）：
 * 双通道——agent.md frontmatter `isolation: worktree` 与 spawn 入参 `isolation?: 'worktree'`（内联临时子代理同样可用）；
 * 专属树名 `subagent-<净化label>-<4位随机>`，分支沿 §6.1 统一规则 `worktree-<name>`；
 * fork 子 Reactor 工作目录事实=专属树；收口：porcelain 空→自动删（含分支）、有改动→保留 + keptReason + 结论行附树路径；
 * 建树失败 fail-bounded（失败补丁行回链，父任务不炸）；并行批多个 isolation 子代理互不撞名；
 * 回归钉：未声明 isolation 的 spawn 行为零变化。
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
  const root = mktmp('sunshinex-t5-repo-');
  git(root, '-c', 'init.defaultBranch=main', 'init', '-q');
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  git(root, '-c', 'user.email=t@local', '-c', 'user.name=t', 'add', '.');
  git(root, '-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

/** env 钉扎骨架：数据目录重定向 + finally 逐项还原 */
function withIso(fn: (tmp: string) => void | Promise<void>): Promise<void> {
  return (async () => {
    const tmp = mktmp('sunshinex-t5-iso-');
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

/** cwd 事实行提取（fork 首帧系统事实行） */
function cwdOf(prompt: string): string {
  const m = /Current working directory \(project root\): (.+)/.exec(prompt);
  assert.ok(m, `首帧应含工作目录事实行：${prompt.slice(0, 160)}`);
  return m[1]!.trim();
}

test('T5-1 frontmatter isolation: worktree → fork 前建专属树，子 Reactor 工作目录=树；干净收口自动删', () =>
  withIso((tmp) => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'agents', 'isow'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'agents', 'isow', 'agent.md'),
      '---\nname: Iso Worker\ndescription: isolation probe agent\nisolation: worktree\n---\nDo isolated work.',
    );
    const prompts: string[] = [];
    const model: ModelAdapter = {
      provider: 'capture',
      async complete(prompt: string) {
        prompts.push(prompt);
        if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { agent_id: 'isow', label: 'iso' } });
        return JSON.stringify({ done: true, reply: 'isolation child done' });
      },
    };
    const h = new Harness({ root: repo, mode: 'dontAsk', model, learnSkills: false });
    return h.reactor.run({ goal: 'g' }, { maxSteps: 6 }).then((r) => {
      assert.equal(r.done, true, `run 应完成：${String(r.stopReason ?? '')}`);
      assert.equal(prompts.length, 3, `帧数应为 父/子/父=3：${prompts.length}`);
      const childCwd = cwdOf(prompts[1]!);
      assert.notEqual(childCwd, repo, '子 Reactor 工作目录不得是主根');
      assert.ok(childCwd.startsWith(worktreesRoot(tmp) + path.sep), `应落在数据目录 worktrees 下：${childCwd}`);
      assert.match(path.basename(childCwd), /^subagent-iso-[a-z0-9]{4}$/, `专属树名形态：${path.basename(childCwd)}`);
      assert.equal(fs.existsSync(childCwd), false, '干净收口应自动删树');
      assert.equal(readRegistry(tmp).length, 0, '干净收口登记应移除');
      const chain = h.context.chainView();
      assert.ok(chain.some((s) => s.action === 'node' && s.observation.startsWith('[iso] ') && s.observation.includes('isolation child done')), '结论行应回链');
    });
  }));

test('T5-2 入参通道：普通 agent + spawn 入参 isolation=worktree 同样派生专属树', () =>
  withIso((tmp) => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'agents', 'plain'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'agents', 'plain', 'agent.md'), '---\nname: Plain\ndescription: no isolation declared\n---\nJust work.');
    const prompts: string[] = [];
    const model: ModelAdapter = {
      provider: 'capture',
      async complete(prompt: string) {
        prompts.push(prompt);
        if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { agent_id: 'plain', label: 'ovr', isolation: 'worktree' } });
        return JSON.stringify({ done: true, reply: 'ovr child done' });
      },
    };
    const h = new Harness({ root: repo, mode: 'dontAsk', model, learnSkills: false });
    return h.reactor.run({ goal: 'g' }, { maxSteps: 6 }).then((r) => {
      assert.equal(r.done, true);
      const childCwd = cwdOf(prompts[1]!);
      assert.match(path.basename(childCwd), /^subagent-ovr-[a-z0-9]{4}$/, `入参通道应派生专属树：${childCwd}`);
      assert.equal(fs.existsSync(childCwd), false, '干净收口自动删');
      assert.equal(readRegistry(tmp).length, 0);
    });
  }));

test('T5-3 收口：子代理有改动 → 树保留 + keptReason + 结论行附树路径', () =>
  withIso((tmp) => {
    const repo = makeRepo();
    const prompts: string[] = [];
    const model: ModelAdapter = {
      provider: 'capture',
      async complete(prompt: string) {
        prompts.push(prompt);
        if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { prompt: 'Child B task: leave a trace', label: 'dirtyw', isolation: 'worktree' } });
        if (prompts.length === 2) return JSON.stringify({ tool: 'write', input: { path: 'work.txt', content: 'trace\n' } });
        return JSON.stringify({ done: true, reply: 'dirty child done' });
      },
    };
    const h = new Harness({ root: repo, mode: 'dontAsk', model, learnSkills: false });
    return h.reactor.run({ goal: 'g' }, { maxSteps: 8 }).then((r) => {
      assert.equal(r.done, true, `run 应完成：${String(r.stopReason ?? '')}`);
      const childCwd = cwdOf(prompts[1]!);
      assert.ok(fs.existsSync(path.join(childCwd, 'work.txt')), '子代理写应落在专属树内');
      assert.ok(!fs.existsSync(path.join(repo, 'work.txt')), '子代理写不得落主根');
      const reg = readRegistry(tmp);
      const kept = reg.find((e) => e.name === path.basename(childCwd));
      assert.ok(kept, `脏树应保留登记：${JSON.stringify(reg)}`);
      assert.equal(kept && kept.keptReason, 'dirty', '登记应标 keptReason=dirty');
      assert.equal(kept && kept.branch, `worktree-${kept.name}`, '分支沿 §6.1 统一规则');
      const chain = h.context.chainView();
      assert.ok(
        chain.some((s) => (s.action === 'node' || s.action === 'note') && s.observation.includes(childCwd)),
        `结论/补丁行应附树路径：${JSON.stringify(chain.filter((s) => s.action === 'node' || s.action === 'note').map((s) => s.observation.slice(0, 80)))}`,
      );
    });
  }));

test('T5-4 fail-bounded：非 git 根建树失败 → 失败补丁行回链、父任务不炸；并行批两棵树互不撞名', () =>
  withIso(async (tmp) => {
    // 4a：非 git 根 → WORKTREE_NOT_A_REPO fail-bounded
    const plain = mktmp('sunshinex-t5-nogit-');
    try {
      const promptsA: string[] = [];
      const modelA: ModelAdapter = {
        provider: 'capture',
        async complete(prompt: string) {
          promptsA.push(prompt);
          if (promptsA.length === 1) return JSON.stringify({ tool: 'spawn', input: { agent_id: 'plain', label: 'fb', isolation: 'worktree' } });
          return JSON.stringify({ done: true, reply: 'parent survived' });
        },
      };
      fs.mkdirSync(path.join(plain, 'agents', 'plain'), { recursive: true });
      fs.writeFileSync(path.join(plain, 'agents', 'plain', 'agent.md'), '---\nname: Plain\ndescription: no isolation\n---\nwork.');
      const h = new Harness({ root: plain, mode: 'dontAsk', model: modelA, learnSkills: false });
      const r = await h.reactor.run({ goal: 'g' }, { maxSteps: 6 });
      assert.equal(r.done, true, '父任务不炸：run 应完成');
      const chain = h.context.chainView();
      assert.ok(
        chain.some((s) => s.observation.includes('fb') && /WORKTREE_(NOT_A_REPO|GIT_FAIL|EXISTS|INVALID_NAME)/.test(s.observation)),
        `失败补丁行应回链且含错误码：${JSON.stringify(chain.map((s) => s.observation.slice(0, 80)))}`,
      );
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    // 4b：并行批两棵树互不撞名
    const repo = makeRepo();
    const prompts: string[] = [];
    const model: ModelAdapter = {
      provider: 'capture',
      async complete(prompt: string) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return JSON.stringify({
            tools: [
              { tool: 'spawn', input: { prompt: 'Child A task', label: 'pa', isolation: 'worktree' } },
              { tool: 'spawn', input: { prompt: 'Child B task', label: 'pb', isolation: 'worktree' } },
            ],
          });
        }
        if (prompt.includes('Child A task')) return JSON.stringify({ done: true, reply: 'pa done' });
        if (prompt.includes('Child B task')) return JSON.stringify({ done: true, reply: 'pb done' });
        return JSON.stringify({ done: true, reply: 'parent done' });
      },
    };
    const h = new Harness({ root: repo, mode: 'dontAsk', model, learnSkills: false });
    const r = await h.reactor.run({ goal: 'g' }, { maxSteps: 8 });
    assert.equal(r.done, true);
    const cwdA = cwdOf(prompts.find((p) => p.includes('Child A task'))!);
    const cwdB = cwdOf(prompts.find((p) => p.includes('Child B task'))!);
    assert.notEqual(cwdA, cwdB, '并行批两棵专属树不得撞名');
    assert.match(path.basename(cwdA), /^subagent-pa-[a-z0-9]{4}$/);
    assert.match(path.basename(cwdB), /^subagent-pb-[a-z0-9]{4}$/);
    assert.equal(readRegistry(tmp).length, 0, '双双干净收口');
  }));

test('T5-5 回归钉：未声明 isolation 的 spawn 行为零变化（无树、cwd=主根、结论行原样）', () =>
  withIso((tmp) => {
    const repo = makeRepo();
    const prompts: string[] = [];
    const model: ModelAdapter = {
      provider: 'capture',
      async complete(prompt: string) {
        prompts.push(prompt);
        if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { prompt: 'plain child task', label: 'p0' } });
        return JSON.stringify({ done: true, reply: 'plain child done' });
      },
    };
    const h = new Harness({ root: repo, mode: 'dontAsk', model, learnSkills: false });
    return h.reactor.run({ goal: 'g' }, { maxSteps: 6 }).then((r) => {
      assert.equal(r.done, true);
      assert.equal(cwdOf(prompts[1]!), repo, 'fork 工作目录仍=主根（rootProvider 缺省链路）');
      assert.equal(fs.existsSync(worktreesRoot(tmp)), false, '零建树');
      assert.equal(readRegistry(tmp).length, 0, '零登记');
      const chain = h.context.chainView();
      assert.ok(chain.some((s) => s.action === 'node' && s.observation.startsWith('[p0] ') && s.observation.includes('plain child done')), '结论行原样');
    });
  }));
