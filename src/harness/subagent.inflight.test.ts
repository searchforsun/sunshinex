import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import type { ModelAdapter } from '../model/adapter';

/** 2026-11-27 用户报障「同步派发的子智能体显示已停止,实际运行中」：GUI 悬空 run 封口此前只认
 *  team.busy 名册，而 spawn/后台任务子代不在成员名册（设计如此）——快照须另发在飞标签，
 *  本锚锁 Runner.inFlightNames 的标签口径（事件面 finalLabel：#N 并发消歧展开）。 */
test('inFlightNames：在飞子智能体标签（同名并发 #N 展开），终态归零', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inflight-'));
  try {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const model: ModelAdapter = {
      provider: 'gate',
      chat: async () => {
        await gate;
        return { finish: 'stop', content: 'ok', toolCalls: [] };
      },
    };
    const h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false });
    h.runner.attachParent(() => ({ maxSteps: 20, tokenCap: 100_000 }), new AbortController().signal);
    const p1 = h.runner.runSubagent({ prompt: 'a', label: 'w' });
    const p2 = h.runner.runSubagent({ prompt: 'b', label: 'w' });
    assert.deepEqual(h.runner.inFlightNames().sort(), ['w', 'w#2'], '在飞标签=事件面 finalLabel 口径');
    release();
    await Promise.all([p1, p2]);
    assert.deepEqual(h.runner.inFlightNames(), [], '终态在飞集归零（重启后恒空=悬空轮照旧封口）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
