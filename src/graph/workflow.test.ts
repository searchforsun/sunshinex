import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphDeps, WorkflowDef } from '../types';
import { instantiateWorkflow, validateWorkflow } from './workflow';
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

function makeDeps(root: string): GraphDeps {
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk'),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  return {
    safety,
    registry,
    context: new ContextManager(root, new FileStore(root)),
    model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
  };
}

const mktmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const validDef: WorkflowDef = {
  name: 'mini-pipeline',
  nodes: [
    { id: 'plan', kind: 'agent', deps: [], config: { role: 'planner' } },
    { id: 'check', kind: 'gate', deps: ['plan'], config: { prompt: '方案确认' } },
  ],
  termination: { maxNodes: 8, maxTokens: 50_000, timeoutMs: 60_000 },
};

test('validateWorkflow：合法 def → ok 且 value 结构完整', () => {
  const r = validateWorkflow(validDef);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.name, 'mini-pipeline');
    assert.equal(r.value.nodes.length, 2);
    assert.equal(r.value.termination.maxNodes, 8);
  }
});

test('validateWorkflow：非法 kind / deps 引用不存在 / 含环 / 必填缺失 → errors 一次全量列明', () => {
  const bad = {
    name: 'bad',
    nodes: [
      { id: 'a', kind: 'wizard', deps: ['ghost'], config: {} },
      { id: 'b', kind: 'ci', deps: ['a'], config: {} },
      { id: 'c', kind: 'gate', deps: ['e'], config: {} },
      { id: 'e', kind: 'gate', deps: ['c'], config: {} },
    ],
    termination: { maxNodes: 8, maxTokens: 1000, timeoutMs: 1000 },
  };
  const r = validateWorkflow(bad);
  assert.equal(r.ok, false);
  if (!r.ok) {
    const joined = r.errors.join(' | ');
    assert.ok(joined.includes('wizard'), `kind 非法应列明：${joined}`);
    assert.ok(joined.includes('ghost'), `deps 引用不存在应列明：${joined}`);
    assert.ok(joined.includes('含环'), `环应列明：${joined}`);
    assert.ok(joined.includes('command'), `ci 必填项缺失应列明：${joined}`);
  }
});

test('instantiateWorkflow：def → engine 可运行（scripted 全链 done）', async () => {
  const def: WorkflowDef = {
    name: 'mini',
    nodes: [
      { id: 'dev', kind: 'agent', deps: [], config: { role: 'developer', maxSteps: 2 } },
      { id: 'ok', kind: 'ci', deps: ['dev'], config: { command: 'node -e "process.exit(0)"' } },
    ],
    termination: { maxNodes: 8, maxTokens: 50_000, timeoutMs: 60_000 },
  };
  const { name, engine } = instantiateWorkflow(def, makeDeps(mktmp('p3-t3-wf-')));
  assert.equal(name, 'mini');
  const r = await engine.run('迷你工作流');
  assert.equal(r.status, 'done');
  assert.equal(r.results['dev'].status, 'pass');
  assert.equal(r.results['ok'].status, 'pass');
});

const gateDef: WorkflowDef = {
  name: 'gate-flow',
  nodes: [
    { id: 'plan', kind: 'agent', deps: [], config: { role: 'planner', maxSteps: 2 } },
    { id: 'g', kind: 'gate', deps: ['plan'], config: { prompt: '方案确认' } },
    { id: 'build', kind: 'ci', deps: ['g'], config: { command: 'node -e "process.exit(0)"' } },
  ],
  termination: { maxNodes: 8, maxTokens: 50_000, timeoutMs: 60_000 },
};

test('gate 节点经引擎：run → paused + pendingGates=[gateId]', async () => {
  const { engine } = instantiateWorkflow(gateDef, makeDeps(mktmp('p3-t3-gate-')));
  const r = await engine.run('门禁流');
  assert.equal(r.status, 'paused');
  assert.deepEqual(r.pendingGates, ['g']);
  assert.equal(r.results['plan'].status, 'pass');
});

test('resume：approve → done 且已完成节点不重跑；reject → failed + 下游 skipped', async () => {
  // approve 路径：对象引用不变证明 plan 未重跑
  const e1 = instantiateWorkflow(gateDef, makeDeps(mktmp('p3-t3-resume-a-'))).engine;
  const r1 = await e1.run('门禁流');
  const planBefore = r1.results['plan'];
  const r2 = await e1.resume({ g: true });
  assert.equal(r2.status, 'done');
  assert.equal(r2.results['build'].status, 'pass');
  assert.equal(r2.results['plan'], planBefore, '已 pass 节点应幂等跳过（同一产物对象）');

  // reject 路径：gate failed → 下游 skipped，错误局部化接管
  const e2 = instantiateWorkflow(gateDef, makeDeps(mktmp('p3-t3-resume-r-'))).engine;
  await e2.run('门禁流');
  const r3 = await e2.resume({ g: false });
  assert.equal(r3.status, 'failed');
  assert.deepEqual(r3.failedNodes, ['g']);
  assert.equal(r3.results['build'].status, 'skipped');
});
