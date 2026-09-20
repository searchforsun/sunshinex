import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest } from '../types';
import { MemoryStore } from './memory/store';

/** 装配接线（规格 §3.1/§3.5 D2）：收口零等待入队 → 后台完成时 notify 双通道各留一条说明行 */

function withRoot(fn: (root: string) => Promise<void> | void): Promise<void> {
  return (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-pipe-wiring-'));
    process.env.SUNSHINEX_DATA_DIR = tmp;
    try {
      const root = path.join(tmp, 'root');
      fs.mkdirSync(root, { recursive: true });
      await fn(root);
    } finally {
      delete process.env.SUNSHINEX_DATA_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
}

/** 慢提取桩：主链 chat 出牌即时（done），提取调用 submit_memory_items 延迟 30ms——用以证明收口同步路径不含模型调用 */
function slowExtractionModel(extractionCalls: { n: number }): ModelAdapter {
  return {
    provider: 'openai',
    complete: async () => {
      throw new Error('complete must not be called on the chat path');
    },
    chat: async (req: ChatRequest) => {
      const prompt = req.messages.map((m) => (m.role === 'user' ? m.content : '')).join('\n');
      if (prompt.includes('memory-extraction')) {
        extractionCalls.n += 1;
        await new Promise((r) => setTimeout(r, 30));
        return {
          finish: 'tool_calls',
          content: '',
          toolCalls: [{ id: 'call_0', name: 'submit_memory_items', argsJson: JSON.stringify({ items: [{ type: 'project', description: 'deploys via pnpm', content: 'deploys run through pnpm scripts' }] }) }],
        };
      }
      return { finish: 'stop', content: 'ok', toolCalls: [] };
    },
  } as unknown as ModelAdapter;
}

test('装配：收口零等待入队，drain 后落盘并经 notify 双通道各留一条说明', async () => {
  await withRoot(async (root) => {
    const events: Array<{ type: string; text?: string }> = [];
    const extractionCalls = { n: 0 };
    const h = new Harness({
      root,
      mode: 'dontAsk',
      model: slowExtractionModel(extractionCalls),
      onEvent: (e) => events.push(e as { type: string; text?: string }),
    });
    const r = await h.reactor.run({ goal: 'deploy the app' }, { maxSteps: 2 });
    assert.ok(r.done);
    assert.equal(new MemoryStore(root).count(), 0, 'done 收口同步路径不含模型调用（零等待，D2）');
    assert.ok(h.pipeline.pending() >= 1, '收口已入队：排队或在飞');
    await h.pipeline.drain();
    assert.equal(new MemoryStore(root).count(), 1, 'drain 后后台落盘');
    assert.equal(extractionCalls.n, 1, '提取调用恰一次');
    const notices = events.filter((e) => e.type === 'notice').map((e) => String(e.text ?? ''));
    assert.ok(
      notices.some((x) => x.includes('[memory] saved:')),
      'notify 用户面事件（模型面链行同文案）',
    );
    const chain = h.context.chainView().map((s) => s.observation).join('\n');
    assert.ok(chain.includes('[memory] saved:'), 'notify 模型面链行尾追');
  });
});

test('装配：/memory off 会话覆盖贯通到后台消费（逐项判门，非构造期冻结）', async () => {
  await withRoot(async (root) => {
    const extractionCalls = { n: 0 };
    const h = new Harness({
      root,
      mode: 'dontAsk',
      model: slowExtractionModel(extractionCalls),
      memoryOverride: false,
    });
    const r = await h.reactor.run({ goal: 'deploy the app' }, { maxSteps: 2 });
    assert.ok(r.done);
    await h.pipeline.drain();
    assert.equal(new MemoryStore(root).count(), 0, 'off 时后台零落盘');
    assert.equal(extractionCalls.n, 0, 'off 时零模型调用（不进提取）');
  });
});
