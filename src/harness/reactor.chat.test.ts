import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
// 测试卫生：数据目录钉文件私有目录（共享目录并发写入会破坏装配基线，reactor.test.ts 同款先例）
process.env.SUNSHINEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat-data-'));
process.env.SUNSHINEX_USER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat-uskills-'));

/**
 * T4（原生 function calling 迁移）reactor 动作消费红灯：
 * ①chat 主通道：adapter 具备 chat 能力时走消息视图（tools 字段下发、tool_calls 消费），不再发起 complete 文本协议
 * ②role:tool 配对回喂：每调用一条观察消息（tool_call_id 一一对应）；phase 旁白 = 批 assistant content
 * ③argsJson 非法 JSON → 该调用回喂纠偏（fail-bounded 不炸）；exec 混批 → 整轮按序串行执行（执行面闸门）
 * ④链行动作词汇：phase/tool-call/tool-result 行入链（buildMessages 消费面见 messages.test.ts）
 */

/** chat 面测试桩：按脚本逐轮出牌 */
class ChatStub implements ModelAdapter {
  readonly provider = 'openai';
  private i = 0;
  readonly requests: ChatRequest[] = [];
  constructor(private steps: ChatResult[]) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const s = this.steps[Math.min(this.i, this.steps.length - 1)];
    this.i += 1;
    return s;
  }
  async chatStream(req: ChatRequest, onDelta: (t: string) => void, _hooks?: unknown): Promise<ChatResult> {
    const r = await this.chat(req);
    for (const ch of r.content) onDelta(ch);
    return r;
  }
}

function makeReactor(tmp: string, model: ModelAdapter): Reactor {
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model });
}

const stop = (content: string): ChatResult => ({ finish: 'stop', content, toolCalls: [] });

test('chat 主通道端到端：tool_calls 轮执行工具、role:tool 配对回喂、stop 收束 reply', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat1-'));
  fs.writeFileSync(path.join(tmp, 'note.txt'), 'hello world');
  const adapter = new ChatStub([
    { finish: 'tool_calls', content: 'Reading the note', toolCalls: [{ id: 'c1', name: 'read', argsJson: '{"path":"note.txt"}' }] },
    stop('All done.'),
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: 'read the note' });
  assert.equal(r.done, true);
  assert.equal(r.reply, 'All done.');

  // 第二轮请求消息面：assistant(tool_calls)+content 旁白 与 role:tool 配对（id 按 T3 契约按序合成 call_N）
  const second = adapter.requests[1].messages;
  const asst = second.find((m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0);
  assert.ok(asst, 'second round must carry the assistant tool_calls message');
  if (asst.role !== 'assistant') return;
  assert.equal(asst.content, 'Reading the note');
  assert.deepEqual(asst.toolCalls, [{ id: 'call_1', name: 'read', argsJson: '{"path":"note.txt"}' }]);
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool result must be fed back as role:tool');
  if (toolMsg.role !== 'tool') return;
  assert.equal(toolMsg.toolCallId, 'call_1');
  assert.ok(toolMsg.content.includes('hello world'), 'observation content must reach the model');
  // tools 字段下发（注册表按名排序）
  const tools = adapter.requests[0].tools;
  assert.ok(Array.isArray(tools) && tools.length > 0);
  const names = tools.map((t) => t.function.name);
  assert.deepEqual([...names].sort(), names);
});

test('链行动作词汇：phase/tool-call/tool-result/reply 行入链（buildMessages 消费契约）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat2-'));
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
  const adapter = new ChatStub([
    { finish: 'tool_calls', content: 'Reading', toolCalls: [{ id: 'c1', name: 'read', argsJson: '{"path":"a.txt"}' }] },
    stop('done reply'),
  ]);
  const reactor = makeReactor(tmp, adapter);
  await reactor.run({ goal: 'g' });
  // 链行→消息映射经第二轮请求面等价断言（context 为 reactor 私有装配面，动作行词汇的消费契约在 messages.test.ts）
  const second = adapter.requests[1].messages;
  assert.ok(second.some((m) => m.role === 'tool'), 'chain rows must map to a role:tool message');
});

test('argsJson 非法 JSON：该调用回喂纠偏（fail-bounded），合法调用照常执行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat3-'));
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'content');
  const adapter = new ChatStub([
    {
      finish: 'tool_calls',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'read', argsJson: '{broken json' },
        { id: 'c2', name: 'read', argsJson: '{"path":"b.txt"}' },
      ],
    },
    stop('recovered'),
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 5 });
  assert.equal(r.done, true);
  const second = adapter.requests[1].messages;
  const toolMsgs = second.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2, 'both calls must get a role:tool feedback');
  const bad = toolMsgs.find((m) => m.role === 'tool' && m.toolCallId === 'call_1');
  assert.ok(bad && bad.role === 'tool');
  assert.match(bad.content, /not valid JSON/i);
  const good = toolMsgs.find((m) => m.role === 'tool' && m.toolCallId === 'call_2');
  assert.ok(good && good.role === 'tool');
  assert.ok(good.content.includes('content'));
});

test('exec 混入并行批：整轮按出牌顺序串行执行、每调用各得 role:tool 结果回喂', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat4-'));
  fs.writeFileSync(path.join(tmp, 'c.txt'), 'x');
  const adapter = new ChatStub([
    {
      finish: 'tool_calls',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'exec', argsJson: '{"command":"echo hi"}' },
        { id: 'c2', name: 'read', argsJson: '{"path":"c.txt"}' },
      ],
    },
    stop('ok'),
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 5 });
  assert.equal(r.done, true);
  const second = adapter.requests[1].messages;
  const toolMsgs = second.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  for (const m of toolMsgs) {
    assert.ok(m.role === 'tool' && !/rejected/i.test(m.content), 'each call must run and receive a real result, not a rejection');
  }
  const execMsg = toolMsgs.find((m) => m.role === 'tool' && /hi/.test(m.content));
  assert.ok(execMsg, 'exec must run with real output fed back');
});

test('finish=tool_calls 但调用批为空：纠偏观察回喂不炸（fail-bounded）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat5-'));
  const adapter = new ChatStub([
    { finish: 'tool_calls', content: '', toolCalls: [] },
    stop('fine'),
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 5 });
  assert.equal(r.done, true);
  assert.equal(r.reply, 'fine');
});


test('todo_write 混入并行批：整轮按出牌顺序串行执行、每调用各得真实结果回喂（混合批不拒绝）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-todo1-'));
  fs.writeFileSync(path.join(tmp, 'd.txt'), 'x');
  const adapter = new ChatStub([
    {
      finish: 'tool_calls',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'todo_write', argsJson: '{"todos":[{"text":"a","status":"pending"}]}' },
        { id: 'c2', name: 'read', argsJson: '{"path":"d.txt"}' },
      ],
    },
    stop('ok'),
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 5 });
  assert.equal(r.done, true);
  const second = adapter.requests[1].messages;
  const toolMsgs = second.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  for (const m of toolMsgs) {
    assert.ok(m.role === 'tool' && !/rejected/i.test(m.content), 'each call must run and receive a real result');
  }
});

/* ---------- 思考模式 reasoning_content 贯穿（DeepSeek/Qwen 系交错思考：工具续轮必须回传本轮思考） ---------- */

test('思考贯穿：轮思考随链行入档并回传续轮请求；新任务轮剥离旧思考；链回写持久化', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat-cot-'));
  fs.writeFileSync(path.join(tmp, 'note.txt'), 'hello world');
  const adapter = new ChatStub([
    // 任务一轮①：带思考的工具轮（有旁白 → reasoning 挂 phase 行）
    { finish: 'tool_calls', content: 'Reading', reasoning: 'CoT r1', toolCalls: [{ id: 'c1', name: 'read', argsJson: '{"path":"note.txt"}' }] },
    // 任务一轮②：带思考的工具轮（无旁白 → reasoning 挂批首调用行）
    { finish: 'tool_calls', content: '', reasoning: 'CoT r2', toolCalls: [{ id: 'c2', name: 'read', argsJson: '{"path":"note.txt"}' }] },
    stop('task one done'),
    // 任务二轮①：新任务轮的思考
    { finish: 'tool_calls', content: '', reasoning: 'CoT t2', toolCalls: [{ id: 'c3', name: 'read', argsJson: '{"path":"note.txt"}' }] },
    stop('task two done'),
  ]);
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const reactor = new Reactor({ registry, safety, context, model: adapter });

  context.appendInstructionLine('Current instruction: read note'); // 生产链指令行（session 装配面同款）：任务轮边界
  const r1 = await reactor.run({ goal: 'read note' });
  assert.equal(r1.done, true, '任务一完成');
  // 续轮请求回传：一轮②的请求中，一轮①的 assistant(tool_calls) 消息携带 CoT r1
  const round2 = adapter.requests[1]!.messages;
  const asst1 = round2.find((m): m is Extract<ChatRequest['messages'][number], { role: 'assistant' }> => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0);
  assert.equal(asst1?.reasoning, 'CoT r1', '有旁白轮思考（phase 行承载）随续轮请求回传');
  // 一轮③（stop 收束轮）的请求中，一轮②的 assistant 消息携带 CoT r2（无旁白 → 批首调用行承载）
  const round3 = adapter.requests[2]!.messages;
  const assts3 = round3.filter((m): m is Extract<ChatRequest['messages'][number], { role: 'assistant' }> => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0);
  assert.equal(assts3.length, 2, '两轮批 assistant 消息在场');
  assert.equal(assts3[1]?.reasoning, 'CoT r2', '无旁白轮思考（批首调用行承载）同口径回传');

  // 链回写持久化：reasoning 随行落会话链（resume 续开轮的事实源）
  const persisted = context.chainView().filter((s) => s.reasoning !== undefined);
  assert.deepEqual(persisted.map((s) => s.reasoning), ['CoT r1', 'CoT r2'], '轮思考随链行持久化');

  // 任务二：新任务轮请求剥离旧轮思考（当前轮思考照常回传）
  context.appendInstructionLine('Current instruction: read note again');
  const r2 = await reactor.run({ goal: 'read note again' });
  assert.equal(r2.done, true, '任务二完成');
  const t2round2 = adapter.requests[4]!.messages;
  const t2assts = t2round2.filter((m): m is Extract<ChatRequest['messages'][number], { role: 'assistant' }> => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0);
  assert.equal(t2assts.length, 3, '任务二请求含三个批 assistant 消息（任务一两轮 + 当轮）');
  assert.equal(t2assts[0]?.reasoning, undefined, '旧任务轮①思考剥离（不回传）');
  assert.equal(t2assts[1]?.reasoning, undefined, '旧任务轮②思考剥离（不回传）');
  assert.equal(t2assts[2]?.reasoning, 'CoT t2', '当前任务轮思考照常回传');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('思考贯穿·零思考轮：模型整轮无思考时续轮请求 assistant 消息 reasoning 空串在场（DeepSeek 契约：缺字段即 400）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat-cot0-'));
  fs.writeFileSync(path.join(tmp, 'note.txt'), 'hello world');
  const adapter = new ChatStub([
    // 整轮零思考（思考模式默认开但模型偶尔跳过 CoT——2026-10-03 真机 A3 形态）
    { finish: 'tool_calls', content: '', toolCalls: [{ id: 'c1', name: 'read', argsJson: '{"path":"note.txt"}' }] },
    stop('done without thinking'),
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: 'read the note' });
  assert.equal(r.done, true);
  const asst = adapter.requests[1]!.messages.find((m): m is Extract<ChatRequest['messages'][number], { role: 'assistant' }> => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0);
  assert.equal(asst?.reasoning, '', '零思考轮的 assistant 消息 reasoning 兜底空串（字段在场）');
  fs.rmSync(tmp, { recursive: true, force: true });
});
