import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryPipeline } from './pipeline';
import { StubAdapter } from '../../model/adapter';
import type { ModelAdapter } from '../../model/adapter';

/**
 * 后台沉淀管线（规格 §3.1）：零等待入队 / 单 worker FIFO 串行 / 无真实模型同步确定性回退 / notify 双通道路由。
 * 数据目录钉文件私有 tmpdir（照 memory 线既有 helper 范式）：SUNSHINEX_DATA_DIR 重定向 + finally 还原与清理，
 * 绝不污染共享 .data-test 与真实家目录。
 */

interface Ctx {
  p: MemoryPipeline;
  notified: Array<[string, string]>;
  root: string;
  /** 本次用例私有数据目录（SUNSHINEX_DATA_DIR 指向处）：学习技能落盘于 <dataDir>/skills */
  dataDir: string;
}

function scriptedModel(script: (prompt: string) => string, calls: string[]): ModelAdapter {
  return {
    provider: 'openai',
    capabilities: { chat: true }, // J2：真实模型夹具声明能力位（enqueue 门禁判据）
    complete: async () => {
      throw new Error('complete must not be called on the chat path');
    },
    chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
      calls.push(req.messages.map((m) => m.content).join('\n'));
      const prompt = calls[calls.length - 1];
      const text = script(prompt);
      // 文本以 '{' 开头视为出牌 JSON（submit_refined_skill / submit_memory_items 按标记分流），否则视为无牌正文
      if (!text.trimStart().startsWith('{')) return { finish: 'stop', content: text, toolCalls: [] };
      const isLearned = prompt.includes('learned-extraction');
      return {
        finish: 'tool_calls',
        content: '',
        toolCalls: [{ id: 'call_0', name: isLearned ? 'submit_refined_skill' : 'submit_memory_items', argsJson: text }],
      };
    },
  } as unknown as ModelAdapter;
}

/** 私有 tmpdir + SUNSHINEX_DATA_DIR 重定向，finally 还原 env 并清理（文件私有，绝不用共享数据目录） */
function withPipeline(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void> | void): Promise<void> {
  return (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-pipe-'));
    const prev = process.env.SUNSHINEX_DATA_DIR;
    process.env.SUNSHINEX_DATA_DIR = tmp;
    try {
      const root = path.join(tmp, 'root');
      fs.mkdirSync(root, { recursive: true });
      const notified: Array<[string, string]> = [];
      const p = new MemoryPipeline({ model, root, notify: (s, l) => notified.push([s, l]) });
      await fn({ p, notified, root, dataDir: tmp });
    } finally {
      if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
      else process.env.SUNSHINEX_DATA_DIR = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
}

/** 落盘技能 id 列表（<数据目录>/skills/<id>/skill.md 形态，LearnedSkillStore 一技能一目录） */
function skillIds(dataDir: string): string[] {
  const dir = path.join(dataDir, 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'skill.md')))
    .map((e) => e.name)
    .sort();
}

function skillBody(dataDir: string, id: string): string {
  return fs.readFileSync(path.join(dataDir, 'skills', id, 'skill.md'), 'utf8');
}

const REFINED = JSON.stringify({
  action: 'create',
  skill: {
    name: 'verify-before-done',
    description: 'Assert green before done',
    body: '## When to Use\nx\n## Procedure\ny\n## Pitfalls\nz — because w\n## Verification\nv',
  },
});

test('pipeline：无真实模型 + done → 同步确定性写盘并返回说明行（队列零积压）', async () => {
  await withPipeline(new StubAdapter(), ({ p, notified, dataDir }) => {
    const line = p.enqueue({ kind: 'learned', goal: 'do a thing', reply: 'did it', outcome: 'done', digest: '' });
    assert.equal(p.pending(), 0);
    assert.ok(line && line.startsWith('[skills] learned: '));
    assert.equal(notified.length, 0, '同步路径说明行经返回值走 reactor announce，不经 notify');
    assert.deepEqual(skillIds(dataDir), ['do-a-thing'], '确定性路径确实落盘（id = slugify(goal)）');
    assert.ok(skillBody(dataDir, 'do-a-thing').includes('# Goal'), '缺省路径为确定性体（非语义提炼）');
  });
});

test('pipeline：无真实模型 + failed/stopped → 零动作（无价值判定能力，宁少勿滥）', async () => {
  await withPipeline(new StubAdapter(), ({ p, notified, dataDir }) => {
    assert.equal(p.enqueue({ kind: 'learned', goal: 'x', reply: '', outcome: 'failed', digest: '' }), undefined);
    assert.equal(p.enqueue({ kind: 'learned', goal: 'x', reply: 'r', outcome: 'stopped', digest: '' }), undefined);
    assert.equal(p.enqueue({ kind: 'memory', goal: 'x', reply: 'r', outcome: 'done', digest: '' }), undefined);
    assert.equal(p.pending(), 0);
    assert.deepEqual(skillIds(dataDir), []);
    assert.equal(notified.length, 0);
  });
});

test('pipeline：有模型 → 入队零等待，drain 后落盘语义技能并 notify', async () => {
  const calls: string[] = [];
  const model = scriptedModel((prompt) => (prompt.includes('learned-extraction') ? REFINED : '{"memories":[]}'), calls);
  await withPipeline(model, async ({ p, notified }) => {
    p.enqueue({ kind: 'learned', goal: 'g', reply: 'r', outcome: 'done', digest: '1. [read] a.ts -> ok\n2. [write] b.ts -> ok\n3. [exec] test -> ok' });
    assert.equal(p.pending(), 1, '入队即返回、不等模型');
    await p.drain();
    assert.equal(p.pending(), 0);
    assert.ok(calls[0].includes('learned-extraction'));
    assert.ok(notified.some(([s, l]) => s === 'skills' && l.includes('verify-before-done')));
  });
});

test('pipeline：记忆说明行无路径引用（G14.106 GUI 可见面去 recall 指针）', async () => {
  const envelope = JSON.stringify({
    items: [{ type: 'project', description: 'uses pnpm workspaces', content: 'repo manages packages with pnpm workspaces' }],
  });
  const model = scriptedModel(() => envelope, []);
  await withPipeline(model, async ({ p, notified }) => {
    p.enqueue({ kind: 'memory', goal: 'g', reply: 'r', outcome: 'done', digest: '' });
    await p.drain();
    const line = notified.find(([s]) => s === 'memory')?.[1];
    assert.ok(line, '记忆通道应有 notify');
    assert.ok(line.startsWith('[memory] saved: uses-pnpm-workspaces'), `口径: ${line}`);
    assert.ok(!line.includes('recall via read'), '不再含 recall 路径指针(正文链接化污染源)');
    assert.ok(!line.includes('MEMORY.md'), '不含 MEMORY.md 路径');
    assert.equal(notified.filter(([s]) => s === 'skills').length, 0, '记忆条目不经 learned 通道');
  });
});

test('pipeline：单 worker 串行（并发模型调用计数恒 ≤ 1）', async () => {
  let inFlight = 0;
  let peak = 0;
  const model = {
    provider: 'openai',
    capabilities: { chat: true }, // J2：真实模型夹具声明能力位（enqueue 门禁判据）
    complete: async () => {
      throw new Error('complete must not be called on the chat path');
    },
    chat: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { finish: 'tool_calls', content: '', toolCalls: [{ id: 'call_0', name: 'submit_refined_skill', argsJson: '{"skill":null}' }] };
    },
  } as unknown as ModelAdapter;
  await withPipeline(model, async ({ p }) => {
    p.enqueue({ kind: 'learned', goal: 'a', reply: 'r', outcome: 'done', digest: '1. [read] a.ts -> ok\n2. [write] b.ts -> ok\n3. [exec] c -> ok' });
    p.enqueue({ kind: 'learned', goal: 'b', reply: 'r', outcome: 'done', digest: '1. [read] a.ts -> ok\n2. [write] b.ts -> ok\n3. [exec] c -> ok' });
    await p.drain();
    assert.equal(peak, 1);
    assert.equal(p.pending(), 0, 'drain 返回即队列清空');
  });
});

test('pipeline：模型判无可复用教训（{"action":"skip"}）→ 零落盘零 notify', async () => {
  const model = scriptedModel(() => '{"action":"skip"}', []);
  await withPipeline(model, async ({ p, notified, dataDir }) => {
    p.enqueue({ kind: 'learned', goal: 'g', reply: 'r', outcome: 'done', digest: '' });
    await p.drain();
    assert.deepEqual(skillIds(dataDir), [], '模型判无教训 → 宁少勿滥');
    assert.equal(notified.filter(([s]) => s === 'skills').length, 0);
  });
});

test('pipeline：技术失败（畸形 JSON）→ 重试后丢弃零落盘（G14.92 宁缺勿滥,无回退）', async () => {
  let calls = 0;
  const model = scriptedModel(() => {
    calls += 1;
    return 'not json at all';
  }, []);
  await withPipeline(model, async ({ p, notified, dataDir }) => {
    p.enqueue({ kind: 'learned', goal: 'g', reply: 'r', outcome: 'done', digest: '1. [read] a.ts -> ok\n2. [write] b.ts -> ok\n3. [exec] c -> ok' });
    await p.drain();
    assert.deepEqual(skillIds(dataDir), [], '带病产物不进技能库——回退路径已废除');
    assert.equal(notified.filter(([s]) => s === 'skills').length, 0);
    assert.equal(calls, 3, '首次 + 2 次带错误反馈重试');
  });
});

test('pipeline：update 裁决 → 原地覆盖既有技能（不新增目录,容量守恒）', async () => {
  const updated = JSON.stringify({
    action: 'update',
    id: 'deploy-strategy',
    skill: {
      name: 'deploy-strategy',
      description: 'Merged deployment lesson',
      body: '## When to Use\nx\n## Procedure\ny\n## Pitfalls\nz — because w\n## Verification\nv',
    },
  });
  const model = scriptedModel((prompt) => (prompt.includes('learned-extraction') ? updated : '{"memories":[]}'), []);
  await withPipeline(model, async ({ p, notified, dataDir }) => {
    // 预置既有技能目录（上一轮沉淀）
    const dir = path.join(dataDir, 'skills', 'deploy-strategy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'skill.md'), '---\nname: old\ndescription: old\nversion: 0.1.0\n---\nold body');
    p.enqueue({ kind: 'learned', goal: 'refine deploy', reply: 'r', outcome: 'done', digest: '1. [read] deploy.md -> ok\n2. [write] deploy.sh -> ok\n3. [exec] deploy -> ok' });
    await p.drain();
    assert.deepEqual(skillIds(dataDir), ['deploy-strategy'], '原地更新不新增目录');
    assert.ok(skillBody(dataDir, 'deploy-strategy').includes('Merged deployment lesson'), '正文已合并更新');
    assert.ok(notified.some(([s, l]) => s === 'skills' && l.includes('[skills] updated: deploy-strategy')));
  });
});

test('pipeline：提炼异常被吞，drain 正常收束（旁路纪律）', async () => {
  const model = {
    provider: 'openai',
    complete: async () => {
      throw new Error('boom');
    },
  } as unknown as ModelAdapter;
  await withPipeline(model, async ({ p }) => {
    p.enqueue({ kind: 'memory', goal: 'g', reply: 'r', outcome: 'done', digest: '' });
    await assert.doesNotReject(() => p.drain());
    assert.equal(p.pending(), 0);
  });
});

test('pipeline：kick 幂等、空队列零调用', async () => {
  await withPipeline(new StubAdapter(), async ({ p }) => {
    p.kick();
    p.kick();
    await p.drain();
    assert.equal(p.pending(), 0);
  });
});
