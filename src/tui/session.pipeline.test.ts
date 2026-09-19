import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
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
