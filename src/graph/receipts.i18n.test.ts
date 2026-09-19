import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLanguage, setLanguage } from '../i18n';
import { GraphContext, GraphNodeOutput, LoopTermination } from '../types';
import { GraphDeps, GraphEngine, GraphNode, GraphTermination } from './engine';
import { makeCiNode, makeGateNode } from './nodes';
import { softwarePipelineTemplate } from './templates';
import { LoopDeps, LoopEngine } from '../loop/engine';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { ScriptedAdapter } from '../model/adapter';

/**
 * 双语钉子（B3 核心防线）：gate/CI/引擎汇总等「写死的字面量、零写链、只上屏」回执属**死的用户显示**，
 * 由 `t(en, zh)` 包裹——zh 下必须仍呈中文；被误英文化即本用例红。
 * 写链面（loop 判据 prompt、deficit 行、结论行）不在本用例范围：它们是英文单语。
 */

// ===== 测试基建（与 graph/nodes.test.ts 同源：CI 节点要经 registry + SafetyChain 真执行命令） =====

function makeRealDeps(root: string): GraphDeps {
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk'),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  for (const tool of builtinTools(safety, root)) registry.register(tool);
  return { safety, registry, context: new ContextManager(root, new FileStore(root)), model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) };
}

const term = (over: Partial<GraphTermination> = {}): GraphTermination => ({
  maxNodes: 12,
  maxTokens: 100_000,
  timeoutMs: 60_000,
  ...over,
});

const loopTerm = (over: Partial<LoopTermination> = {}): LoopTermination => ({
  maxIterations: 4,
  maxTokens: 1_000,
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

function mkNode(
  id: string,
  kind: GraphNode['kind'],
  deps: string[],
  run: (ctx: GraphContext, inputs: Record<string, GraphNodeOutput>) => GraphNodeOutput | Promise<GraphNodeOutput>,
): GraphNode {
  return { id, kind, deps, run: (ctx, _d, inputs) => run(ctx, inputs) };
}

const out = (status: GraphNodeOutput['status'], tokens = 0): GraphNodeOutput => ({ nodeId: '', status, tokens });

/** 回执采样：一次驱动全部「死的用户显示」产出点，返回可断言的回执集合 */
async function sampleReceipts(root: string): Promise<Record<string, string>> {
  const deps = makeRealDeps(root);
  // 失败命令以脚本文件承载：内联 `node -e "process.exit(3)"` 的引号/括号语义随宿主 shell 变化
  // （cmd 下被当字符串字面量、退出码恒 0），本用例断言的是回执文案，不能与 shell 方言耦合
  fs.writeFileSync(path.join(root, 'ci-fail.js'), 'process.exit(3)');
  const ctx = (state: Record<string, unknown> = {}): GraphContext => graphCtx(term(), { state });
  const gate = makeGateNode('g', { prompt: '交付确认' });
  const ci = (id: string, command: string) => makeCiNode(id, { command });
  const tpl = softwarePipelineTemplate(deps, { maxSteps: 1 });
  const deliveryGate = tpl.nodes.find((n) => n.id === 'delivery-gate')!;
  const allDone = await new GraphEngine([mkNode('a', 'agent', [], () => out('pass'))], deps, term()).run('x');
  const paused = await new GraphEngine([mkNode('g', 'gate', [], () => out('paused'))], deps, term()).run('x');
  const failed = await new GraphEngine([mkNode('a', 'ci', [], () => out('failed'))], deps, term()).run('x');
  const preview = await new GraphEngine([mkNode('a', 'agent', [], () => out('pass'))], deps, term()).run('x', {
    dryRun: true,
  });
  const loopFail = await new LoopEngine(
    [{ id: 'boom', kind: 'agent', run: () => ({ status: 'fail', tokens: 0 }) }],
    {} as LoopDeps,
    loopTerm(),
  ).run('x');
  const loopTimeout = await new LoopEngine(
    [
      {
        id: 'slow',
        kind: 'agent',
        run: async () => {
          await new Promise((r) => setTimeout(r, 30));
          return { status: 'pass' as const, tokens: 0 };
        },
      },
    ],
    {} as LoopDeps,
    loopTerm({ timeoutMs: 0 }),
  ).run('x');
  return {
    gatePaused: String((await gate.run(ctx(), deps, {})).reply),
    gateApproved: String((await gate.run(ctx({ approvals: { g: true } }), deps, {})).reply),
    gateRejected: String((await gate.run(ctx({ approvals: { g: false } }), deps, {})).reply),
    ciDryRun: String((await ci('ci-dry', 'node --version').run(ctx({ __dryRun: true }), deps, {})).reply),
    ciPassed: String((await ci('ci-ok', 'node --version').run(ctx(), deps, {})).reply),
    ciFailed: String((await ci('ci-bad', 'node ci-fail.js').run(ctx(), deps, {})).reply),
    engineDone: String(allDone.reply ?? ''),
    enginePaused: String(paused.reply ?? ''),
    engineFailed: String(failed.reply ?? ''),
    engineDryRun: String(preview.results['a'].reply ?? ''),
    templateGate: String((await deliveryGate.run(ctx(), deps, {})).reply),
    loopNodeFail: String(loopFail.error ?? ''),
    loopTimeout: String(loopTimeout.error ?? ''),
  };
}

test('回执双语钉子（zh）：gate/CI/引擎汇总/dry-run 预览仍是中文（t() 包裹的死用户显示，未被误英文化）', async () => {
  const prev = getLanguage();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-receipt-zh-'));
  try {
    setLanguage('zh');
    const r = await sampleReceipts(tmp);
    assert.ok(r.gatePaused.includes('等待人工审批：'), `gate 未审批回执应中文：${r.gatePaused}`);
    assert.ok(r.gateApproved.includes('审批通过：'), `gate 通过回执应中文：${r.gateApproved}`);
    assert.ok(r.gateRejected.includes('审批拒绝：'), `gate 拒绝回执应中文：${r.gateRejected}`);
    assert.ok(r.ciDryRun.includes('[dry-run] 将执行'), `CI dry-run 回执应中文：${r.ciDryRun}`);
    assert.ok(r.ciPassed.includes('CI 通过：'), `CI 通过回执应中文：${r.ciPassed}`);
    assert.ok(r.ciFailed.includes('CI 失败：'), `CI 失败回执应中文：${r.ciFailed}`);
    assert.equal(r.engineDone, '全部节点完成');
    assert.equal(r.enginePaused, '等待人工审批：g');
    assert.equal(r.engineFailed, '存在失败节点：a');
    assert.equal(r.engineDryRun, '[dry-run] 预览: a(agent)');
    assert.ok(r.templateGate.includes('交付确认'), `流水线 gate 标签应中文：${r.templateGate}`);
    assert.equal(r.loopNodeFail, '节点 boom fail：（无说明）');
    assert.equal(r.loopTimeout, '执行超时（超过 0ms）');
  } finally {
    setLanguage(prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('回执双语钉子（en）：同批回执在英缺省下呈英文（确证断言取的是 t() 双分支，而非写死中文）', async () => {
  const prev = getLanguage();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-receipt-en-'));
  try {
    setLanguage('en');
    const r = await sampleReceipts(tmp);
    assert.ok(r.gatePaused.includes('Waiting for approval: '), `gate 未审批回执应英文：${r.gatePaused}`);
    assert.ok(r.gateApproved.includes('Approval granted: '), `gate 通过回执应英文：${r.gateApproved}`);
    assert.ok(r.gateRejected.includes('Approval rejected: '), `gate 拒绝回执应英文：${r.gateRejected}`);
    assert.ok(r.ciDryRun.includes('[dry-run] will run: '), `CI dry-run 回执应英文：${r.ciDryRun}`);
    assert.ok(r.ciPassed.includes('CI passed: '), `CI 通过回执应英文：${r.ciPassed}`);
    assert.ok(r.ciFailed.includes('CI failed: '), `CI 失败回执应英文：${r.ciFailed}`);
    assert.equal(r.engineDone, 'All nodes completed');
    assert.equal(r.enginePaused, 'Waiting for human approval: g');
    assert.equal(r.engineFailed, 'Failed nodes: a');
    assert.equal(r.engineDryRun, '[dry-run] preview: a(agent)');
    assert.ok(r.templateGate.includes('Delivery confirmation'), `流水线 gate 标签应英文：${r.templateGate}`);
    assert.equal(r.loopNodeFail, 'Node boom failed: (no detail)');
    assert.equal(r.loopTimeout, 'Execution timed out (0ms)');
  } finally {
    setLanguage(prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
