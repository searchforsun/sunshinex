import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reactor, ReactorDeps } from './reactor';
import type { SettlePayload } from './reactor';
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
import type { SessionEvent } from '../types';

/**
 * 会话内可见性（规格 §10 / 计划 Task 8）：settle / settleMemory 返回的说明行走「链尾 notice 行（模型面）+
 * notice 事件（用户面）」双通道；旁路纪律=抛错不倒灌任务收口；无产出（undefined）零追加零噪音。
 * 数据目录钉文件私有 tmpdir（测试卫生：快照装载受记忆索引影响，禁碰共享数据目录）。
 */

// 模块级钉扎：本文件所有用例共享（node --test 每文件独立进程，不互染）
process.env.SUNSHINEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-notice-'));

interface Fixture {
  context: ContextManager;
  events: SessionEvent[];
  run(settle?: ReactorDeps['settle'], settleMemory?: ReactorDeps['settleMemory']): Promise<{ done: boolean; reply?: string }>;
}

function makeFixture(tmp: string, scripted: string[]): Fixture {
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const events: SessionEvent[] = [];
  return {
    context,
    events,
    run: (settle, settleMemory) => {
      const reactor = new Reactor({
        registry,
        safety,
        context,
        model: new ScriptedAdapter(scripted),
        onEvent: (e) => events.push(e),
        ...(settle ? { settle } : {}),
        ...(settleMemory ? { settleMemory } : {}),
      });
      return reactor.run({ goal: 'notice 任务' }, { maxSteps: 4 });
    },
  };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-notice-'));
}

test('settle 返回说明行 → 链尾追加 action:notice 行 + 发 notice 事件（用户面）', async () => {
  const tmp = tmpdir();
  try {
    const f = makeFixture(tmp, ['{"done":true,"reply":"任务完成"}']);
    const r = await f.run(() => '[skills] learned: handle gate failures by asserting fail 0');
    assert.equal(r.done, true, 'settle 产出不改变任务收口');
    const chain = f.context.chainView();
    const notices = chain.filter((s) => s.action === 'notice');
    assert.equal(notices.length, 1, `恰好一行 notice，实际 ${notices.length}`);
    assert.equal(notices[0]?.observation, '[skills] learned: handle gate failures by asserting fail 0');
    // notice 行必须位于 reply 行之后（链尾追加，不得位移前缀）
    const replyIdx = chain.findIndex((s) => s.action === 'reply');
    const noticeIdx = chain.findIndex((s) => s.action === 'notice');
    assert.ok(replyIdx >= 0 && noticeIdx > replyIdx, 'notice 行尾追在 reply 行之后');
    // 用户面：notice 事件（payload 带 source 与 text）
    const ev = f.events.find((e) => e.type === 'notice');
    assert.ok(ev, '应发 notice 事件');
    assert.equal(ev?.payload?.source, 'skills');
    assert.equal(ev?.payload?.text, '[skills] learned: handle gate failures by asserting fail 0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settleMemory 返回说明行 → 同双通道（source=memory）；返回 undefined 零追加零噪音', async () => {
  const tmp = tmpdir();
  try {
    const f = makeFixture(tmp, ['{"done":true,"reply":"记忆任务完成"}']);
    const r = await f.run(
      undefined,
      async () => '[memory] saved: prefers-concise-replies — read MEMORY.md to recall',
    );
    assert.equal(r.done, true);
    const notices = f.context.chainView().filter((s) => s.action === 'notice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.observation, '[memory] saved: prefers-concise-replies — read MEMORY.md to recall');
    assert.equal(f.events.find((e) => e.type === 'notice')?.payload?.source, 'memory');

    // undefined：零 notice 行、零 notice 事件
    const f2 = makeFixture(tmp, ['{"done":true,"reply":"再跑一轮"}']);
    await f2.run(() => undefined);
    assert.equal(f2.context.chainView().filter((s) => s.action === 'notice').length, 0, '无产出零追加');
    assert.equal(f2.events.filter((e) => e.type === 'notice').length, 0, '无产出零噪音');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settle 抛错 → 既有 note 行兜底、无 notice 行；settleMemory 抛错 → 静默，链路照常收口（旁路纪律）', async () => {
  const tmp = tmpdir();
  try {
    const f = makeFixture(tmp, ['{"done":true,"reply":"沉淀抛错任务"}']);
    const r = await f.run(() => {
      throw new Error('learned store exploded');
    });
    assert.equal(r.done, true, 'settle 抛错不倒灌任务成败');
    const chain = f.context.chainView();
    assert.ok(chain.some((s) => s.action === 'note' && s.observation.includes('Settle failed')), '既有 note 兜底行保留');
    assert.equal(chain.filter((s) => s.action === 'notice').length, 0, '抛错不产 notice 行');
    assert.equal(f.events.filter((e) => e.type === 'notice').length, 0, '抛错不发 notice 事件');

    const f2 = makeFixture(tmp, ['{"done":true,"reply":"提取抛错任务"}']);
    const r2 = await f2.run(undefined, async () => {
      throw new Error('extraction endpoint down');
    });
    assert.equal(r2.done, true, 'settleMemory 抛错不倒灌任务成败');
    assert.equal(f2.context.chainView().filter((s) => s.action === 'notice').length, 0, 'settleMemory 抛错零 notice 行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('全终态触发：中止收口（max-steps 耗竭）同样触发一次 settle/settleMemory，说明行照旧上屏', async () => {
  const tmp = tmpdir();
  try {
    const f = makeFixture(tmp, [
      '{"tool":"exec","input":{"command":"echo step1"},"done":false}',
      '{"tool":"exec","input":{"command":"echo step2"},"done":false}',
    ]);
    const skillSeen: SettlePayload[] = [];
    const memSeen: SettlePayload[] = [];
    const r = await f.run((p) => {
      skillSeen.push(p);
      return '[skills] learned: stopped-path lesson';
    }, async (p) => {
      memSeen.push(p);
      return '[memory] saved: stopped-path fact';
    });
    assert.equal(r.done, false, '步数耗尽未完成');
    assert.equal(skillSeen.length, 1, '中止路径触发一次 settle（D4 全终态）');
    assert.equal(skillSeen[0].outcome, 'stopped');
    assert.equal(skillSeen[0].reply, '', '无最终答复归一为空串');
    assert.ok(skillSeen[0].digest.length > 0, 'digest 承载已观察步骤');
    assert.equal(memSeen.length, 1, 'settleMemory 同点触发一次');
    assert.equal(memSeen[0].outcome, 'stopped');
    assert.deepEqual(memSeen[0], skillSeen[0], '两钩子同点同载荷');
    // 上屏通道不变：返回字符串仍走 announce（链尾 notice 行 + notice 事件）
    assert.equal(f.context.chainView().filter((s) => s.action === 'notice').length, 2, '两钩子各一行 notice');
    assert.equal(f.events.filter((e) => e.type === 'notice').length, 2, '两钩子各一发 notice 事件');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
