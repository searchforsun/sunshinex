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

function makeReactor(tmp: string, adapter: { provider: string; complete: (p: string) => Promise<string> }): Reactor {
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: adapter });
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

  const r = await reactor.run({ goal: 'x' }, { maxSteps: 3, budget: { total: 300, reserve: 40 } });
  assert.equal(r.done, true);
  assert.ok(prompts.length >= 3, `应有 3 轮 prompt，实际 ${prompts.length}`);
  assert.ok(!prompts[0].includes('[压缩摘要'), '第 1 轮不应有摘要（无历史可压缩）');
  assert.ok(!prompts[1].includes('[压缩摘要'), '第 2 轮 prompt 在本轮压缩前组装，摘要注入发生在后续轮');
  assert.ok(prompts[2].includes('[压缩摘要'), '第 3 轮应注入压缩摘要');
  assert.ok(prompts[2].includes('[重读] big.txt'), '第 3 轮应注入最近文件重读');
  // 摘要会浓缩保留 step 1 文本（B1 摘要回流的预期语义）；水位线断言只针对原始 history 行（prompt 中 history 项总是以 \n 前缀拼接）
  assert.ok(!prompts[2].includes('\n1: read -> '), '水位线应滤掉压缩点前的原始 history 行');
  assert.ok(prompts[2].includes('2: exec -> step2'), '水位线后的 history 保留');
});
