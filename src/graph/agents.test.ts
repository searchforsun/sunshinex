import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ROLE_PRESETS } from './agents';
import { makeRoleAgent } from './agents';
import { GraphDeps, GraphTermination } from './engine';
import { GraphContext } from '../types';
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

test('ROLE_PRESETS：与 AgentRole 全集一致且框定非空', () => {
  const roles = ['planner', 'developer', 'tester', 'reviewer'];
  assert.deepEqual(Object.keys(ROLE_PRESETS).sort(), [...roles].sort());
  for (const r of roles) {
    const preset = ROLE_PRESETS[r as keyof typeof ROLE_PRESETS];
    assert.ok(preset.label.en.length > 0 && preset.label.zh.length > 0, `${r} label 双语非空`);
    assert.ok(preset.framing.en.length > 0 && preset.framing.zh.length > 0, `${r} framing 双语非空`);
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

test('role agent fork：私有执行零主链回写、终态回写结论行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-graph-fork-'));
  try {
    const deps = makeGraphDeps(tmp, new ScriptedAdapter([JSON.stringify({ done: true, reply: '规划完成' })]));
    const ctx = graphCtx(graphTerm(), { goal: '建设电商网站' });
    const node = makeRoleAgent('planner', deps, { maxSteps: 2 });
    const out = await node.run(ctx, deps, {});
    assert.equal(out.status, 'pass');
    const chain = deps.context.chainView();
    const nodeLine = chain.find((s) => s.action === 'node');
    assert.ok(nodeLine && nodeLine.observation.includes('规划完成'), '终态必须回写一行结论');
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
