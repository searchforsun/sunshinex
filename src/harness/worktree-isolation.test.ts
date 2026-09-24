import { textReplyToChatFace } from '../model/chat-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { AgentRegistry, SubagentRunner } from './subagent';
import { readRegistry, worktreesRoot } from './worktree';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { DryRun } from './security/dryrun';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';

/**
 * 子代理 worktree 隔离（规格 2026-09-23-subagent-worktree-isolation，对标 Claude Code）：
 * 程序化建树/收口（D1/D4）、双通道声明（D2）、无 Git 静默兜底（D3）、HEAD 分叉（D5）、执行面判界（D6）。
 * 树名 `subagent-<slug>-<4位随机>`，分支 `worktree-<name>`；fork 子 Reactor 工作目录事实=专属树；
 * 干净树自动删（零链行）、脏树保留 + 补丁行附路径；非仓/缺根静默降级主工作区执行；建树失败 fail-bounded。
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

/** unborn HEAD：是仓但无提交（建树应 WORKTREE_GIT_FAIL，非 NOT_A_REPO） */
function makeUnbornRepo(): string {
  const root = mktmp('sunshinex-t5-unborn-');
  git(root, '-c', 'init.defaultBranch=main', 'init', '-q');
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

test('T5-1 frontmatter 声明 → 建树执行、干净树自动删且零 note 行', () =>
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
      chat: textReplyToChatFace(async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { agent_id: 'isow', label: 'iso' } });
        if (prompt.includes('Do isolated work')) return JSON.stringify({ done: true, reply: 'tree child done' });
        return JSON.stringify({ done: true, reply: 'parent done' });
      }),
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
      assert.ok(chain.some((s) => s.action === 'node' && s.observation.startsWith('[iso] ') && s.observation.includes('tree child done')), '结论行应回链');
      assert.equal(chain.some((s) => s.observation.includes('kept for inspection') || s.observation.includes('isolation failed')), false, '干净收口零 note 行');
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
      chat: textReplyToChatFace(async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { agent_id: 'plain', label: 'ovr', isolation: 'worktree' } });
        return JSON.stringify({ done: true, reply: 'parent done' });
      }),
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

test('T5-3 收口：子代理有改动 → 树保留 + keptReason=dirty + 补丁行附树路径', () =>
  withIso((tmp) => {
    const repo = makeRepo();
    const prompts: string[] = [];
    const model: ModelAdapter = {
      provider: 'capture',
      chat: textReplyToChatFace(async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { prompt: 'Child dirty task: leave a trace', label: 'dirtyw', isolation: 'worktree' } });
        if (prompt.includes('Child dirty task')) {
          if (prompts.length === 2) return JSON.stringify({ tool: 'write', input: { path: 'work.txt', content: 'trace\n' } });
          return JSON.stringify({ done: true, reply: 'dirty child done' });
        }
        return JSON.stringify({ done: true, reply: 'parent done' });
      }),
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
      assert.equal(kept && kept.branch, `worktree-${kept.name}`, '分支沿统一规则');
      const chain = h.context.chainView();
      assert.ok(
        chain.some((s) => (s.action === 'node' || s.action === 'note') && s.observation.includes(childCwd)),
        `结论/补丁行应附树路径：${JSON.stringify(chain.filter((s) => s.action === 'node' || s.action === 'note').map((s) => s.observation.slice(0, 80)))}`,
      );
    });
  }));

test('T5-4 非 git 仓 → 静默兜底：不建树、零 note、主工作区正常执行', () =>
  withIso((tmp) => {
    const plain = mktmp('sunshinex-t5-nogit-');
    try {
      const prompts: string[] = [];
      const model: ModelAdapter = {
        provider: 'capture',
        chat: textReplyToChatFace(async (prompt: string) => {
          prompts.push(prompt);
          if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { prompt: 'silent probe', label: 'slw', isolation: 'worktree' } });
          return JSON.stringify({ done: true, reply: 'parent done' });
        }),
      };
      const h = new Harness({ root: plain, mode: 'dontAsk', model, learnSkills: false });
      return h.reactor.run({ goal: 'g' }, { maxSteps: 6 }).then((r) => {
        assert.equal(r.done, true, '父任务正常完成');
        const childCwd = cwdOf(prompts[1]!);
        assert.equal(childCwd, plain, '静默兜底：子代理在主工作区执行');
        const chain = h.context.chainView();
        assert.equal(chain.some((s) => s.observation.includes('kept for inspection') || s.observation.includes('isolation failed')), false, '零隔离副作用链行（静默）');
        assert.equal(readRegistry(tmp).length, 0, '零树登记');
        assert.ok(chain.some((s) => s.observation.startsWith('[slw] ')), '子代理结论行正常回链');
      });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  }));

test('T5-5a 缺项目根 → 同静默兜底：正常执行、零链行', async () =>
  withIso(async (tmp) => {
    const store = new FileStore(path.join(tmp, '.data'));
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, tmp)) registry.register(t);
    const context = new ContextManager(tmp, store);
    const agents = new AgentRegistry();
    agents.registerBuiltins();
    const runner = new SubagentRunner({ registry, safety, context, model: new ScriptedAdapter(['{"done":true,"reply":"rootless ok"}']) }, agents);
    runner.attachParent(() => ({ maxSteps: 10, tokenCap: 50_000 }));
    const r = await runner.runSubagent({ prompt: 'rootless probe', isolation: 'worktree' });
    assert.ok(r.ok, `缺根静默兜底应成功执行：${r.ok ? '' : r.error.message}`);
    assert.equal(context.chainView().some((s) => s.observation.includes('isolation')), false, '零链行');
  }));

test('T5-5b 是仓但 unborn HEAD → 建树失败 fail-bounded：补丁行回链、父任务不炸', () =>
  withIso((tmp) => {
    const repo = makeUnbornRepo();
    const prompts: string[] = [];
    const model: ModelAdapter = {
      provider: 'capture',
      chat: textReplyToChatFace(async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { prompt: 'fb probe', label: 'fb', isolation: 'worktree' } });
        return JSON.stringify({ done: true, reply: 'parent survived' });
      }),
    };
    const h = new Harness({ root: repo, mode: 'dontAsk', model, learnSkills: false });
    return h.reactor.run({ goal: 'g' }, { maxSteps: 6 }).then((r) => {
      assert.equal(r.done, true, '父任务不炸：run 应完成');
      const chain = h.context.chainView();
      assert.ok(
        chain.some((s) => s.observation.includes('[fb]') && s.observation.includes('isolation failed') && s.observation.includes('WORKTREE_GIT_FAIL')),
        `失败补丁行应回链且含错误码：${JSON.stringify(chain.map((s) => s.observation.slice(0, 90)))}`,
      );
      assert.equal(readRegistry(tmp).length, 0, '失败路径零树登记');
    });
  }));

test('T5-6 隔离子代理 exec 锚树：cwd=树、树内 git 放行、越树命令被拒且子代理可继续', () =>
  withIso((_tmp) => {
    const repo = makeRepo();
    const prompts: string[] = [];
    const model: ModelAdapter = {
      provider: 'capture',
      chat: textReplyToChatFace(async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { prompt: 'Iso exec probe', label: 'exw', isolation: 'worktree' } });
        if (prompt.includes('Iso exec probe')) {
          if (prompts.length === 2) return JSON.stringify({ tool: 'exec', input: { command: 'git rev-parse --show-toplevel' } });
          if (prompts.length === 3) return JSON.stringify({ tool: 'exec', input: { command: `cd ${repo} && git status` } });
          return JSON.stringify({ done: true, reply: 'iso exec done' });
        }
        return JSON.stringify({ done: true, reply: 'parent done' });
      }),
    };
    const h = new Harness({ root: repo, mode: 'dontAsk', model, learnSkills: false });
    return h.reactor.run({ goal: 'g' }, { maxSteps: 8 }).then((r) => {
      assert.equal(r.done, true);
      const childCwd = cwdOf(prompts[1]!);
      const base = path.basename(childCwd);
      assert.match(base, /^subagent-exw-[a-z0-9]{4}$/);
      assert.equal(prompts.length, 5, `帧序 父/子×3/父=5：${prompts.length}`);
      assert.ok(prompts[2]!.includes(base), '树内 git rev-parse --show-toplevel 输出锚树');
      assert.ok(prompts[3]!.includes('command rejected'), '越树 cd 被拒且原因回喂子代理');
      const chain = h.context.chainView();
      assert.ok(
        chain.some((s) => s.action === 'node' && s.observation.startsWith('[exw] ') && s.observation.includes('iso exec done')),
        '拒绝后子代理继续并以结论行收束',
      );
    });
  }));

test('T5-7 回归锚：未声明 isolation 的 spawn 行为零变化', () =>
  withIso((tmp) => {
    const repo = makeRepo();
    const prompts: string[] = [];
    const model: ModelAdapter = {
      provider: 'capture',
      chat: textReplyToChatFace(async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) return JSON.stringify({ tool: 'spawn', input: { agent_id: 'plain', label: 'reg' } });
        return JSON.stringify({ done: true, reply: 'parent done' });
      }),
    };
    fs.mkdirSync(path.join(repo, 'agents', 'plain'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'agents', 'plain', 'agent.md'), '---\nname: Plain\ndescription: no isolation\n---\nwork.');
    const h = new Harness({ root: repo, mode: 'dontAsk', model, learnSkills: false });
    return h.reactor.run({ goal: 'g' }, { maxSteps: 6 }).then((r) => {
      assert.equal(r.done, true);
      assert.equal(cwdOf(prompts[1]!), repo, '无声明：子代理 cwd=主根');
      assert.equal(readRegistry(tmp).length, 0, '无树登记');
      const chain = h.context.chainView();
      assert.equal(chain.some((s) => s.observation.includes('kept for inspection') || s.observation.includes('isolation')), false, '零隔离链行');
      assert.ok(chain.some((s) => s.observation.startsWith('[reg] ')), '结论行原样');
    });
  }));

test('T5-8 并行批两棵专属树互不撞名，双双干净收口', () =>
  withIso((tmp) => {
    const repo = makeRepo();
    const prompts: string[] = [];
    const model: ModelAdapter = {
      provider: 'capture',
      chat: textReplyToChatFace(async (prompt: string) => {
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
      }),
    };
    const h = new Harness({ root: repo, mode: 'dontAsk', model, learnSkills: false });
    return h.reactor.run({ goal: 'g' }, { maxSteps: 8 }).then((r) => {
      assert.equal(r.done, true);
      const cwdA = cwdOf(prompts.find((p) => p.includes('Child A task'))!);
      const cwdB = cwdOf(prompts.find((p) => p.includes('Child B task'))!);
      assert.notEqual(cwdA, cwdB, '并行批两棵专属树不得撞名');
      assert.match(path.basename(cwdA), /^subagent-pa-[a-z0-9]{4}$/);
      assert.match(path.basename(cwdB), /^subagent-pb-[a-z0-9]{4}$/);
      assert.equal(readRegistry(tmp).length, 0, '双双干净收口');
    });
  }));
