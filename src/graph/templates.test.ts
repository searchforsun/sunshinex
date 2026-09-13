import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { softwarePipelineTemplate } from './templates';
import { GraphNodeOutput, GraphDeps } from '../types';
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

/** 模型调用记录器（ prompts 留档 + 统一 usage 注入） */
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

// ===== 装配基建（scripted 全 stub） =====

function makeDeps(root: string, model: ModelAdapter, tokensPerCall = 0): { deps: GraphDeps; recording: RecordingAdapter } {
  const recording = new RecordingAdapter(model, tokensPerCall);
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk'),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  return { deps: { safety, registry, context: new ContextManager(root, new FileStore(root)), model: recording }, recording };
}

const mktmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** 模板装配契约：内嵌 loop 走规则通道（goal 含验收段 + 文件级 ruleChecker），scripted 序列不被判据调用抢占 */
const PIPELINE_OPTS = (tmp: string) => ({
  goal: '实现 add 函数并保证测试正确（验收标准：c1=math.test.js 断言 add(1,2)===3）',
  ruleCheckers: {
    c1: async () => fs.readFileSync(path.join(tmp, 'math.test.js'), 'utf8').includes('assert.equal(add(1, 2), 3)'),
  },
});

// 全链路 scripted 序列（每一模型调用按序消费）：
// 1 规划师方案 2 开发者实现 3-6 loop 子流程（write v1 → done → write v2 → done） 7 审查报告
const SCRIPT = [
  `{"done":true,"reply":"方案：实现 add 函数并提供正确测试"}`,
  `{"tool":"write","input":{"path":"math.js","content":"function add(a, b) { return a + b; }\\nmodule.exports = { add };\\n"},"done":false}`,
  `{"done":true,"reply":"实现与初版测试已就绪"}`,
  `{"tool":"write","input":{"path":"math.test.js","content":"const assert = require('node:assert');\\nconst { add } = require('./math');\\nassert.equal(add(1, 2), 4);\\n"},"done":false}`,
  `{"done":true,"reply":"初版测试已生成"}`,
  `{"tool":"write","input":{"path":"math.test.js","content":"const assert = require('node:assert');\\nconst { add } = require('./math');\\nassert.equal(add(1, 2), 3);\\n"},"done":false}`,
  `{"done":true,"reply":"断言已修正为 3"}`,
  `{"done":true,"reply":"审查报告：实现与测试一致，无安全问题"}`,
];

test('P3/T4-1 全链路拓扑顺序：执行轨迹 = 依赖序（planner→developer→testLoop→reviewer→gate）', async () => {
  const tmp = mktmp('p3-t4-order-');
  const { deps } = makeDeps(tmp, new ScriptedAdapter(SCRIPT));
  const tpl = softwarePipelineTemplate(deps, PIPELINE_OPTS(tmp));
  const trace: string[] = [];
  (tpl.engine as unknown as { hooks?: { onNodeEnd?: (n: { id: string }) => void } }).hooks = {
    onNodeEnd: (n) => trace.push(n.id),
  };
  const r = await tpl.engine.run('实现一个 add 函数并保证测试正确');
  assert.equal(r.status, 'paused', '末位 gate 未审批应 paused');
  assert.deepEqual(trace, ['planner', 'developer', 'test-verify', 'reviewer', 'delivery-gate'], `执行轨迹应按依赖序：${trace.join('→')}`);
});

test('P3/T4-2 数据流：developer 任务文本应含 planner 上游产出', async () => {
  const tmp = mktmp('p3-t4-flow-');
  const { deps, recording } = makeDeps(tmp, new ScriptedAdapter(SCRIPT));
  const tpl = softwarePipelineTemplate(deps, PIPELINE_OPTS(tmp));
  await tpl.engine.run('实现一个 add 函数并保证测试正确');
  const devPrompt = recording.prompts.find((p) => p.includes('developer'));
  assert.ok(devPrompt, '应存在 developer 的模型调用');
  assert.ok(devPrompt.includes('方案：实现 add 函数'), 'planner 产出应作为上游上下文进入 developer 任务文本');
});

test('P3/T4-3 预算累计 + gate 交互：resume(approve) → done，failedNodes 空', async () => {
  const tmp = mktmp('p3-t4-gate-');
  const { deps } = makeDeps(tmp, new ScriptedAdapter(SCRIPT), 7);
  const tpl = softwarePipelineTemplate(deps, PIPELINE_OPTS(tmp));
  const r1 = await tpl.engine.run('实现一个 add 函数并保证测试正确');
  assert.equal(r1.status, 'paused');
  assert.ok(r1.tokensUsed > 0, 'agent/loop 节点真实消耗应累计');
  const r2 = await tpl.engine.resume({ 'delivery-gate': true });
  assert.equal(r2.status, 'done');
  assert.deepEqual(r2.failedNodes, []);
  assert.ok(r2.results['test-verify'].criteria && r2.results['test-verify'].criteria!.length > 0, '内嵌 loop 的验收产物应透传至图级结果');
  const nodeTokens = Object.values(r2.results).reduce((s, o) => s + o.tokens, 0);
  assert.equal(r2.tokensUsed, nodeTokens, 'Graph 总账应等于各节点 tokens 之和');
});
