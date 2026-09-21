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

test('/resume：>8 条分页——首页 8 条 + More…，翻页后 1 条 + Back…，Esc 取消', async () => {
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
    const page0 = ctrl.getState().question?.options.map((o) => o.label) ?? [];
    assert.equal(page0.length, 9, '首页 8 条 + More…（规格 D6：取代「仅列 8 条」手填通道）');
    assert.equal(page0[8], 'More…');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['More…'] });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const page1 = ctrl.getState().question?.options.map((o) => o.label) ?? [];
    assert.equal(page1.length, 2, '第 2 页 1 条 + Back…');
    assert.equal(page1[1], 'Back…');
    ctrl.resolveAskAnswer({ type: 'selected', labels: [page1[0]!] });
    await p;
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle', '翻页选中可恢复目标会话');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/resume：带参形态统一无法识别（裸形式守卫，规格 D2）', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']) });
    await ctrl.submit('/resume 1');
    await ctrl.submit('/resume some-id');
    const texts = messageTexts(ctrl);
    assert.ok(texts.includes('Unrecognized command. Use /help to see available commands'), '带参枚举形态统一文案');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
