import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeRoleAgent, ROLE_PRESETS } from './agents';
import { GraphDeps, GraphTermination } from './engine';
import { GraphContext, LoopContext } from '../types';
import { agentNode } from '../loop/nodes';
import { ModelAdapter, ScriptedAdapter } from '../model/adapter';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';

test('ROLE_PRESETS：与 AgentRole 全集一致且框定非空（英文单语）', () => {
  const roles = ['planner', 'developer', 'tester', 'reviewer'];
  assert.deepEqual(Object.keys(ROLE_PRESETS).sort(), [...roles].sort());
  for (const r of roles) {
    const preset = ROLE_PRESETS[r as keyof typeof ROLE_PRESETS];
    // 角色行直接进 fork 提示词 → 英文单语（不得再出现双语成对）
    assert.ok(preset.label.length > 0 && !/[一-鿿]/.test(preset.label), `${r} label 英文单语非空`);
    assert.ok(preset.framing.length > 0 && !/[一-鿿]/.test(preset.framing), `${r} framing 英文单语非空`);
  }
});

/** GraphDeps 装配样板（对齐 nodes.test.ts makeRealDeps）：真实安全链/注册表/上下文 + 注入模型桩 */
function makeGraphDeps(root: string, model: ModelAdapter): GraphDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  return { safety, registry, context: new ContextManager(root, new FileStore(root)), model };
}

const graphTerm = (over: Partial<GraphTermination> = {}): GraphTermination => ({
  maxNodes: 12,
  maxTokens: 100_000,
  timeoutMs: 60_000,
  ...over,
});

const graphCtx = (termination: GraphTermination, state: Record<string, unknown> = {}): GraphContext => ({
  iteration: 0,
  state,
  tokensUsed: 0,
  startedAt: Date.now(),
  termination,
  results: {},
} as GraphContext);

test('role agent fork：私有执行零主链回写、终态回写结论行（Runner 统一口径）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-graph-fork-'));
  try {
    const deps = makeGraphDeps(tmp, new ScriptedAdapter([JSON.stringify({ done: true, reply: '规划完成' })]));
    const ctx = graphCtx(graphTerm(), { goal: '建设电商网站' });
    const node = makeRoleAgent('planner', deps, { maxSteps: 2 });
    const out = await node.run(ctx, deps, {});
    assert.equal(out.status, 'pass');
    const chain = deps.context.chainView();
    const nodeLine = chain.find((s) => s.action === 'node');
    assert.ok(
      nodeLine && nodeLine.observation.startsWith('[Planner] ') && nodeLine.observation.includes('规划完成'),
      `终态必须回写一行结论（Runner 统一 [label] 前缀口径），实际：${nodeLine?.observation}`,
    );
    assert.ok(!chain.some((s) => s.action === 'read' || s.action === 'exec'), 'fork 私有步骤不得回写主链');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('role agent fork：seed 组合主链快照 + 角色行 + 节点任务行，私有前缀零主链污染', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-graph-seed-'));
  try {
    const deps = makeGraphDeps(tmp, new ScriptedAdapter([JSON.stringify({ done: true, reply: 'ok' })]));
    deps.context.appendChain([{ action: 'node', observation: 'planner：上游结论行' }]);
    const ctx = graphCtx(graphTerm(), { goal: '建设电商网站' });
    const node = makeRoleAgent('developer', deps, { maxSteps: 2 });
    const o = await node.run(ctx, deps, {});
    assert.equal(o.status, 'pass');
    const chain = deps.context.chainView();
    assert.ok(chain.some((s) => s.action === 'node' && s.observation.includes('上游结论行')), '上游结论经主链可见');
    assert.ok(!chain.some((s) => s.action === 'role' || s.action === 'task'), '角色行/任务行属 fork 私有前缀，不得回写主链');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** capture 桩：透传 scripted 应答并记录每次 prompt（回归矩阵取帧用） */
function captureModel(scripted: ScriptedAdapter): { model: ModelAdapter; prompts: string[] } {
  const prompts: string[] = [];
  const model: ModelAdapter = {
    provider: 'capture',
    complete: async (p: string) => {
      prompts.push(p);
      return scripted.complete(p);
    },
  } as ModelAdapter;
  return { model, prompts };
}

test('回归矩阵：fork 首帧 = 主链末帧严格前缀 + 尾追（主链↔fork 首帧连续）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-matrix-forkprefix-'));
  try {
    const { model, prompts } = captureModel(new ScriptedAdapter([
      '{"tool":"exec","input":{"command":"echo chain-step"},"done":false}',
      JSON.stringify({ done: true, reply: '主链完成' }),
      JSON.stringify({ done: true, reply: '规划完成' }),
    ]));
    const deps = makeGraphDeps(tmp, model);
    // 主链一轮（session 作用域 agent 节点直调）：步骤回写 + 结论行入链
    const loopCtx: LoopContext = {
      iteration: 0,
      state: { goal: '主链任务' },
      tokensUsed: 0,
      startedAt: Date.now(),
      termination: { maxIterations: 4, maxTokens: 100_000, timeoutMs: 60_000 },
    };
    await agentNode(deps).run(loopCtx, null);
    const mainFrame = prompts[prompts.length - 1];
    // fork 一轮（role agent）：seed = 主链快照 + 角色行 + 任务行
    const gctx = {
      iteration: 0,
      state: { goal: '建设电商网站' },
      tokensUsed: 0,
      startedAt: Date.now(),
      termination: graphTerm(),
      results: {},
    } as GraphContext;
    await makeRoleAgent('planner', deps, { maxSteps: 2 }).run(gctx, deps, {});
    const forkFrame = prompts[prompts.length - 1];
    assert.ok(forkFrame.startsWith(mainFrame), 'fork 首帧必须以主链末帧为逐字节前缀（差异只在尾部尾追）');
    assert.ok(forkFrame.indexOf('Your role:') > mainFrame.length, 'fork 尾追（角色行）位于主链末帧之后');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('回归矩阵：同层并发 fork 共享主链快照基线（尾追前逐字节一致）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-matrix-concurrent-'));
  try {
    const { model, prompts } = captureModel(new ScriptedAdapter([
      JSON.stringify({ done: true, reply: '规划完成' }),
      JSON.stringify({ done: true, reply: '开发完成' }),
    ]));
    const deps = makeGraphDeps(tmp, model);
    deps.context.appendChain([{ action: 'node', observation: 'planner：上游结论行' }]);
    const mkCtx = () =>
      ({
        iteration: 0,
        state: { goal: '建设电商网站' },
        tokensUsed: 0,
        startedAt: Date.now(),
        termination: graphTerm(),
        results: {},
      }) as GraphContext;
    await Promise.all([
      makeRoleAgent('planner', deps, { maxSteps: 2 }).run(mkCtx(), deps, {}),
      makeRoleAgent('developer', deps, { maxSteps: 2 }).run(mkCtx(), deps, {}),
    ]);
    const pa = prompts.find((p) => p.includes('Your role: Planner'));
    const pd = prompts.find((p) => p.includes('Your role: Developer'));
    assert.ok(pa && pd, '两个并发 fork 均应有模型调用');
    const cutA = pa.indexOf('Your role:');
    const cutD = pd.indexOf('Your role:');
    assert.ok(cutA > 0 && cutD > 0);
    assert.equal(pa.slice(0, cutA), pd.slice(0, cutD), '并发 fork 共享同一 chainView 基线（尾追前逐字节一致）');
    const chain = deps.context.chainView();
    assert.equal(chain.filter((s) => s.action === 'node').length, 3, '上游行 + 两节点结论行共存（fork 私有步骤零回写）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
