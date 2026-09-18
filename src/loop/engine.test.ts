import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopEngine, LoopDeps } from './engine';
import { LoopNodeBase, NodeOutput, LoopContext, CriterionResult, LoopTermination } from '../types';
import { agentNode, checkNode, gateNode, routerNode, parseCriteria, toReactorBudget } from './nodes';
import { resolveTemplate } from './templates';
import { ModelAdapter, ModelRouter, ScriptedAdapter, UsageHooks } from '../model/adapter';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 计数失败适配器：前 failTimes 次调用抛指定错误，其后返回 fallback 响应 */
class FlakyJudgeAdapter implements ModelAdapter {
  readonly provider = 'flaky';
  calls = 0;
  constructor(private failTimes: number, private error: Error, private fallback: string) {}
  async complete(): Promise<string> {
    this.calls += 1;
    if (this.calls <= this.failTimes) throw this.error;
    return this.fallback;
  }
}

/** 测试装配：真实安全链/注册表/上下文 + 注入的模型适配器（对齐 reactor.test.ts 样板） */
function makeDeps(tmp: string, model: ModelAdapter, router?: ModelRouter): LoopDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  return { safety, registry, context: new ContextManager(tmp, new FileStore(tmp)), model, ...(router ? { router } : {}) };
}

/** 记录型适配器：透传真实适配器，捕获每次 prompt 供断言注入内容 */
class RecordingAdapter implements ModelAdapter {
  readonly provider: string;
  prompts: string[] = [];
  constructor(private inner: ModelAdapter, private tokensPerCall = 0) {
    this.provider = inner.provider;
  }
  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    this.prompts.push(prompt);
    hooks?.onUsage?.(this.tokensPerCall);
    return this.inner.complete(prompt, hooks);
  }
}

/** 节点级 LoopContext（单节点直调用，不经过引擎） */
function ctxOf(state: Record<string, unknown>, over: Partial<LoopTermination> = {}): LoopContext {
  return {
    iteration: 0,
    state,
    tokensUsed: 0,
    startedAt: Date.now(),
    termination: { maxIterations: 4, maxTokens: 1000, timeoutMs: 60_000, ...over },
  };
}

const yes = (_io: unknown) => true;
const no = (_io: unknown) => false;

/** 手工节点函数形态：async 或同步返回皆可（LoopNodeFn 双形态） */
type LoopNodeFn = (ctx: LoopContext, input: NodeOutput | null) => Promise<NodeOutput> | NodeOutput;
type ScriptedNode = LoopNodeBase & { run: LoopNodeFn };

/** 手工 LoopNodeFn：scripted 应答队列，超出后重复末项；记录调用次数 */
function scriptedNode(id: string, kind: LoopNodeBase['kind'], outputs: NodeOutput[]): ScriptedNode {
  const queue = [...outputs];
  const calls = { n: 0 };
  return {
    id,
    kind,
    run: (_ctx: LoopContext, _input: NodeOutput | null): NodeOutput => {
      const out = queue[Math.min(calls.n, queue.length - 1)];
      calls.n += 1;
      return out;
    },
  };
}

const term = (over: Partial<LoopEngine['termination']> = {}) => ({
  maxIterations: 4,
  maxTokens: 1000,
  timeoutMs: 60_000,
  ...over,
});

test('LoopEngine 验收终止：agent(done) → check(pass) → status done、iterations=1', async () => {
  const engine = new LoopEngine(
    [
      scriptedNode('agent', 'agent', [{ status: 'done', reply: 'ok', tokens: 0 }]),
      scriptedNode('check', 'check', [{ status: 'pass', tokens: 0 }]),
    ],
    {} as LoopDeps,
    term(),
  );
  const r = await engine.run('完成目标');
  assert.equal(r.status, 'done');
  assert.equal(r.iterations, 1);
});

test('LoopEngine 迭代耗尽：永循环节点 + maxIterations=3 → failed、iterations=3', async () => {
  let calls = 0;
  const engine = new LoopEngine(
    [
      {
        id: 'agent',
        kind: 'agent',
        run: () => {
          calls += 1;
          return { status: 'pass' as const, tokens: 0 };
        },
      },
    ],
    {} as LoopDeps,
    term({ maxIterations: 3 }),
  );
  const r = await engine.run('永不完成');
  assert.equal(r.status, 'failed');
  assert.equal(r.iterations, 3);
  assert.equal(calls, 3);
  assert.ok(r.error !== undefined);
});

test('LoopEngine 超时：timeoutMs=5 + 慢节点（30ms 延时）→ failed 且 error 含「超时」', async () => {
  const engine = new LoopEngine(
    [
      {
        id: 'agent',
        kind: 'agent',
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { status: 'pass' as const, tokens: 0 };
        },
      },
      scriptedNode('check', 'check', [{ status: 'pass', tokens: 0 }]),
    ],
    {} as LoopDeps,
    term({ timeoutMs: 5 }),
  );
  const r = await engine.run('慢目标');
  assert.equal(r.status, 'failed');
  assert.ok((r.error ?? '').includes('timed out'));
});

test('LoopEngine 预算超支：单轮 tokens 超 maxTokens → paused（非 failed），tokensUsed 如实', async () => {
  const engine = new LoopEngine(
    [
      scriptedNode('agent', 'agent', [{ status: 'pass', tokens: 150 }]),
      scriptedNode('check', 'check', [{ status: 'pass', tokens: 0 }]),
    ],
    {} as LoopDeps,
    term({ maxTokens: 100 }),
  );
  const r = await engine.run('预算超支');
  assert.equal(r.status, 'paused');
  assert.equal(r.iterations, 1);
  assert.equal(r.tokensUsed, 150);
  assert.notEqual(r.status, 'done');
});

test('LoopEngine router：合法 route 正确跳转；未知 route fail-bounded 报错', async () => {
  const good = new LoopEngine(
    [
      scriptedNode('n1', 'router', [{ status: 'pass', route: 'n3', tokens: 0 }]),
      scriptedNode('n2', 'router', [{ status: 'fail', reply: 'wrong-node', tokens: 0 }]),
      scriptedNode('n3', 'agent', [{ status: 'done', reply: 'routed', tokens: 0 }]),
    ],
    {} as LoopDeps,
    term(),
  );
  const ok = await good.run('路由跳转');
  assert.equal(ok.status, 'done');
  assert.equal(ok.reply, 'routed');
  assert.equal(ok.iterations, 2); // n1 → n3：两个节点执行步

  const bad = new LoopEngine(
    [scriptedNode('n1', 'router', [{ status: 'pass', route: 'ghost', tokens: 0 }])],
    {} as LoopDeps,
    term(),
  );
  const failed = await bad.run('未知路由');
  assert.equal(failed.status, 'failed');
  assert.ok((failed.error ?? '').includes('ghost'));
  assert.equal(failed.iterations, 1);
});

/* ---------- P2 T4：四类节点 + /goal 自验证 ---------- */

test('T4-1 /goal 解析：内嵌段拆出 criteria；无段不静默通过', async () => {
  // 内嵌段解析（纯函数）
  const parsed = parseCriteria('任务。验收标准：c1=测试全绿; c2=构建零错');
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed!.length, 2);
  assert.deepEqual(
    parsed!.map((c) => ({ id: c.id, desc: c.desc })),
    [
      { id: 'c1', desc: '测试全绿' },
      { id: 'c2', desc: '构建零错' },
    ],
  );
  assert.equal(parseCriteria('没有验收段的普通目标'), null);

  // CheckNode：无段 → goal 整体作为隐式条件（id=condition，走模型判据；规格 §4 替换空转 fail 路径）
  const depsCond = makeDeps(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-cond-')),
    new ScriptedAdapter(['{"passed":true,"evidence":"对话里已自证"}']),
  );
  const noSeg = await checkNode(depsCond).run(ctxOf({ goal: '把 src/auth 的所有测试跑到全绿' }), null);
  assert.equal(noSeg.status, 'done');
  assert.equal(noSeg.criteria!.length, 1);
  assert.equal(noSeg.criteria![0].id, 'condition');
  assert.ok((noSeg.criteria![0].desc ?? '').includes('src/auth'));

  const ctx2 = ctxOf({ goal: '任务。验收标准：c1=测试全绿; c2=构建零错' });
  const check2 = checkNode({} as LoopDeps, { ruleCheckers: { c1: yes, c2: yes } });
  const allPass = await check2.run(ctx2, null);
  assert.equal(allPass.status, 'done');
  assert.equal(allPass.criteria!.length, 2);
  assert.ok(allPass.criteria!.every((c) => c.passed));
});

test('T4-2 模型判据兜底：router 未绑定回退 deps.model，JSON 损坏 fail-bounded', async () => {
  // 回退通道：router 为空 → 走 deps.model.complete（记录型适配器捕获判据 prompt）
  const recording = new RecordingAdapter(
    new ScriptedAdapter(['{"passed":false,"evidence":"未绿"}', '这不是JSON', '{"passed":true,"evidence":"已验证"}']),
  );
  const deps = makeDeps(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-model-')), recording);
  const ctx = ctxOf({ goal: '任务。验收标准：c1=测试全绿' });
  const out = await checkNode(deps).run(ctx, null);
  assert.equal(out.status, 'fail');
  assert.equal(out.criteria!.length, 1);
  assert.equal(out.criteria![0].passed, false);
  assert.equal(out.criteria![0].evidence, '未绿');
  assert.ok((out.reply ?? '').includes('c1'), 'fail 时 reply 列出未过项 id');
  const deficits = ctx.state.deficits as CriterionResult[];
  assert.equal(deficits.length, 1);
  assert.equal(deficits[0].id, 'c1');

  // fail-bounded：模型输出非 JSON → passed:false + 指定 evidence
  const ctxBad = ctxOf({ goal: '任务。验收标准：c9=任意' });
  const outBad = await checkNode(deps).run(ctxBad, null);
  assert.equal(outBad.status, 'fail');
  assert.equal(outBad.criteria![0].passed, false);
  assert.equal(outBad.criteria![0].evidence, 'judge returned no usable verdict');

  // 判据 prompt 携带证据：goal 与 agentReply 必须进入模型判据输入
  const ctx3 = ctxOf({ goal: '任务。验收标准：c1=测试全绿', agentReply: '测试已全绿，构建零错误' });
  await checkNode(deps).run(ctx3, null);
  const judgePrompt = [...recording.prompts].reverse().find((p) => p.includes('c1')) ?? '';
  assert.ok(judgePrompt.includes('测试已全绿，构建零错误'), '判据 prompt 应含 agentReply 证据');
});

test('T4-3 deficit 回注：check 全挂写入 deficits，Agent 重试轮 prompt 含未过项', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-deficit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const recording = new RecordingAdapter(new ScriptedAdapter(['{"done":true,"reply":"修正后完成"}']));
  const deps = makeDeps(tmp, recording);

  // 第一轮：规则全 false → fail + deficits 写入
  const ctx = ctxOf({ goal: '修复缺陷。验收标准：c1=测试全绿; c2=构建零错' });
  const check = checkNode(deps, { ruleCheckers: { c1: no, c2: no } });
  const out1 = await check.run(ctx, null);
  assert.equal(out1.status, 'fail');
  const deficits = ctx.state.deficits as CriterionResult[];
  assert.ok(Array.isArray(deficits) && deficits.length === 2);

  // 第二轮：AgentNode 重试 → 修正要求以链行进入（session 作用域缺省链基自然续接，goal 不再承载任务文本）
  const agent = agentNode(deps, { maxSteps: 2 });
  const out2 = await agent.run(ctx, null);
  assert.equal(out2.status, 'done');
  const prompt = recording.prompts[0] ?? '';
  assert.ok(/Fix requirements from last review:/.test(prompt), '重试轮 prompt 应含修正要求链行');
  assert.ok(prompt.includes('c1') && prompt.includes('测试全绿'));
  assert.ok(prompt.includes('c2') && prompt.includes('构建零错'));
});

test('T4-4 gate 断言与预算换算：toReactorBudget 纯函数 + 引擎 tokens 汇总', async (t) => {
  // gate：false → fail + reason；true → pass
  const bad = gateNode({ assert: () => ({ passed: false, reason: '构建门禁未通过' }) });
  const outBad = await bad.run(ctxOf({}), null);
  assert.equal(outBad.status, 'fail');
  assert.equal(outBad.reply, '构建门禁未通过');
  const good = gateNode({ assert: () => Promise.resolve({ passed: true }) });
  const outGood = await good.run(ctxOf({}), null);
  assert.equal(outGood.status, 'pass');

  // 预算换算纯函数
  assert.deepEqual(toReactorBudget(1000), { total: 1000, reserve: 200 });
  assert.deepEqual(toReactorBudget(7), { total: 7, reserve: 1 });
  assert.deepEqual(toReactorBudget(0), { total: 1, reserve: 0 });

  // AgentNode 集成：每次模型调用计 7 tokens（记录型包装回传 usage），引擎终止后 tokensUsed = 各节点之和
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-budget-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const recording = new RecordingAdapter(new ScriptedAdapter(['{"done":true,"reply":"一次完成"}']), 7);
  const deps = makeDeps(tmp, recording);
  const gate = gateNode({ assert: () => ({ passed: true }) });
  const agent = agentNode(deps, { maxSteps: 2 });

  const ctx = ctxOf({ goal: '带验收的目标。验收标准：c1=一切正常' });
  const outGate = await gate.run(ctx, null);
  const outAgent = await agent.run(ctx, outGate);
  assert.equal(outAgent.status, 'done');
  assert.equal(outAgent.tokens, 7, 'ScriptedAdapter 场景经记录型包装回传 usage');

  const engine = new LoopEngine([gate, agent], deps, { maxIterations: 8, maxTokens: 2000, timeoutMs: 60_000 });
  const r = await engine.run('带验收的目标。验收标准：c1=一切正常');
  assert.equal(r.status, 'done');
  assert.equal(r.iterations, 2);
  assert.equal(r.tokensUsed, outGate.tokens + outAgent.tokens);
  assert.equal(r.tokensUsed, 7);
});

test('T4-6 判据协议三值化：verdict 映射与向后兼容', async () => {
  // impossible：模型回 impossible=true（passed:false）→ CriterionResult.verdict='impossible'
  const depsImp = makeDeps(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-imp-')),
    new ScriptedAdapter(['{"passed":false,"impossible":true,"evidence":"目标依赖的模块不存在，结构性不可满足"}']),
  );
  const outImp = await checkNode(depsImp).run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(outImp.status, 'fail'); // 本任务仅协议字段，聚合终局在 Task 3
  assert.equal(outImp.criteria![0].verdict, 'impossible');

  // 映射：impossible 显式判定；met/not-yet 按 passed 推导（旧二值输出零破坏）
  const depsMap = makeDeps(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-verdict-')),
    new ScriptedAdapter([
      '{"passed":true,"impossible":false,"evidence":"ok"}',
      '{"passed":true,"evidence":"ok"}',
      '{"passed":false,"evidence":"未绿"}',
    ]),
  );
  const out1 = await checkNode(depsMap).run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(out1.criteria![0].verdict, undefined); // met 经 passed 推导，不落盘
  const out2 = await checkNode(depsMap).run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(out2.criteria![0].verdict, undefined); // 旧输出无 impossible → passed:true 推导 met
  const out3 = await checkNode(depsMap).run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(out3.criteria![0].verdict, undefined); // not-yet 经 passed 推导，不落盘

  // 规则谓词不产生 verdict（二值语义不变）
  const outRule = await checkNode({} as LoopDeps, { ruleCheckers: { c1: () => true } }).run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(outRule.status, 'done');
  assert.equal(outRule.criteria![0].verdict, undefined);
});

test('T4-7 impossible 终局：check 判定不可满足 → 引擎 failed（不烧安全网）', async () => {
  const deps = makeDeps(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-terminal-')),
    new ScriptedAdapter(['{"done":true,"reply":"已完成"}', '{"passed":false,"impossible":true,"evidence":"目标依赖已删除的模块"}']),
  );
  const r = await resolveTemplate(deps, 'test-loop').engine.run('任务。验收标准：c1=测试全绿');
  assert.equal(r.status, 'failed');
  assert.ok((r.error ?? '').includes('unsatisfiable'), 'error 携带不可满足理由');
  assert.ok(r.iterations < 100, 'impossible 短路，不烧迭代安全网');
});

test('T4-8 判据错误分级：fatal 立即终局、recoverable 重试 ≤3 后成功/暂停', async () => {
  // ① fatal（401）：不重试 → NodeOutput.terminal failed
  const fatal = new FlakyJudgeAdapter(99, new Error('401 Unauthorized'), '');
  const outFatal = await checkNode(makeDeps(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-fatal-')), fatal))
    .run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(outFatal.terminal?.status, 'failed');
  assert.ok((outFatal.terminal?.error ?? '').includes('Judge unavailable'));
  assert.equal(fatal.calls, 1, 'fatal 不重试');

  // ② recoverable：前 2 次超时、第 3 次成功 → 判定生效
  const rec = new FlakyJudgeAdapter(2, new Error('ETIMEDOUT'), '{"passed":true,"evidence":"第 3 次成功"}');
  const outRec = await checkNode(makeDeps(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-rec-')), rec))
    .run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(outRec.status, 'done');
  assert.equal(outRec.criteria![0].passed, true);
  assert.equal(outRec.criteria![0].verdict, undefined); // met 经 passed 推导不落盘（Task 1 已登记语义）
  assert.equal(rec.calls, 3, '初次 + 2 次重试');

  // ③ recoverable 耗尽：4 次全超时 → NodeOutput.terminal paused
  const exhaust = new FlakyJudgeAdapter(99, new Error('ETIMEDOUT'), '');
  const outEx = await checkNode(makeDeps(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-ex-')), exhaust))
    .run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(outEx.terminal?.status, 'paused');
  assert.ok((outEx.terminal?.error ?? '').includes('Judge temporarily unavailable'));
  assert.equal(exhaust.calls, 4, '初次 + 3 次重试上限');
});
