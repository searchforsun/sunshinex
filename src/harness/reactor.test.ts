import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reactor } from './reactor';
import { ScriptedAdapter } from '../model/adapter';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ModelRouter } from '../model/adapter';

function makeReactor(
  tmp: string,
  adapter: { provider: string; complete: (p: string) => Promise<string> },
  router?: ModelRouter,
): Reactor {
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: adapter, ...(router ? { router } : {}) });
}

test('Reactor 用 ScriptedAdapter 跑通端到端闭环', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-'));
  const adapter = new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo hi"},"done":false}', '{"done":true}']);
  const reactor = makeReactor(tmp, adapter);

  const r = await reactor.run({ goal: 'echo hi' });
  assert.equal(r.done, true);
  assert.ok(r.steps.length >= 1);
});

test('Reactor 达到 maxSteps 强制终止', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor2-'));
  const adapter = new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo x"},"done":false}']);
  const reactor = makeReactor(tmp, adapter);

  const r = await reactor.run({ goal: 'loop' }, { maxSteps: 2 });
  assert.equal(r.done, false);
  assert.equal(r.steps.length, 2);
});

test('模型输出非 JSON 时不误判完成，而是记录观察并重试', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor3-'));
  const adapter = new ScriptedAdapter(['这段不是 JSON，模型没理解协议']);
  const reactor = makeReactor(tmp, adapter);

  const r = await reactor.run({ goal: 'x' }, { maxSteps: 3 });
  assert.equal(r.done, false);
  assert.equal(r.steps.length, 3);
  assert.ok(r.steps.every((s) => s.observation.includes('非 JSON')));
});

test('模型调用异常时 done=false 并保留错误信息', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor4-'));
  const adapter = { provider: 'boom', complete: async () => { throw new Error('网络错误'); } };
  const reactor = makeReactor(tmp, adapter);

  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, false);
  assert.ok(r.reply && r.reply.includes('网络错误'));
});

test('Reactor prompt 经 Context.assemble 串起 SUNSHINE.md 指令', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor5-'));
  fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), '# 规范\n禁用 any 类型\n');

  let captured = '';
  const adapter = { provider: 'capture', complete: async (p: string) => { captured = p; return '{"done":true}'; } };
  const reactor = makeReactor(tmp, adapter);

  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, true);
  assert.ok(captured.includes('禁用 any 类型'), 'prompt 应包含 SUNSHINE.md 指令');
});

test('Read 成功后 trackFile 登记路径（recentFiles 含该文件）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor6-'));
  fs.writeFileSync(path.join(tmp, 'note.txt'), '笔记内容');
  const adapter = new ScriptedAdapter(['{"tool":"read","input":{"path":"note.txt"},"done":false}', '{"done":true}']);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({ registry, safety, context, model: adapter });

  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, true);
  assert.deepEqual(context.recentFiles(), ['note.txt']);
});

test('压缩闭环：摘要回流、重读最近文件、水位线截断旧 history', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor7-'));
  fs.writeFileSync(path.join(tmp, 'big.txt'), 'X'.repeat(3000));

  const prompts: string[] = [];
  const replies = [
    '{"tool":"read","input":{"path":"big.txt"},"done":false}',
    '{"tool":"exec","input":{"command":"echo step2"},"done":false}',
    '{"done":true,"reply":"ok"}',
  ];
  let call = 0;
  const adapter = { provider: 'capture', complete: async (p: string) => { prompts.push(p); return replies[Math.min(call++, replies.length - 1)]; } };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({ registry, safety, context, model: adapter });

  const r = await reactor.run({ goal: 'x' }, { maxSteps: 3, budget: { total: 4500, reserve: 4100 } });
  assert.equal(r.done, true);
  assert.ok(prompts.length >= 3, `应有 3 轮 prompt，实际 ${prompts.length}`);
  assert.ok(!prompts[0].includes('[压缩摘要'), '第 1 轮不应有摘要（无历史可压缩）');
  assert.ok(prompts[1].includes('[压缩摘要'), '收敛环：触发轮当轮即以收敛后上下文组装（F-b 修复）');
  assert.ok(prompts[2].includes('[压缩摘要'), '第 3 轮应注入压缩摘要');
  assert.ok(prompts[2].includes('[重读] big.txt'), '第 3 轮应注入最近文件重读');
  // 收敛环使压缩当轮生效；水位线滤除压缩点前原始 history 行（语义不变）
  assert.ok(!prompts[2].includes('\n1: read -> '), '水位线应滤掉压缩点前的原始 history 行');
  assert.ok(prompts[2].includes('2: exec -> step2'), '水位线后的 history 保留');
});

/** 可编回复的 capture adapter：记录 prompt、按需切换回复 */
function mkCap() {
  const calls: string[] = [];
  const queue: string[] = [];
  return {
    calls,
    set(...rs: string[]) { queue.push(...rs); },
    adapter: {
      provider: 'cap',
      complete: async (p: string) => {
        calls.push(p);
        return queue.length > 0 ? queue.shift()! : '{"done":true,"reply":"ok"}';
      },
    },
  };
}

test('reply.tier 作为下一轮一次性偏好路由到对应 adapter', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-pref-'));
  const small = mkCap(), large = mkCap();
  const router = new ModelRouter();
  router.bindDefault(small.adapter);
  router.bind('large', large.adapter);
  small.set('{"tool":"exec","input":{"command":"echo a"},"done":false,"tier":"large"}');
  large.set('{"tool":"exec","input":{"command":"echo b"},"done":false}');
  const reactor = makeReactor(tmp, small.adapter, router);

  const r = await reactor.run({ goal: 'g' }, { maxSteps: 3 });
  assert.equal(r.done, true);
  assert.equal(large.calls.length, 1, '第二轮消费一次性偏好路由 large');
  assert.equal(small.calls.length, 2, '首轮 small + 第三轮偏好已消费回落（medium→默认回退）');
  assert.ok(small.calls[0].includes('当前服务档位：small'), 'prompt 含本轮服务档位');
  assert.ok(large.calls[0].includes('当前服务档位：large'));
  if (r.steps[0] && r.steps[1]) {
    assert.equal(r.steps[0].tier, 'small');
    assert.equal(r.steps[1].tier, 'large');
  } else {
    assert.fail('应有至少两步记录');
  }
});

test('复杂度信号：ratio≥0.6 无偏好升档 large', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-sig-'));
  const small = mkCap(), large = mkCap();
  const router = new ModelRouter();
  router.bindDefault(small.adapter);
  router.bind('large', large.adapter);
  const reactor = makeReactor(tmp, small.adapter, router);

  await reactor.run({ goal: 'x'.repeat(2000) }, { maxSteps: 1, budget: { total: 300, reserve: 40 } });
  assert.equal(large.calls.length, 1, 'est.used≈530（goal 主导且不可压缩）/total=300 → ratio≥0.6 → large');
  assert.equal(small.calls.length, 0);
});

test('仅默认绑定的 router 行为与 1B 等价', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-fb-'));
  const cap = mkCap();
  cap.set('{"tool":"exec","input":{"command":"echo hi"},"done":false}');
  const router = new ModelRouter();
  router.bindDefault(cap.adapter);
  const reactor = makeReactor(tmp, cap.adapter, router);

  const r = await reactor.run({ goal: 'echo hi' });
  assert.equal(r.done, true);
  assert.equal(cap.calls.length, 2);
  assert.ok(r.steps.every((s) => s.tier !== undefined), '每步记录实际服务档位');
});

test('非法 tier 值被忽略且不中断循环', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-bad-'));
  const small = mkCap(), large = mkCap();
  const router = new ModelRouter();
  router.bindDefault(small.adapter);
  router.bind('large', large.adapter);
  small.set('{"tool":"exec","input":{"command":"echo x"},"done":false,"tier":"huge"}');
  const reactor = makeReactor(tmp, small.adapter, router);

  const r = await reactor.run({ goal: 'g' }, { maxSteps: 2 });
  assert.equal(r.done, true);
  assert.equal(large.calls.length, 0, '非法档位不得被路由');
  assert.equal(small.calls.length, 2, '回落信号档/默认回退');
});

test('run 收尾清退 working：done 形态 episodic 保留、working 清零', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1e-done-'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  context.memory.record('compaction', '种子事件：跨任务保留');
  const reactor = new Reactor({
    registry,
    safety,
    context,
    model: new ScriptedAdapter([
      '{"tool":"exec","input":{"command":"echo a"},"done":false}',
      '{"done":true}',
    ]),
  });
  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, true);
  const c = context.memory.counts();
  assert.equal(c.working, 0, 'working 已随任务收尾清退');
  assert.equal(c.episodic, 1, 'episodic 跨任务保留');
});

test('run 收尾清退 working：maxSteps 耗尽形态同样清退', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1e-max-'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({
    registry,
    safety,
    context,
    model: new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo a"},"done":false}']),
  });
  const r = await reactor.run({ goal: 'x' }, { maxSteps: 1 });
  assert.equal(r.done, false);
  assert.equal(context.memory.counts().working, 0);
});

test('收敛环有界且滞回生效：压缩当轮生效、下一新步被门控、records 收敛于 1', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor8-'));
  fs.writeFileSync(path.join(tmp, 'f.txt'), 'f'.repeat(700));
  const prompts: string[] = [];
  const replies = [
    '{"tool":"read","input":{"path":"f.txt"},"done":false}',
    '{"tool":"exec","input":{"command":"echo mid"},"done":false}',
    '{"done":true}',
  ];
  let call = 0;
  const model = { provider: 'capture', complete: async (p: string) => { prompts.push(p); return replies[call++]; } };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({ registry, safety, context, model });
  // budget {640,400}：threshold 240，摘要/重读预算各 200。step2 est=125(mem)+1(goal)+178(hist)=304>240 触发；
  // 一轮收敛后 est=125+1+139+181=446≤640 即止；step3 est≈450>240 但滞回门（3-2=1<2）挡住，records 保持 1
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 3, budget: { total: 640, reserve: 400 } });
  assert.equal(r.done, true);
  assert.equal(prompts.length, 3);
  assert.ok(prompts[1].includes('[压缩摘要'), '触发轮当轮以收敛后上下文组装');
  assert.ok(prompts[1].includes('[重读] f.txt'), '预算内重读保留');
  assert.equal(
    context.memory.index().filter((l) => l.startsWith('compaction: 摘要')).length,
    1,
    '一轮收敛 + 次新步被滞回门控（无门控则为 2）',
  );
});

test('硬越限旁路：est > total 时滞回被旁路立即压缩（环有界 fail-bounded）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor9-'));
  fs.writeFileSync(path.join(tmp, 'f.txt'), 'f'.repeat(700));
  const prompts: string[] = [];
  const replies = [
    '{"tool":"read","input":{"path":"f.txt"},"done":false}',
    '{"tool":"exec","input":{"command":"echo mid"},"done":false}',
    '{"done":true}',
  ];
  let call = 0;
  const model = { provider: 'capture', complete: async (p: string) => { prompts.push(p); return replies[call++]; } };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({ registry, safety, context, model });
  // budget {430,400}：threshold 30。step2 收敛环一轮即止（重注入后 est ≤ total），step3 装配 est > total 硬越限旁路滞回立即压缩；
  // records 2 = step2×1 + step3 旁路×1：无旁路则 step3 被滞回门挡住应为 1——差值即旁路语义的证明（spec §2.2/C1，计划手算期望已勘误）
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 3, budget: { total: 430, reserve: 400 } });
  assert.equal(r.done, true);
  assert.equal(prompts.length, 3);
  assert.equal(
    context.memory.index().filter((l) => l.startsWith('compaction: 摘要')).length,
    2,
    'step3 硬越限旁路滞回触发第二次压缩（无旁路则滞回挡住为 1）',
  );
});
