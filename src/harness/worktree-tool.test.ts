import { textReplyToChatFace } from '../model/chat-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { createWorktree, worktreesRoot, readRegistry } from './worktree';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';

/**
 * 入口二：worktree 模型工具（计划 T4，规格 §8/D2/D7）：
 * 含状态类调用混批时整轮按出牌顺序串行（reactor 执行面闸门）、manual 免审批（spawn 先例；deny 规则仍先行）、
 * plan 只读闸门对 create/exit 拦截、list 放行；工具 create/exit 直调 safety.enterWorktree/exitWorktree
 * （chain 层单点，D19-c 裁决：Harness 侧会话记账接缝已删）；
 * 活动根在场：write/glob 相对路径锚活动根（安全链判界/工具锚点同源切换）、exec cwd 锚活动根（builtin 装配 root 单点）。
 * 工具清单 +1 = 一次全量前缀断点（规格 D2 已裁决即论据）。
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
  const root = mktmp('sunshinex-t4-repo-');
  git(root, '-c', 'init.defaultBranch=main', 'init', '-q');
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  git(root, '-c', 'user.email=t@local', '-c', 'user.name=t', 'add', '.');
  git(root, '-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

function withHarness(mode: 'dontAsk' | 'manual' | 'plan', model: ModelAdapter, fn: (h: Harness, repo: string, tmp: string) => void | Promise<void>): Promise<void> {
  return (async () => {
    const tmp = mktmp('sunshinex-t4-h-');
    const prev = process.env.SUNSHINEX_DATA_DIR;
    process.env.SUNSHINEX_DATA_DIR = tmp;
    try {
      const repo = makeRepo();
      const h = new Harness({ root: repo, mode, model, learnSkills: false });
      await fn(h, repo, tmp);
    } finally {
      if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
      else process.env.SUNSHINEX_DATA_DIR = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
}

test('T4-1 装配后工具清单含 worktree，类别 worktree，description 恒英文单语', () =>
  withHarness('dontAsk', new ScriptedAdapter([]), (h) => {
    const t = h.tools.get('worktree');
    assert.ok(t, 'worktree 工具应已注册');
    assert.equal(t && t.category, 'worktree', '类别应登记为 worktree（并行闸门与 plan 闸门的判定键）');
    assert.ok(t && /^[\x20-\x7E]+$/.test(t.description), `description 恒英文单语：${t && t.description.slice(0, 40)}`);
  }));

test('T4-2 create 端到端：观察含路径与分支；glob 锚树/write 相对路径落 worktree（活动根生效）', () =>
  withHarness(
    'dontAsk',
    new ScriptedAdapter([
      JSON.stringify({ tool: 'worktree', input: { action: 'create', name: 'sess' } }),
      JSON.stringify({ tool: 'glob', input: { pattern: '*' } }),
      JSON.stringify({ tool: 'write', input: { path: 'note.txt', content: 'hi\n' } }),
      JSON.stringify({ done: true, reply: 'ok' }),
    ]),
    (h, repo, tmp) => {
      // 主区判别物：未提交文件只在主根存在（worktree 自 HEAD 分叉，不含工作区未跟踪文件）
      fs.writeFileSync(path.join(repo, 'main-only.txt'), 'x\n');
      return h.reactor.run({ goal: 'g' }, { maxSteps: 6 }).then((r) => {
        assert.equal(r.done, true, `run 应完成：${JSON.stringify(r.stopReason ?? '')}`);
        const tree = path.join(worktreesRoot(tmp), 'sess');
        const call = r.steps.find((s) => s.action === 'tool-result' && s.observation.includes('worktree-sess'));
        assert.ok(call, `create 观察应含路径与分支名，实际步骤：${JSON.stringify(r.steps.map((s) => s.observation.slice(0, 60)))}`);
        const globRow = r.steps.find((s) => s.action === 'tool-result' && s.observation.includes('README.md'));
        assert.ok(globRow, `worktree 会话 glob 应列树内文件：${JSON.stringify(r.steps.map((s) => s.observation.slice(0, 60)))}`);
        assert.ok(globRow && !globRow.observation.includes('main-only.txt'), 'glob 锚活动根：主区未提交文件不得混入清单（D19-b）');
        assert.ok(fs.existsSync(path.join(tree, 'note.txt')), 'write 相对路径应锚活动根（落在 worktree 内）');
        assert.ok(!fs.existsSync(path.join(repo, 'note.txt')), 'write 相对路径不得落主根');
        assert.ok(readRegistry(tmp).some((e) => e.name === 'sess'), 'create 应登记');
      });
    },
  ));

test('T4-3 未激活 exit：WORKTREE_NOT_ACTIVE 显式拒绝（不静默）', () =>
  withHarness('dontAsk', new ScriptedAdapter([]), (h) =>
    h.tools.execute('worktree', { action: 'exit' }, h.safety).then((r) => {
      assert.ok(!r.ok && r.error.code === 'WORKTREE_NOT_ACTIVE', `应报 WORKTREE_NOT_ACTIVE：${JSON.stringify(r.ok ? r.value : r.error)}`);
    }),
  ));

test('T4-4 list：观察行输出登记表摘要（name/branch/dirty）', () =>
  withHarness(
    'dontAsk',
    new ScriptedAdapter([JSON.stringify({ tool: 'worktree', input: { action: 'list' } }), JSON.stringify({ done: true, reply: 'ok' })]),
    (h, repo, tmp) => {
      const c = createWorktree(repo, tmp, 'listing', {});
      assert.ok(c.ok, `seed create 失败：${c.ok ? '' : c.error.message}`);
      // 脏化 seed 树：list 摘要的 dirty 字段需真实脏态可辨（干净树标 clean）
      fs.writeFileSync(path.join(worktreesRoot(tmp), 'listing', 'extra.txt'), 'x\n');
      return h.reactor.run({ goal: 'g' }, { maxSteps: 4 }).then((r) => {
        const row = r.steps.find((s) => s.action === 'tool-result' && s.observation.includes('listing'));
        assert.ok(row, `list 观察应含登记条目 name：${JSON.stringify(r.steps.map((s) => s.observation.slice(0, 60)))}`);
        assert.ok(row && /worktree-listing/.test(row.observation) && /dirty/.test(row.observation), `摘要应含 branch 与 dirty 字段：${row && row.observation.slice(0, 120)}`);
      });
    },
  ));

test('T4-5 并行闸门：worktree 与 read 同批按序串行执行（混合批不拒绝）', () =>
  withHarness(
    'dontAsk',
    new ScriptedAdapter([
      JSON.stringify({
        tools: [
          { tool: 'read', input: { path: 'README.md' } },
          { tool: 'worktree', input: { action: 'list' } },
        ],
      }),
      JSON.stringify({ done: true, reply: 'ok' }),
    ]),
    (h) => {
      const t = h.tools.get('worktree');
      assert.ok(t && String(t.category) === 'worktree', '前置：工具已注册且类别登记（真实类别缝）');
      return h.reactor.run({ goal: 'g' }, { maxSteps: 4 }).then((r) => {
        assert.ok(!r.steps.some((s) => s.observation.includes('rejected')), '混合批按序串行执行不拒绝');
        assert.ok(r.steps.some((s) => s.action === 'tool-result' && s.observation.includes('worktree')), 'worktree list 真实执行');
      });
    },
  ));

test('T4-6 plan 模式：create/exit 拒绝、list 放行', () =>
  withHarness('plan', new ScriptedAdapter([]), async (h) => {
    await Promise.all([
      h.tools.execute('worktree', { action: 'create', name: 'x' }, h.safety).then((r) => {
        assert.ok(!r.ok, 'plan 下 create 应拒');
      }),
      h.tools.execute('worktree', { action: 'exit' }, h.safety).then((r) => {
        assert.ok(!r.ok, 'plan 下 exit 应拒');
      }),
      h.tools.execute('worktree', { action: 'list' }, h.safety).then((r) => {
        assert.ok(r.ok, `plan 下 list 应放行：${r.ok ? '' : r.error.message}`);
      }),
    ]);
  }));

test('T4-7 manual 模式：worktree 全动作免审批（deny 规则仍先行）', () =>
  withHarness('manual', new ScriptedAdapter([]), (h) => {
    let asks = 0;
    h.security.setAsker(async () => {
      asks++;
      return 'deny';
    });
    return h.tools.execute('worktree', { action: 'create', name: 'm1' }, h.safety).then((r) => {
      assert.equal(asks, 0, 'asker 不得被调用（免审批先例同 spawn）');
      assert.ok(r.ok, `manual 下 create 免审批应成功：${r.ok ? '' : r.error.message}`);
    });
  }));

test('T4-8 活动根在场：exec cwd 锚活动根（相对命令执行位置切换）', () =>
  withHarness(
    'dontAsk',
    new ScriptedAdapter([JSON.stringify({ tool: 'exec', input: { command: 'pwd' } }), JSON.stringify({ done: true, reply: 'ok' })]),
    (h, repo, tmp) => {
      const c = createWorktree(repo, tmp, 'cwdx', {});
      assert.ok(c.ok, `seed create 失败：${c.ok ? '' : c.error.message}`);
      h.safety.enterWorktree(c.value.path);
      return h.reactor.run({ goal: 'g' }, { maxSteps: 4 }).then((r) => {
        const row = r.steps.find((s) => s.action === 'tool-result' && s.observation.includes('worktrees'));
        assert.ok(row, `exec cwd 应锚活动根（pwd 输出树路径）：${JSON.stringify(r.steps.map((s) => s.observation.slice(0, 80)))}`);
      });
    },
  ));

test('T6-N2 create→exit 事实行随活动根翻转；同环境段内相邻帧前缀逐字节稳定（D19-b 口径）', () => {
  const prompts: string[] = [];
  // 帧序（5 帧）：create（主区）→ read/read/exit 前置帧（树内）→ done（退出回主区）；
  // worktree 进出=合法前缀重写点（与 cwd 同类的会话级环境事实，非时变字段）——跨进出帧不做字节前缀断言，
  // 只断言「唯一差异是工作目录事实行」；同环境段内相邻帧维持逐字节前缀（规格 §12 钉2 的现行口径）
  const replies = [
    JSON.stringify({ tool: 'worktree', input: { action: 'create', name: 'nail2' } }),
    JSON.stringify({ tool: 'read', input: { path: 'README.md' } }),
    JSON.stringify({ tool: 'read', input: { path: 'README.md' } }),
    JSON.stringify({ tool: 'worktree', input: { action: 'exit' } }),
    JSON.stringify({ done: true, reply: 'ok' }),
  ];
  let i = 0;
  const model: ModelAdapter = {
    provider: 'capture',
    chat: textReplyToChatFace(async (prompt: string) => {
    prompts.push(prompt);
    return replies[Math.min(i++, replies.length - 1)];
        }),
  };
  const factOf = (p: string) => /Current working directory \(project root\): (.*)/.exec(p)?.[1]?.trim();
  return withHarness('dontAsk', model, (h, repo) =>
    h.reactor.run({ goal: 'g' }, { maxSteps: 8 }).then((r) => {
      assert.equal(r.done, true);
      assert.equal(prompts.length, 5, `帧数应为 create/read/read/exit/done=5：${prompts.length}`);
      const facts = prompts.map(factOf);
      // 事实行翻转：create 后进树、exit 后回主区——与 worktree 工具回执「session working root is now ...」一致
      assert.equal(facts[0], repo, `第 1 帧应报主根：${facts[0]}`);
      const tree = facts[1];
      assert.ok(tree && tree !== repo && /nail2/.test(tree), `create 后事实行应报树路径：${tree}`);
      assert.equal(facts[2], tree, '树内帧事实行恒定');
      assert.equal(facts[3], tree, 'exit 调用帧仍处树内（exit 在该帧后才执行）');
      assert.equal(facts[4], repo, `exit 后回主根：${facts[4]}`);
      // 同环境段内相邻帧：逐字节前缀稳定（第 2→3、3→4 帧）
      for (const k of [2, 3]) {
        assert.ok(
          prompts[k]!.startsWith(prompts[k - 1]!),
          `第 ${k + 1} 帧应以第 ${k} 帧为逐字节前缀（同环境段内）`,
        );
      }
      // 跨进出帧（1→2）：唯一差异必须是工作目录事实行（把事实行换回前帧值后恢复字节前缀）
      const rewritten = prompts[1]!.replace(`Current working directory (project root): ${tree}`, `Current working directory (project root): ${repo}`);
      assert.ok(
        rewritten.startsWith(prompts[0]!),
        `进出重写点的差异应仅限事实行：\n前帧尾 60：${prompts[0]!.slice(-60)}\n改写帧首 60：${rewritten.slice(0, 60)}`,
      );
    }),
  );
});
