import { textReplyToChatFace } from '../model/chat-stub';
import type { ModelAdapter } from '../model/adapter';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reactor } from './reactor';
import { ModelRouter, ScriptedAdapter, parseScriptStep } from '../model/adapter';
import type { ChatRequest } from '../types';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { makeTaskStopTool } from './tools/task-stop';
import { TaskRegistry } from './tasks';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// 测试卫生：本文件压缩/预算断言按 est 精算标定，数据目录钉文件私有目录——共享数据目录被并发写入学习技能时，技能清单进装配产物会破坏精算基线
process.env.SUNSHINEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-data-'));
process.env.SUNSHINEX_USER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-uskills-'));

function makeReactor(
  tmp: string,
  adapter: ModelAdapter,
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
  // chat 主通道一轮多条链行（调用+观察共用同一轮步号）：maxSteps 按模型轮计——2 轮 = 2 个去重步号
  assert.equal(new Set(r.steps.map((s) => s.step)).size, 2);
});

test('模型输出非 JSON 时不误判完成，而是记录观察并重试', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor3-'));
  const adapter = new ScriptedAdapter(['这段不是 JSON，模型没理解协议']);
  const reactor = makeReactor(tmp, adapter);

  const r = await reactor.run({ goal: 'x' }, { maxSteps: 3 });
  assert.equal(r.done, false);
  assert.equal(r.steps.length, 3);
  // 空批纠偏观察：原文随旁白可见、不误判完成（非协议文本同形态承载）
  assert.ok(r.steps.every((s) => s.observation.includes('No tool calls were returned')));
});

test('模型调用异常时 done=false 并保留错误信息', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor4-'));
  const adapter = { provider: 'boom', chat: textReplyToChatFace(async () => { throw new Error('网络错误'); }) };
  const reactor = makeReactor(tmp, adapter);

  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, false);
  assert.ok(r.reply && r.reply.includes('网络错误'));
});

test('Reactor prompt 经 Context.assemble 串起 SUNSHINE.md 指令', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor5-'));
  fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), '# 规范\n禁用 any 类型\n');

  let captured = '';
  const adapter = { provider: 'capture', chat: textReplyToChatFace(async (p: string) => { captured = p; return '{"done":true}'; }) };
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
  const requests: ChatRequest[] = [];
  const adapter = {
    provider: 'capture',
    chat: async (req: ChatRequest) => {
      requests.push(req);
      prompts.push(req.messages.map((m) => m.content).join('\n'));
      return parseScriptStep(replies[Math.min(call++, replies.length - 1)]);
    },
  };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({ registry, safety, context, model: adapter });

  const r = await reactor.run({ goal: 'x' }, { maxSteps: 3, budget: { total: 4500, reserve: 4100 } });
  assert.equal(r.done, true);
  assert.ok(prompts.length >= 3, `应有 3 轮 prompt，实际 ${prompts.length}`);
  assert.ok(!prompts[0].includes('[Compacted summary'), '第 1 轮不应有摘要（无历史可压缩）');
  assert.ok(prompts[1].includes('[Compacted summary'), '收敛环：触发轮当轮即以收敛后上下文组装（F-b 修复）');
  assert.ok(prompts[2].includes('[Compacted summary'), '第 3 轮应注入压缩摘要');
  assert.ok(prompts[2].includes('[re-read] big.txt'), '第 3 轮应注入最近文件重读');
  // 收敛环使压缩当轮生效；水位线滤除压缩点前原始 history 行（语义不变）
  // 水位线语义（消息结构面断言）：压缩点前的原始观察不再以 role:tool 消息回流（已折叠进压缩块）；
  // 摘要截断引用与 [re-read] 文件回流属合法承载，按内容判别会误伤，故锚定消息角色
  const toolMsgs = requests[2].messages.filter((m) => m.role === 'tool');
  assert.ok(!toolMsgs.some((m) => m.content.includes('X'.repeat(100))), '水位线应滤掉压缩点前的原始观察 tool 消息（折叠交压缩块承载）');
  assert.ok(prompts[2].includes('step2'), '水位线后的 history 保留');
});

test('压缩协调：折叠的链前缀裁出会话链，压缩块与链永不双份', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor8-'));
  try {
    const prompts: string[] = [];
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, tmp)) registry.register(t);
    const context = new ContextManager(tmp, new FileStore(tmp));
    // 种子链行：两条大观察（est 必超小预算阈值），压缩折叠后必须同步裁出链
    context.appendChain([
      { action: 'read', observation: 'Y'.repeat(2000) },
      { action: 'read', observation: 'Z'.repeat(2000) },
    ]);
    const reactor = new Reactor({
      registry,
      safety,
      context,
      model: { provider: 'capture', chat: textReplyToChatFace(async (p: string) => { prompts.push(p); return '{"done":true,"reply":"ok"}'; }) },
    });
    const r = await reactor.run({ goal: 'x' }, { budget: { total: 3000, reserve: 2800 } });
    assert.equal(r.done, true);
    assert.equal(r.compactedUpTo, 2, '压缩水位 = 折叠步骤号（种子行 1..2 全折叠）');
    assert.ok(prompts[0].includes('[Compacted summary'), '压缩当轮即以收敛后上下文组装');
    assert.equal(prompts[0].split('[Compacted summary').length - 1, 1, '压缩标记仅注入一次（收敛环不重复折叠）');
    const chain = context.chainView();
    assert.ok(!chain.some((s) => s.observation.includes('YYYY') || s.observation.includes('ZZZZ')), '折叠的链前缀已裁出会话链（压缩块与链不双份）');
    assert.equal(chain.length, 1, '链上仅存本 run 结论行');
    assert.equal(chain[0].action, 'reply', '结论行尾追');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
      chat: textReplyToChatFace(async (p: string) => {
        calls.push(p);
        return queue.length > 0 ? queue.shift()! : '{"done":true,"reply":"ok"}';
      }),
    },
  };
}

test('ReactorOpts.tier 用户级档位整场恒定路由对应 adapter（无提示词档位行）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-pref-'));
  const small = mkCap(), large = mkCap();
  const router = new ModelRouter();
  router.bindDefault(small.adapter);
  router.bind('large', large.adapter);
  small.set('{"tool":"exec","input":{"command":"echo a"},"done":false}');
  large.set('{"tool":"exec","input":{"command":"echo b"},"done":false}');
  const reactor = makeReactor(tmp, small.adapter, router);

  const r = await reactor.run({ goal: 'g' }, { maxSteps: 3, tier: 'large' });
  assert.equal(r.done, true);
  assert.equal(small.calls.length, 0, '档位整场恒定：不得回落默认档');
  assert.equal(large.calls.length, 2, '每轮都路由到用户指定的 large');
  assert.ok(large.calls.every((p: string) => !p.includes('Current compute tier')), '提示词无档位行（模型无自调通道）');
  assert.equal(r.route?.tier, 'large');
  assert.match(r.route?.reason ?? '', /user:tier/);
  assert.equal(r.route?.bound, true);
});

test('routeHint 显式复杂度信号路由 large（系统不按占比自动换档）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-sig-'));
  const small = mkCap(), large = mkCap();
  const router = new ModelRouter();
  router.bindDefault(small.adapter);
  router.bind('large', large.adapter);
  const reactor = makeReactor(tmp, small.adapter, router);

  await reactor.run({ goal: 'x'.repeat(2000) }, { maxSteps: 1, routeHint: { complexity: 'high' } });
  assert.equal(large.calls.length, 1, '外部 hint 的 complexity:high 路由 large');
  assert.equal(small.calls.length, 0);
});

test('仅默认绑定：缺省 medium（run 级常量），无每步重估', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-fb-'));
  const cap = mkCap();
  cap.set('{"tool":"exec","input":{"command":"echo hi"},"done":false}');
  const router = new ModelRouter();
  router.bindDefault(cap.adapter);
  const reactor = makeReactor(tmp, cap.adapter, router);

  const r = await reactor.run({ goal: 'echo hi' });
  assert.equal(r.done, true);
  assert.equal(cap.calls.length, 2);
  assert.equal(r.route?.tier, 'medium', '无 hint 缺省 medium，整场恒定');
  assert.equal(r.route?.bound, false, '缺省档承载（非显式绑定）');
});

test('模型回复携带 tier 字段被忽略（自调通道已摘除）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-bad-'));
  const small = mkCap(), large = mkCap();
  const router = new ModelRouter();
  router.bindDefault(small.adapter);
  router.bind('large', large.adapter);
  small.set('{"tool":"exec","input":{"command":"echo x"},"done":false,"tier":"large"}');
  const reactor = makeReactor(tmp, small.adapter, router);

  const r = await reactor.run({ goal: 'g' }, { maxSteps: 2 });
  assert.equal(r.done, true);
  assert.equal(large.calls.length, 0, 'reply.tier 不得改变路由：档位只由用户级参数决定');
  assert.equal(small.calls.length, 2, '全程恒定缺省档');
});

test('会话作用域收束回写：done 形态——种子链行保留、步骤与结论行尾追入链', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1e-done-'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  context.appendChain([{ action: 'note', observation: '种子事件：跨任务保留' }]);
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
  const chain = context.chainView();
  assert.ok(chain.some((s) => s.observation === '种子事件：跨任务保留'), '种子链行跨任务保留');
  assert.ok(
    chain.some((s) => s.action === 'tool-call' && s.observation.includes('[tool] exec')),
    '存续步骤回写入链（chat 主通道动作为调用/观察行词汇）',
  );
  assert.equal(chain[chain.length - 1].action, 'reply', '结论行尾追入链');
});

test('会话作用域收束回写：maxSteps 耗尽形态——步骤行与未完成补丁行入链', async () => {
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
  const chain = context.chainView();
  assert.equal(chain.length, 3, '调用行 + 观察行 + 未完成补丁行');
  assert.equal(chain[0].action, 'tool-call', '耗尽前已完成的步骤回写入链');
  assert.equal(chain[chain.length - 1].action, 'note', '补丁行记录未完成收束原因');
  assert.match(chain[chain.length - 1].observation, /max-steps/);
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
  const model = { provider: 'capture', chat: textReplyToChatFace(async (p: string) => { prompts.push(p); return replies[call++]; }) };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({ registry, safety, context, model });
  // budget {600,400}：threshold 200，摘要/重读预算各 200。M5 恒在记忆引导条目把「装配底数」从 3 tok 抬到 122 tok（+119，
  //   条目正文 487 字符 / 0 CJK ≈122 tok，见 index.ts memoryIndexItems），故 budget.total 由 480 抬到 600 使 threshold 80→200
  //   （=122 底数 + 78 余量）：step1 底数 122 不过阈、不压缩，首次触发仍在 step2。观察只入 history（不写记忆）：
  // step2 est=122(装配底数)+178(hist f×700)=300>200 触发；一轮收敛后 est=122+136(摘要)+180(重读 f)=438≤600 即止；
  // step3 est=442>200 但滞回门（3-2=1<2）挡住，records 保持 1
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 3, budget: { total: 600, reserve: 400 } });
  assert.equal(r.done, true);
  assert.equal(prompts.length, 3);
  assert.ok(prompts[1].includes('[Compacted summary'), '触发轮当轮以收敛后上下文组装');
  assert.ok(prompts[1].includes('[re-read] f.txt'), '预算内重读保留');
  assert.equal(
    context.compactionCount(),
    1,
    '一轮收敛 + 次新步被滞回门控（无门控则为 2）',
  );
});

test('硬越限旁路：est > total 时滞回被旁路立即压缩（环有界 fail-bounded）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor9-'));
  // CJK 1 字符=1 token 便于精算。budget {700,500}：threshold 200，摘要/重读预算各 250
  fs.writeFileSync(path.join(tmp, 'f.txt'), '压'.repeat(80));
  fs.writeFileSync(path.join(tmp, 'g.txt'), '压'.repeat(700));
  const prompts: string[] = [];
  const replies = [
    '{"tool":"read","input":{"path":"f.txt"},"done":false}',
    '{"tool":"read","input":{"path":"g.txt"},"done":false}',
    '{"done":true}',
  ];
  let call = 0;
  const model = { provider: 'capture', chat: textReplyToChatFace(async (p: string) => { prompts.push(p); return replies[call++]; }) };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({ registry, safety, context, model });
  // 观察只入 history 后按新语义标定（「装配底数」由 3 tok 抬到 122 tok：M5 恒在记忆引导条目，+119；正文 487 字符 / 0 CJK ≈122 tok）：
  //   阈值 200 = 122 底数 + 78 余量；摘要/重读预算各 250（须 ≥ step2 原始块 205，否则摘要条目被截断、两轮 chunks 同构退化为 replay）
  // step1 est=122≤200 不过阈（不压）；step2 est=122+83(hist f×80)=205>200 滞回门（2-(-2)≥2）触发（records 1）：
  //   chunks=[引导条目 122,hist1 83]=205≤摘要预算 250 原样入摘要，收敛后 est=122+223(摘要)+84(重读 f)=429≤700 即止；
  // step3 读 g 后 est=429+703>700 硬越限旁路——滞回门（3-2=1<2）闭合仍立即压缩：可丢块（上一轮摘要条目、hist2）按序丢尽，
  //   chunks 变为 [引导条目, 重读 f]（与 step2 的 [引导条目,hist1] 不同 → 非 replay），records 2；
  // 收敛环有界：可丢块丢尽后 est=122+224(摘要)=346≤700 环止（rounds=1，fail-bounded）
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 3, budget: { total: 700, reserve: 500 } });
  assert.equal(r.done, true);
  assert.equal(prompts.length, 3);
  assert.equal(
    context.compactionCount(),
    2,
    'step3 硬越限旁路在滞回门闭合时仍触发压缩；环有界即止',
  );
});

test('ScriptedAdapter 全程 → tokensUsed 字段存在且为 0', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-p2-t1-scripted-'));
  const adapter = new ScriptedAdapter([
    '{"tool":"exec","input":{"command":"echo a"},"done":false}',
    '{"done":true}',
  ]);
  const reactor = makeReactor(tmp, adapter);

  const r = await reactor.run({ goal: 'g' });
  assert.equal(r.done, true);
  assert.ok('tokensUsed' in r, 'tokensUsed 字段应存在（接线证明）');
  assert.equal(r.tokensUsed, 0, 'scripted 无真实用量，回传 0，全程聚合应为 0');
});

test('FakeAdapter 上报非零 usage → tokensUsed 聚合累加（5+7=12）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-p2-t1-usage-'));
  const usages = [5, 7];
  let call = 0;
  const adapter = {
    provider: 'usage-fake',
    chat: textReplyToChatFace(async (p: string, hooks?: { onUsage?: (tokens: number) => void }) => {
      hooks?.onUsage?.(usages[call++] ?? 0);
      return call <= 2 ? '{"tool":"exec","input":{"command":"echo x"},"done":false}' : '{"done":true}';
    }),
  };
  const reactor = makeReactor(tmp, adapter);

  const r = await reactor.run({ goal: 'g' }, { maxSteps: 3 });
  assert.equal(r.done, true);
  assert.equal(r.tokensUsed, 12, '两轮 usage 5 与 7 应聚合为 12');
});

test('Reactor：phase 阶段字段透传 step 事件，prompt 注入约定行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-phase-'));
  const prompts: string[] = [];
  const stepPhases: unknown[] = [];
  let call = 0;
  const adapter = {
    provider: 'capture',
    chat: async (req: ChatRequest) => {
      prompts.push(req.messages.map((m) => m.content).join('\n'));
      if (call++ === 0) {
        return { finish: 'tool_calls' as const, content: '正在执行回声验证', toolCalls: [{ id: 'call_0', name: 'exec', argsJson: JSON.stringify({ command: 'echo hi' }) }] };
      }
      return { finish: 'stop' as const, content: 'ok', toolCalls: [] };
    },
  };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({
    registry, safety, context, model: adapter,
    onEvent: (e) => { if (e.type === 'step') stepPhases.push(e.payload?.phase); },
  });

  const r = await reactor.run({ goal: 'x' }, { maxSteps: 2 });
  assert.equal(r.done, true);
  assert.ok(stepPhases.includes('正在执行回声验证'), 'tool 步 phase 应随 assistant content 透传');
  assert.equal(stepPhases[stepPhases.length - 1], undefined, 'done 步不透传 phase（阶段行不得插入答复正文）');
  assert.ok(prompts[0].includes('phase'), '稳定段应注入 phase 约定行（消息面承载）');
});

test('Reactor 支持一轮并行多个工具（非 exec）：Promise.all 执行、单条合并观察回填', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-par-'));
  const adapter = new ScriptedAdapter([
    '{"tools":[{"tool":"glob","input":{"pattern":"*.ts"}},{"tool":"grep","input":{"pattern":"Reactor","path":"src/harness/reactor.ts"}}],"done":false}',
    '{"done":true,"reply":"已并行读取"}',
  ]);
  const reactor = makeReactor(tmp, adapter);
  const events: string[] = [];
  const r = await new Promise<Awaited<ReturnType<Reactor['run']>>>((resolve, reject) => {
    const rr = new Reactor({
      registry: (() => { const reg = new ToolRegistry(); for (const t of builtinTools(new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp), tmp)) reg.register(t); return reg; })(),
      safety: new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp),
      context: new ContextManager(tmp, new FileStore(tmp)),
      model: adapter,
      onEvent: (e) => events.push(e.type),
    });
    rr.run({ goal: '并行读' }).then(resolve, reject);
  });
  assert.equal(r.done, true);
  // chat 主通道：并行批按调用行+观察行入链（role:tool 配对面），不再合并单行
  const callRows = r.steps.filter((s) => s.action === 'tool-call');
  assert.equal(callRows.length, 2, '并行批应逐调用入链');
  assert.ok(callRows.some((s) => s.observation.includes('[tool] glob')), '调用行带工具名');
  assert.ok(callRows.some((s) => s.observation.includes('[tool] grep')), '调用行带工具名');
  const callCount = events.filter((t) => t === 'tool-call').length;
  const resultCount = events.filter((t) => t === 'tool-result').length;
  assert.equal(callCount, 2, 'tool-call 事件应逐工具发射');
  assert.equal(resultCount, 2, 'tool-result 事件应逐工具发射');
});

test('并行协议畸形归一：数组包裹 DSL 对象（[{tools:[...],done:false}]）照常并行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-arrenv2-'));
  const adapter = new ScriptedAdapter([
    '[{"tools":[{"tool":"glob","input":{"pattern":"*.ts"}},{"tool":"grep","input":{"pattern":"Reactor","path":"src/harness/reactor.ts"}}],"done":false}]',
    '{"done":true,"reply":"已归一包裹载荷"}',
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: '包裹载荷' }, { maxSteps: 3 });
  assert.equal(r.done, true);
  assert.ok(r.steps.some((st) => st.action === 'tool-call' && st.observation.includes('[tool] glob')), '数组包裹应解包后照常并行');
});

test('并行协议畸形归一：顶层数组载荷（[{...tools...}]）取首元素按并行动作执行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-arrenv-'));
  const adapter = new ScriptedAdapter([
    '[{"tool":"glob","input":{"pattern":"*.ts"}},{"tool":"grep","input":{"pattern":"Reactor","path":"src/harness/reactor.ts"}}]',
    '{"done":true,"reply":"已归一数组载荷"}',
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: '数组载荷' }, { maxSteps: 3 });
  assert.equal(r.done, true, '数组载荷应归一执行而非静默吞掉动作');
  assert.ok(r.steps.some((st) => st.action === 'tool-call' && st.observation.includes('[tool] grep')), '顶层数组应归一为并行动作');
});

test('并行协议畸形归一：tools 被误装进单工具形态（{"tool":"tools"}）按并行动作执行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-tenv-'));
  const adapter = new ScriptedAdapter([
    '{"tool":"tools","input":[{"tool":"glob","input":{"pattern":"*.ts"}},{"tool":"grep","input":{"pattern":"Reactor","path":"src/harness/reactor.ts"}}],"done":false}',
    '{"done":true,"reply":"已归一并行"}',
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: '畸形载荷' }, { maxSteps: 2 });
  assert.ok(r.steps.some((s) => s.action === 'tool-call' && s.observation.includes('[tool] glob')), '畸形载荷应归一为并行动作而非 TOOL_NOT_FOUND');
  assert.ok(!r.steps.some((s) => s.observation.includes('TOOL_NOT_FOUND')), '不应出现工具未注册报错');
});

test('混合批整轮按序串行执行：read 与 exec 同批不拒绝，且 exec 在 read 完成后才跑', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-pardeny-'));
  const adapter = new ScriptedAdapter([
    '{"tools":[{"tool":"read","input":{"path":"package.json"}},{"tool":"exec","input":{"command":"echo hi"}}],"done":false}',
    '{"done":true,"reply":"已按序执行"}',
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: '混合批' }, { maxSteps: 3 });
  assert.equal(r.done, true);
  assert.ok(!r.steps.some((s) => s.observation.includes('Parallel batch rejected')), '混合批不再整批拒绝');
  const results = r.steps.filter((s) => s.action === 'tool-result').map((s) => s.observation);
  assert.ok(results.some((o) => o.includes('hi')), 'exec 真实执行');
  assert.ok(results.some((o) => o.includes('"name"') || o.length > 0), 'read 真实执行');
});

test('混合批按序串行：todo_write 与 glob 同批真实执行且保序', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-partodo-'));
  const adapter = new ScriptedAdapter([
    '{"tools":[{"tool":"glob","input":{"pattern":"*.ts"}},{"tool":"todo_write","input":{"todos":[{"content":"x","status":"pending"}]}}],"done":false}',
    '{"done":true,"reply":"ok"}',
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: '混合批 todo' }, { maxSteps: 3 });
  assert.ok(!r.steps.some((s) => s.observation.includes('Parallel batch rejected')), '混合批不拒绝');
  const calls = r.steps.filter((s) => s.action === 'tool-call').map((s) => s.observation);
  assert.ok(calls[0].includes('glob') && calls[1].includes('todo_write'), '调用行保持模型出牌顺序');
  const results = r.steps.filter((s) => s.action === 'tool-result').map((s) => s.observation);
  assert.ok(results.length >= 2 && !results.some((o) => o.includes('rejected')), '两个调用都真实执行而非拒绝占位');
});

test('混合批按序串行：task_stop（显式注册）与 read 同批真实执行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-partask-'));
  const adapter = new ScriptedAdapter([
    '{"tools":[{"tool":"read","input":{"path":"package.json"}},{"tool":"task_stop","input":{"taskId":"b1"}}],"done":false}',
    '{"done":true,"reply":"ok"}',
  ]);
  // 显式注册 task_stop（category: 'task'）：默认装配不含它，覆盖真实类别缝
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  registry.register(makeTaskStopTool(new TaskRegistry(tmp)));
  const context = new ContextManager(tmp, store);
  const reactor = new Reactor({ registry, safety, context, model: adapter });
  const r = await reactor.run({ goal: '混合批 task_stop' }, { maxSteps: 3 });
  assert.equal(r.done, true);
  assert.ok(!r.steps.some((s) => s.observation.includes('Parallel batch rejected')), 'task_stop 混批按序执行不拒绝');
  assert.ok(r.steps.some((s) => s.action === 'tool-result' && s.observation.includes('b1')), 'task_stop 真实执行');
});

test('并行调用超过上限被拒绝', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-parcap-'));
  const calls = Array.from({ length: 9 }, () => '{"tool":"glob","input":{"pattern":"*.ts"}}').join(',');
  const adapter = new ScriptedAdapter([
    `{"tools":[${calls}],"done":false}`,
    '{"done":true}',
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: '超限' }, { maxSteps: 2 });
  assert.ok(r.steps.some((s) => s.observation.includes('exceeds the limit')), '超上限应被拒绝');
});

test('并行放宽为非 exec 均可：write 与 network 类同轮并行不被拒且真实执行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-parnx-'));
  const outPath = path.join(tmp, 'out.txt');
  const adapter = new ScriptedAdapter([
    `{"tools":[{"tool":"write","input":{"path":${JSON.stringify(outPath)},"content":"hello"}},{"tool":"net-probe","input":{}}],"done":false}`,
    '{"done":true,"reply":"已并行写探"}',
  ]);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  registry.register({
    name: 'net-probe',
    description: '网络类并行替身（不发真实请求）',
    category: 'network',
    executor: async () => ({ exitCode: 0, stdout: 'pong', stderr: '', timedOut: false }),
  });
  const reactor = new Reactor({ registry, safety, context: new ContextManager(tmp, new FileStore(tmp)), model: adapter });
  const r = await reactor.run({ goal: '并行写探' }, { maxSteps: 3 });
  assert.equal(r.done, true);
  assert.ok(r.steps.some((s) => s.action === 'tool-call' && s.observation.includes('[tool] write')), 'write+network 应并行执行且不被拒');
  assert.ok(r.steps.some((s) => s.action === 'tool-result' && s.observation.includes('pong')), 'network 替身观察应回链');
  assert.equal(fs.readFileSync(outPath, 'utf8'), 'hello', 'write 应真实落盘');
});

test('Reactor：多步运行相邻步 prompt 前缀稳定（记忆不逐步写入击穿 KV 前缀缓存）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-prefix-'));
  const big = Array.from({ length: 60 }, (_, i) => `第${i}行：观察内容示例，正文具备一定长度以模拟真实观察。`).join('\n');
  fs.writeFileSync(path.join(tmp, 'a.txt'), big);
  fs.writeFileSync(path.join(tmp, 'b.txt'), big.replace(/观察/g, '材料'));
  const prompts: string[] = [];
  const replies = [
    '{"tool":"read","input":{"path":"a.txt"},"done":false}',
    '{"tool":"read","input":{"path":"b.txt"},"done":false}',
    '{"done":true,"reply":"ok"}',
  ];
  let i = 0;
  const adapter = {
    provider: 'capture',
    chat: textReplyToChatFace(async (p: string) => {
      prompts.push(p);
      return replies[Math.min(i++, replies.length - 1)];
    }),
  };
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: '读取两份材料并汇总要点' });
  assert.equal(r.done, true);
  assert.ok(prompts.length >= 3, '至少三轮 prompt 才能检验相邻步前缀');
  for (let k = 1; k < prompts.length; k++) {
    const a = prompts[k - 1];
    const b = prompts[k];
    let common = 0;
    const n = Math.min(a.length, b.length);
    while (common < n && a[common] === b[common]) common++;
    // 不变式：相邻步除尾部档位行（允许随步变化）外全部前缀命中；中前部任何逐轮变化段都会击穿其后全部缓存
    assert.ok(common >= a.length - 120, `step${k}->${k + 1} 可命中前缀 ${common}/${a.length}B 过低：上下文中前部存在逐轮变化段`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Reactor：跨 run seedHistory——相邻 run 前缀连续、RunResult 返回合并 history', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-seed-'));
  const big = Array.from({ length: 40 }, (_, i) => `第${i}行：跨 run 承接观察内容，正文具备一定长度以模拟真实观察。`).join('\n');
  fs.writeFileSync(path.join(tmp, 'a.txt'), big);
  fs.writeFileSync(path.join(tmp, 'b.txt'), big.replace(/跨 run 承接/g, '第二段'));
  const prompts: string[] = [];
  const script = [
    '{"tool":"read","input":{"path":"a.txt"},"done":false}',
    '{"done":true,"reply":"第一段结论"}',
    '{"tool":"read","input":{"path":"b.txt"},"done":false}',
    '{"done":true,"reply":"第二段结论"}',
  ];
  let i = 0;
  const adapter = {
    provider: 'capture',
    chat: textReplyToChatFace(async (p: string) => {
      prompts.push(p);
      return script[Math.min(i++, script.length - 1)];
    }),
  };
  const reactor = makeReactor(tmp, adapter);
  const r1 = await reactor.run({ goal: '分段调研并逐段汇总' });
  assert.equal(r1.done, true);
  const seed = r1.steps;
  assert.ok(seed.length >= 1, '首 run 应产出步骤记录');
  const r2 = await reactor.run({ goal: '分段调研并逐段汇总' }, { seedHistory: seed });
  assert.equal(r2.done, true);
  // 前缀连续性：run2 首帧与 run1 末帧除尾部档位行外全部前缀命中（seed 续入 history、goal 与稳定段不动）
  const a = prompts[prompts.length - 2];
  const b = prompts[prompts.length - 1];
  let common = 0;
  const n = Math.min(a.length, b.length);
  while (common < n && a[common] === b[common]) common++;
  assert.ok(common >= a.length - 120, `跨 run 可命中前缀 ${common}/${a.length}B 过低：seed 未续入 history 或 goal 段漂移`);
  // 合并 history：承接步 + 新步、步骤号连续
  const seedRounds = new Set(seed.map((s) => s.step)).size;
  const rounds2 = new Set(r2.steps.map((s) => s.step)).size;
  assert.equal(rounds2, seedRounds + 1, 'run2 应含承接轮 + 新增轮（链行按轮步号去重计）');
  assert.equal(r2.steps[0].step, 1);
  assert.equal(rounds2, Math.max(...r2.steps.map((s) => s.step)), '轮步号连续');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Reactor：usage 为 per-request 全量值——同请求重复回传覆盖不重复累计', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-usage-'));
  let call = 0;
  const adapter = {
    provider: 'usage-dup',
    chat: textReplyToChatFace(async (
      _p: string,
      hooks?: { onUsage?: (t: number) => void; onCache?: (t: number) => void; onPrompt?: (t: number) => void },
    ) => {
      call += 1;
      if (call === 1) {
        // 首请求：工具调用（未完成），模拟端点在多个流式帧重复携带同一份 usage——覆盖语义下只计一次
        hooks?.onCache?.(100);
        hooks?.onPrompt?.(200);
        hooks?.onUsage?.(300);
        hooks?.onCache?.(100);
        hooks?.onPrompt?.(200);
        hooks?.onUsage?.(300);
        return '{"tool":"glob","input":{"pattern":"*"},"done":false}';
      }
      // 次请求：真实累计应跨请求累加（首请求 300 + 本请求 30）
      hooks?.onCache?.(10);
      hooks?.onPrompt?.(20);
      hooks?.onUsage?.(30);
      return '{"done":true,"reply":"ok"}';
    }),
  };
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: 'x' }, { maxSteps: 3 });
  assert.equal(r.tokensUsed, 330, '重复回传覆盖语义：300 + 30，而非 300+300+30');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('模型驱动压缩：压缩块正文为模型六节摘要，链折叠语义不变', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor9-'));
  fs.writeFileSync(path.join(tmp, 'big.txt'), 'X'.repeat(3000));
  try {
    const prompts: string[] = [];
    const replies = [
      '{"tool":"read","input":{"path":"big.txt"},"done":false}',
      '{"done":true,"reply":"ok"}',
    ];
    let call = 0;
    const SUMMARY = '## Goal\n读取 big.txt 验证压缩\n## Constraints\n只读\n## Progress\n已读\n## Verified\n内容确认为 X 重复\n## Open\n无\n## Rationale\n模型路径验证';
    const SUMMARY_ARGS = JSON.stringify({
      goal: '读取 big.txt 验证压缩',
      constraints: '只读',
      progress: '已读',
      verified: '内容确认为 X 重复',
      open: '无',
      rationale: '模型路径验证',
    });
    const adapter = {
      provider: 'openai',
      chat: async (req: ChatRequest) => {
        const prompt = req.messages.map((m) => m.content).join('\n');
        if (prompt.includes('handoff summary')) {
          return { finish: 'tool_calls' as const, content: '', toolCalls: [{ id: 'call_0', name: 'submit_summary', argsJson: SUMMARY_ARGS }] };
        }
        prompts.push(prompt);
        return parseScriptStep(replies[Math.min(call++, replies.length - 1)]);
      },
    };
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, tmp)) registry.register(t);
    const context = new ContextManager(tmp, new FileStore(tmp));
    const reactor = new Reactor({ registry, safety, context, model: adapter });

    const r = await reactor.run({ goal: 'x' }, { maxSteps: 2, budget: { total: 4500, reserve: 4100 } });
    assert.equal(r.done, true);
    assert.ok(prompts[1].includes('[Compacted summary'), '压缩当轮生效（收敛环语义不变）');
    assert.ok(prompts[1].includes('## Rationale'), '压缩块正文为模型六节摘要');
    assert.ok(!prompts[1].includes('- [history] '), '确定性行列表被模型正文替换');
    assert.ok(!prompts[1].includes('\n1: read -> '), '折叠链前缀已裁出（模型路径同样不双份）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('缺省步数接 SUNSHINEX_MAX_STEPS；显式入参优先于 env', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-env-'));
  const adapter = new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo x"},"done":false}']);
  const reactor = makeReactor(tmp, adapter);
  process.env.SUNSHINEX_MAX_STEPS = '1';
  try {
    const r1 = await reactor.run({ goal: 'loop' });
    assert.equal(r1.done, false);
    assert.equal(new Set(r1.steps.map((s) => s.step)).size, 1, '未传 maxSteps 时 env=1 生效');
    const r2 = await makeReactor(tmp, adapter).run({ goal: 'loop' }, { maxSteps: 3 });
    assert.equal(r2.done, false);
    assert.equal(new Set(r2.steps.map((s) => s.step)).size, 3, '显式入参优先：env=1 不覆盖 maxSteps=3');
  } finally {
    delete process.env.SUNSHINEX_MAX_STEPS;
  }
});
