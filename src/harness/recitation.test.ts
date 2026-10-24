import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import { RunLedger } from './ledger';
import { ContextManager } from './context';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { FileStore } from '../storage/adapter';
import { textReplyToChatFace } from '../model/chat-stub';
import { ModelAdapter } from '../model/adapter';
import { reciteEveryEnv } from '../config/termination-config';

/** O4 recitation（HARNESS-BACKLOG P2 实验件）：长循环周期性目标重申行——旋钮 SUNSHINEX_RECITE_EVERY
 *  缺省关（形态待 A/B 实验）。钉两面：①旋钮解析（软旋钮口径,非法回 0）；②开态尾追重申行（内容=链上
 *  最后一条 task 行,session 收束回写主链后 lastInstruction 可见）/ 关态零重申（换回无条件注入即红）。 */

function makeReactor(tmp: string, adapter: ModelAdapter): { reactor: Reactor; context: ContextManager } {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const reactor = new Reactor({ registry, safety, context, model: adapter, ledger: new RunLedger(store) });
  return { reactor, context };
}

function scripted(replies: string[]): ModelAdapter {
  let call = 0;
  return { provider: 'scripted', chat: textReplyToChatFace(async () => replies[Math.min(call++, replies.length - 1)]) };
}

const WRITING = [
  '{"tool":"write","input":{"path":"note.txt","content":"step1"},"done":false}',
  '{"done":true,"reply":"ok"}',
];

test('reciteEveryEnv：软旋钮解析（未设/非法回 0,正整数生效）', () => {
  const prev = process.env.SUNSHINEX_RECITE_EVERY;
  try {
    delete process.env.SUNSHINEX_RECITE_EVERY;
    assert.equal(reciteEveryEnv(), 0, '缺省关');
    for (const bad of ['abc', '-2', '0', '1.5']) {
      process.env.SUNSHINEX_RECITE_EVERY = bad;
      assert.equal(reciteEveryEnv(), 0, `非法值 ${bad} 回 0`);
    }
    process.env.SUNSHINEX_RECITE_EVERY = '5';
    assert.equal(reciteEveryEnv(), 5);
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_RECITE_EVERY;
    else process.env.SUNSHINEX_RECITE_EVERY = prev;
  }
});

test('O4 开态：每步边界尾追 [goal reminder] 重申行（内容=链上最后指令）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-recite-on-'));
  const prev = process.env.SUNSHINEX_RECITE_EVERY;
  process.env.SUNSHINEX_RECITE_EVERY = '1';
  try {
    const { reactor, context } = makeReactor(tmp, scripted(WRITING));
    context.appendInstructionLine('在 note.txt 写入 step1');
    const r = await reactor.run({ goal: 'recite-wiring' }, { maxSteps: 10 });
    assert.equal(r.done, true);
    const reminders = r.steps.filter((s) => s.observation.startsWith('[goal reminder] '));
    assert.equal(reminders.length, 1, '1 新步后恰触发一次（reciteEvery=1）');
    assert.equal(reminders[0]!.observation, '[goal reminder] 在 note.txt 写入 step1', '重申内容=链上最后指令');
    assert.equal(context.lastInstruction(), '[goal reminder] 在 note.txt 写入 step1', 'session 收束回写主链后可见');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_RECITE_EVERY;
    else process.env.SUNSHINEX_RECITE_EVERY = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('O4 关态（缺省）：零重申行——零行为变化锚', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-recite-off-'));
  const prev = process.env.SUNSHINEX_RECITE_EVERY;
  delete process.env.SUNSHINEX_RECITE_EVERY;
  try {
    const { reactor, context } = makeReactor(tmp, scripted(WRITING));
    context.appendInstructionLine('在 note.txt 写入 step1');
    const r = await reactor.run({ goal: 'recite-off' }, { maxSteps: 10 });
    assert.equal(r.done, true);
    assert.equal(r.steps.filter((s) => s.observation.startsWith('[goal reminder] ')).length, 0, '缺省零重申');
    assert.equal(context.lastInstruction(), '在 note.txt 写入 step1', '链尾仍是原始指令');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_RECITE_EVERY;
    else process.env.SUNSHINEX_RECITE_EVERY = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
