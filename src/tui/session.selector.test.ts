import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { listSessions } from './session-journal';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sel-'));
}

/** 持久化测试钉数据目录（沿 session.journal.test 先例）：控制器构造期即解析写点，必须在构造前设置 */
function pinDataDir(root: string): string {
  const dataDir = path.join(root, '.data-pin');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  return dataDir;
}

function messageTexts(ctrl: SessionController): string {
  return ctrl.getState().messages.map((m) => m.text).join('\n');
}

test('/resume 无参：选择器挂起（问题卡列会话）→ 选中 → 恢复目标会话', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"任务一完成"}']) });
    await ctrl1.submit('第一个任务');
    await ctrl1.waitIdle();
    const sessions = listSessions(dataDir);
    assert.equal(sessions.length, 1, '前置：已有 1 个存档会话');

    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']) });
    const p = ctrl2.submit('/resume');
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    assert.equal(ctrl2.getState().question?.options.length, 1, '选择器应列出存档会话');
    assert.equal(ctrl2.getState().question?.options[0].label, sessions[0].id);
    ctrl2.resolveAskAnswer({ type: 'selected', labels: [sessions[0].id] });
    await p;
    await ctrl2.waitIdle();
    assert.ok(messageTexts(ctrl2).includes('任务一完成'), '选中后应重放目标会话消息面');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/resume 无参：Esc 放弃 → Resume cancelled 回执且停留当前会话', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl1.submit('造档任务');
    await ctrl1.waitIdle();
    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']) });
    const p = ctrl2.submit('/resume');
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    ctrl2.resolveAskAnswer({ type: 'dismissed' });
    await p;
    await ctrl2.waitIdle();
    assert.ok(messageTexts(ctrl2).includes('Resume cancelled'), '放弃回执');
    assert.equal(ctrl2.getState().status, 'idle');
    assert.equal(ctrl2.getState().question, undefined);
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/resume：会话超过 8 条时钳制最新 8 条并尾追提示行', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    for (let i = 0; i < 9; i++) {
      const c = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
      await c.submit(`任务${i}`);
      await c.waitIdle();
    }
    assert.equal(listSessions(dataDir).length, 9, '前置：9 个存档会话');
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']) });
    const p = ctrl.submit('/resume');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    assert.equal(ctrl.getState().question?.options.length, 8, '只列最新 8 条');
    assert.ok(/older ones/.test(messageTexts(ctrl)), '尾追提示行告知其余会话用 /resume <id>');
    ctrl.resolveAskAnswer({ type: 'dismissed' });
    await p;
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
