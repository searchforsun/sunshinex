import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphNode, GraphDeps, GraphTermination } from './engine';
import { makeGateNode, makeCiNode, makeLoopNode } from './nodes';
import { makeRoleAgent } from './agents';
import { GraphContext, GraphNodeOutput } from '../types';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';

// ===== 测试基建 =====

class RecordingAdapter implements ModelAdapter {
  readonly provider: string;
  prompts: string[] = [];
  constructor(
    private inner: ModelAdapter,
    private tokensPerCall = 0,
  ) {
    this.provider = inner.provider;
  }
  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    this.prompts.push(prompt);
    hooks?.onUsage?.(this.tokensPerCall);
    return this.inner.complete(prompt, hooks);
  }
}

function makeRealDeps(root: string, model: ModelAdapter = new ScriptedAdapter(['{"done":true,"reply":"ok"}'])): GraphDeps {
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk'),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  return { safety, registry, context: new ContextManager(root, new FileStore(root)), model };
}

const term = (over: Partial<GraphTermination> = {}): GraphTermination => ({
  maxNodes: 12,
  maxTokens: 100_000,
  timeoutMs: 60_000,
  ...over,
});

const graphCtx = (termination: GraphTermination, over: Partial<GraphContext> = {}): GraphContext => ({
  state: {},
  tokensUsed: 0,
  startedAt: Date.now(),
  results: {},
  termination: { ...termination },
  ...over,
});

const mktmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ===== T2 用例 =====

test('makeLoopNode：内嵌测试闭环修正环收敛，预算贯通（Graph remaining → Loop maxTokens）+ criteria 透传', async () => {
  const tmp = mktmp('p3-t2-loop-');
  fs.writeFileSync(path.join(tmp, 'math.js'), `function add(a, b) { return a + b; }\nmodule.exports = { add };\n`);
  fs.writeFileSync(
    path.join(tmp, 'math.test.js'),
    `const assert = require('node:assert');\nconst { add } = require('./math');\nassert.equal(add(1, 2), 4);\n`,
  );
  // 修正环：首轮仍写错 → check 未过 → router 回 agent → 二轮修正
  const model = new ScriptedAdapter([
    `{"tool":"write","input":{"path":"math.test.js","content":"const assert = require('node:assert');\\nconst { add } = require('./math');\\nassert.equal(add(1, 2), 4);\\n"},"done":false}`,
    `{"done":true,"reply":"测试已生成"}`,
    `{"tool":"write","input":{"path":"math.test.js","content":"const assert = require('node:assert');\\nconst { add } = require('./math');\\nassert.equal(add(1, 2), 3);\\n"},"done":false}`,
    `{"done":true,"reply":"断言已修正为 3"}`,
  ]);
  const deps = makeRealDeps(tmp, model);
  let observedLoopMaxTokens = -1;
  const node = makeLoopNode('test-verify', {
    template: 'test-loop',
    goal: '修复 math.test.js 使其断言正确（验收标准：c1=断言修正为 3）',
    termination: { maxIterations: 10 },
    ruleCheckers: {
      c1: async (io) => {
        observedLoopMaxTokens = io.ctx.termination.maxTokens;
        const s = fs.readFileSync(path.join(tmp, 'math.test.js'), 'utf8');
        return s.includes('assert.equal(add(1, 2), 3)');
      },
    },
  });
  const ctx = graphCtx(term({ maxTokens: 1000 }), { tokensUsed: 100 }); // remaining = 900
  const o = await node.run(ctx, deps, {});
  assert.equal(o.status, 'pass', `loop 节点应收敛为 pass：${JSON.stringify(o)}`);
  assert.equal(observedLoopMaxTokens, 900, 'Graph 剩余预算应贯通为 Loop termination.maxTokens');
  assert.ok(Array.isArray(o.criteria) && o.criteria.length > 0 && o.criteria.every((c) => c.passed), 'check 产物应透传');
  assert.ok(!fs.readFileSync(path.join(tmp, 'math.test.js'), 'utf8').includes('4)'));
});

test('makeRoleAgent：四角色框定进 Reactor prompt', async () => {
  const framingWords: Record<string, string> = {
    planner: '需求拆解',
    developer: '代码实现',
    tester: '测试用例',
    reviewer: '安全审查',
  };
  for (const role of ['planner', 'developer', 'tester', 'reviewer'] as const) {
    const recording = new RecordingAdapter(new ScriptedAdapter(['{"done":true,"reply":"ok"}']));
    const deps = makeRealDeps(mktmp('p3-t2-agent-'), recording);
    const node = makeRoleAgent(role, deps, { maxSteps: 2 });
    const o = await node.run(graphCtx(term()), deps, {});
    assert.equal(o.status, 'pass');
    assert.ok(recording.prompts[0].includes(framingWords[role]), `${role} 框定词应进任务文本`);
    assert.ok(recording.prompts[0].includes(role), `角色标识应进任务文本`);
  }
});

test('makeRoleAgent：tokens 透传（tokensPerCall=7 → 节点 tokens=7）', async () => {
  const recording = new RecordingAdapter(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), 7);
  const deps = makeRealDeps(mktmp('p3-t2-agent2-'), recording);
  const node = makeRoleAgent('developer', deps, { maxSteps: 2 });
  const ctx = graphCtx(term({ maxTokens: 1000 }), { tokensUsed: 100 }); // remaining=900，预算换算后仍可一次完成
  const o = await node.run(ctx, deps, {});
  assert.equal(o.status, 'pass');
  assert.equal(o.tokens, 7, 'Reactor 真实用量应透传为节点 tokens');
});

test('makeGateNode：未审批 paused / approve pass / reject failed', async () => {
  const node = makeGateNode('gate1', { prompt: '交付确认' });
  const o0 = await node.run(graphCtx(term()), makeRealDeps(mktmp('p3-t2-g-')), {});
  assert.equal(o0.status, 'paused');
  assert.ok(o0.reply?.includes('交付确认'));
  const o1 = await node.run(graphCtx(term(), { state: { approvals: { gate1: true } } }), makeRealDeps(mktmp('p3-t2-g-')), {});
  assert.equal(o1.status, 'pass');
  const o2 = await node.run(graphCtx(term(), { state: { approvals: { gate1: false } } }), makeRealDeps(mktmp('p3-t2-g-')), {});
  assert.equal(o2.status, 'failed');
});

test('makeCiNode：注入命令 exit 0 → pass（evidence 含 stdout），非零 → failed', async () => {
  const tmp = mktmp('p3-t2-ci-');
  const deps = makeRealDeps(tmp);
  const ok = makeCiNode('ci-ok', { command: `node -e "process.exit(0)"` });
  const bad = makeCiNode('ci-bad', { command: `node -e "process.exit(3)"` });
  const o1 = await ok.run(graphCtx(term()), deps, {});
  assert.equal(o1.status, 'pass', `exit0 应 pass：${JSON.stringify(o1)}`);
  const o2 = await bad.run(graphCtx(term()), deps, {});
  assert.equal(o2.status, 'failed');
});

test('makeCiNode dryRun：预览短路，命令不执行', async () => {
  const tmp = mktmp('p3-t2-cidry-');
  const deps = makeRealDeps(tmp);
  const marker = path.join(tmp, 'marker.txt');
  const node = makeCiNode('ci', {
    command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
  });
  const ctx = graphCtx(term(), { state: { __dryRun: true } });
  const o = await node.run(ctx, deps, {});
  assert.equal(o.status, 'pass');
  assert.ok(o.reply?.includes('[dry-run]'));
  assert.ok(!fs.existsSync(marker), 'dry-run 不得真实执行命令');
});
