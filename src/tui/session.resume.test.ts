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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-resume-'));
}

function pinDataDir(root: string): string {
  const dataDir = path.join(root, '.data-pin');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  return dataDir;
}

function messageTexts(ctrl: SessionController): string {
  return ctrl.getState().messages.map((m) => m.text).join('\n');
}

test('resumePicker：构造后即弹会话选择卡 → 选中 → 恢复目标会话', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"要恢复的答复"}']) });
    await ctrl1.submit('造档任务');
    await ctrl1.waitIdle();
    const sessions = listSessions(dataDir);
    assert.equal(sessions.length, 1, '前置：1 个存档会话');

    // 事件级落盘：选择卡挂起发生在首个持久化事件之前，此档由造档任务产生；期望候选排除该命令自建档的口径与 /resume 一致
    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']), resumePicker: true });
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    const labels = ctrl2.getState().question?.options.map((o) => o.label) ?? [];
    assert.ok(labels.includes(sessions[0].id), '选择卡列出存档会话');
    ctrl2.resolveAskAnswer({ type: 'selected', labels: [sessions[0].id] });
    await waitFor(() => ctrl2.getState().status === 'idle');
    assert.ok(messageTexts(ctrl2).includes('要恢复的答复'), '选定后重放目标会话消息面');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resumePicker：Esc 放弃 → 新会话继续（回执上屏）', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl1.submit('造档任务');
    await ctrl1.waitIdle();
    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']), resumePicker: true });
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    ctrl2.resolveAskAnswer({ type: 'dismissed' });
    await waitFor(() => ctrl2.getState().status === 'idle');
    assert.ok(messageTexts(ctrl2).includes('Resume cancelled'), '放弃回执上屏（与 /resume 同文案通道）');
    assert.equal(ctrl2.getState().status, 'idle');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resumePicker：空目录 → 回执「暂无已保存会话」后按新会话继续', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]), resumePicker: true });
    await waitFor(() => ctrl.getState().status === 'idle');
    assert.ok(messageTexts(ctrl).includes('暂无已保存会话') || messageTexts(ctrl).includes('No saved sessions yet'), '空目录回执');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
