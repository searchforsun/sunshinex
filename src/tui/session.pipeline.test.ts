import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController, shouldPumpOnIdleBeat } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { MemoryStore } from '../harness/memory/store';

/** 空闲消化接线（规格 §3.5）：任务收束回 idle 踢一次后台消化；说明行经 notice 事件进消息流 */

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-session-pipe-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    await fn(root);
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('session：任务收束后后台消化落盘，notify 说明行进消息流（用户面）', async () => {
  await withRoot(async (root) => {
    const model: ModelAdapter = {
      provider: 'openai',
      complete: async (prompt: string) => {
        if (prompt.includes('memory-extraction')) {
          return JSON.stringify({
            memories: [
              { type: 'project', description: 'session wiring', content: 'the background pipeline drains after task close', scope: 'persistent' },
            ],
          });
        }
        return '{"done":true,"reply":"ok"}';
      },
    } as unknown as ModelAdapter;
    const ctrl = new SessionController({ root, model });
    await ctrl.submit('do a thing');
    await waitFor(() => ctrl.getState().status === 'idle');
    await waitFor(
      () => ctrl.getState().messages.some((m) => m.role === 'system' && m.text.includes('[memory] saved:')),
      5000,
    );
    await waitFor(() => new MemoryStore(root).count() === 1, 5000);
  });
});

test('空闲兜底节拍判据：仅 idle 且无挂起审批且队列非空才消费（运行中零消费）', () => {
  assert.equal(shouldPumpOnIdleBeat('idle', false, 1), true);
  assert.equal(shouldPumpOnIdleBeat('running', false, 1), false, '运行中不消费（评审 Important-2 负向钉子）');
  assert.equal(shouldPumpOnIdleBeat('awaiting-approval', false, 1), false, '等审批不消费');
  assert.equal(shouldPumpOnIdleBeat('idle', true, 1), false, '有挂起审批不消费');
  assert.equal(shouldPumpOnIdleBeat('idle', false, 0), false, '无待办零调用（配额纪律）');
});

test('dispose：清空闲节拍定时器且幂等（多实例/重挂不累积）', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    ctrl.dispose();
    ctrl.dispose();
  });
});
