import { textReplyToChatFace } from '../model/chat-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter } from '../model/adapter';
import type { ChatRequest } from '../types';

const DONE_REPLY = '{"done":true,"reply":"ok"}';

function makeReactor(
  tmp: string,
  adapter: ModelAdapter,
  reverseTools = false,
): { reactor: Reactor; prompts: string[]; requests: ChatRequest[]; context: ContextManager } {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  const tools = builtinTools(safety, tmp);
  for (const t of reverseTools ? [...tools].reverse() : tools) registry.register(t);
  const context = new ContextManager(tmp, store);
  const prompts: string[] = [];
  const requests: ChatRequest[] = [];
  const capture: ModelAdapter = {
    provider: 'capture',
    chat: async (req, hooks) => {
      requests.push(req);
      prompts.push(req.messages.map((m) => m.content).join('\n'));
      return adapter.chat(req, hooks);
    },
  };
  return { reactor: new Reactor({ registry, safety, context, model: capture }), prompts, requests, context };
}

function scripted(replies: string[]): ModelAdapter {
  let call = 0;
  return { provider: 'scripted', chat: textReplyToChatFace(async () => replies[Math.min(call++, replies.length - 1)] )};
}

test('前缀稳定化：相邻步严格前缀连续（无档位行，唯一差异是尾部 history 追加）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-prefix1-'));
  try {
    const { reactor, prompts, requests } = makeReactor(tmp, scripted([
      '{"tool":"read","input":{"path":"a.txt"},"done":false}',
      '{"done":true,"reply":"ok"}',
      DONE_REPLY,
    ]));
    const r = await reactor.run({ goal: '前缀验收' }, { maxSteps: 5 });
    assert.equal(r.done, true);
    assert.ok(prompts.length >= 2, `应至少两轮 prompt，实际 ${prompts.length}`);

    // 档位行整体摘除：模型档位是用户级参数（--tier //model），不进提示词
    for (const p of prompts) {
      assert.ok(!p.includes('Current compute tier'), '提示词不得再含档位行');
    }
    // 相邻步严格前缀连续：后一轮 prompt 以前一轮为逐字节前缀，唯一差异是尾部 history 追加
    for (let i = 1; i < prompts.length; i++) {
      assert.ok(prompts[i].startsWith(prompts[i - 1]), `第 ${i + 1} 轮 prompt 应以第 ${i} 轮为逐字节前缀（前缀缓存第一要义）`);
    }
    assert.ok(prompts[0].startsWith('You are the SunshineX agent'), '稳定前缀以身份段开头（英文单语）');
    // 工具清单经 tools 请求级字段下发（不进提示词文本）：按名升序、逐名齐备
    const toolNames = (requests[0].tools ?? []).map((t) => t.function.name);
    assert.ok(toolNames.length > 0, 'tools 字段应下发注册表工具');
    assert.deepEqual(toolNames, [...toolNames].sort(), 'tools 面按名升序（与注册顺序无关）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('前缀稳定化：工具清单段序与注册顺序无关（按名固定）', async () => {
  // root 已作为环境事实注入 prompt：两台 reactor 须共用同一 root，仅保留注册顺序这一变量
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-prefix2-'));
  try {
    const a = makeReactor(tmp, scripted([DONE_REPLY]));
    const b = makeReactor(tmp, scripted([DONE_REPLY]), true);
    await a.reactor.run({ goal: 'g' }, { maxSteps: 2 });
    await b.reactor.run({ goal: 'g' }, { maxSteps: 2 });
    assert.equal(a.prompts[0], b.prompts[0], '同内容不同注册顺序应产出同一 prompt');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('环境事实：提示词注入工作目录绝对路径与工具选择政策（相对 root 收敛为绝对）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-envfact-'));
  try {
    const { reactor, prompts } = makeReactor(tmp, scripted([DONE_REPLY]));
    await reactor.run({ goal: 'g' }, { maxSteps: 2 });
    const p = prompts[0];
    assert.ok(p.includes(`Current working directory (project root): ${tmp}`), '提示词应含工作目录绝对路径（环境事实）');
    assert.ok(p.includes('Tool choice:'), '提示词应含工具选择政策（专用工具优先、exec 兜底）');
    assert.ok(p.indexOf('Current working directory') > p.indexOf('Context:'), '工作目录属上下文段环境事实');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('跨任务主链连续：任务 B 首帧以任务 A 首帧为逐字节前缀（§11 只增不改）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-fork-chain-'));
  try {
    const { reactor, context, prompts } = makeReactor(tmp, scripted([
      JSON.stringify({ done: true, reply: 'A done' }),
      JSON.stringify({ done: true, reply: 'B done' }),
    ]));
    context.appendChain([{ action: 'task', observation: 'Current instruction: task A' }]);
    await reactor.run({ goal: 'task A' });
    context.appendChain([{ action: 'task', observation: 'Current instruction: task B' }]);
    await reactor.run({ goal: 'task B' });
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].startsWith(prompts[0]), '跨任务首帧必须严格前缀连续');
    assert.ok(prompts[1].includes('Current instruction: task B'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话作用域收束回写：全量步骤 + 结论行自动入链', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-fork-write-'));
  try {
    const { reactor, context } = makeReactor(tmp, scripted([JSON.stringify({ done: true, reply: '搞定' })]));
    context.appendChain([{ action: 'task', observation: 'Current instruction: do it' }]);
    await reactor.run({ goal: 'do it' });
    const chain = context.chainView();
    assert.equal(chain[chain.length - 1].action, 'reply');
    assert.equal(chain[chain.length - 1].observation, '搞定');
    assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('do it')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fork 作用域：私有执行零回写主链', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-fork-iso-'));
  try {
    const { reactor, context } = makeReactor(tmp, scripted([JSON.stringify({ done: true, reply: 'ok' })]));
    const before = context.chainView().length;
    await reactor.run({ goal: 'sub' }, { scope: 'fork' });
    assert.equal(context.chainView().length, before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('稳定段携带执行协议行（goal 槽取消后的任务锚点）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-fork-proto-'));
  try {
    const { reactor, prompts } = makeReactor(tmp, scripted([JSON.stringify({ done: true, reply: 'ok' })]));
    await reactor.run({ goal: 'anything' });
    assert.ok(prompts[0].includes('last task-instruction line'), '执行协议行必须进稳定段');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
