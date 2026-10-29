import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { listSessions, parseJournalFile } from './session-journal';

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
    // 选中后二级动作卡（rewind/fork 规格 §7.2 入口 B）：restore 默认首项走现行恢复
    await waitFor(() => ctrl2.getState().question?.question.includes('Restore this session, or fork from it?') ?? false);
    ctrl2.resolveAskAnswer({ type: 'selected', labels: ['restore'] });
    await waitFor(() => ctrl2.getState().status === 'idle');
    assert.ok(messageTexts(ctrl2).includes('要恢复的答复'), '选定后重放目标会话消息面');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prev;
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
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** 手工构造 v3 journal 档（崩溃档 fixture 用——事件级落盘的在飞窗口无法经正常收尾路径制造） */
function writeJournalFile(dataDir: string, id: string, events: unknown[]): string {
  const dir = path.join(dataDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

test('resume：崩溃档 seg 回灌——末个 chain 行后的在飞 seg 窗口归约成链行,恢复即落档', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    // 崩溃档：header(v:3) → seg:user('crash task') → chain:[task 行] → seg:assistant('partial answer')
    // → seg:tool(c9/read) + seg-update(result full='file body')——run 中途崩溃,无收尾 chain 行
    const id = '20261030-crash-test';
    const file = writeJournalFile(dataDir, id, [
      { t: 'header', v: 3, id, createdAt: '2026-10-30T00:00:00.000Z' },
      { t: 'seg', kind: 'user', md: 'crash task', ts: 1, seq: 1 },
      { t: 'chain', steps: [{ action: 'task', observation: 'crash task' }] },
      { t: 'seg', kind: 'assistant', md: 'partial answer', ts: 2, seq: 2 },
      { t: 'seg', kind: 'tool', md: '', ts: 3, seq: 3, callId: 'c9', name: 'read', input: { path: 'a.ts' } },
      { t: 'seg-update', seq: 3, ts: 3, result: { text: 'file body', ok: true, full: 'file body' } },
    ]);

    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]), resumePicker: true });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const sessions = listSessions(dataDir);
    assert.equal(sessions.length, 1, '前置：崩溃档入列表');
    ctrl.resolveAskAnswer({ type: 'selected', labels: [sessions[0]!.id] });
    await waitFor(() => ctrl.getState().question?.question.includes('Restore this session, or fork from it?') ?? false);
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['restore'] });
    await waitFor(() => ctrl.getState().status === 'idle');

    // ① chainView 含回灌行：reply('partial answer') 与 tool-result('file body')
    const view = ctrl.runtime.harness.context.chainView();
    assert.ok(view.some((s) => s.action === 'reply' && s.observation === 'partial answer'), '回灌 reply 行入链');
    assert.ok(view.some((s) => s.action === 'tool-result' && s.observation === 'file body'), '回灌 tool-result 行入链');

    // ② 回灌行经订阅落 journal chain 行（恢复即持久化）——读回档尾断言
    const reparsed = parseJournalFile(file);
    const tailChains = reparsed.events.filter((e) => e.t === 'chain');
    assert.ok(tailChains.length >= 2, '档尾新增 chain 事件');
    const lastSteps = tailChains[tailChains.length - 1]!.steps;
    assert.ok(lastSteps.some((s) => s.action === 'reply' && s.observation === 'partial answer'), '回灌 reply 行落档');
    assert.ok(lastSteps.some((s) => s.action === 'tool-result' && s.observation === 'file body'), '回灌 tool-result 行落档');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resume：正常档（chain 行收尾）零回灌——chainView 与 chain 事件步数一致', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    // 正常档：轮边界 chain 行收尾——seg 面无未入链在飞窗口
    const id = '20261030-normal-test';
    const file = writeJournalFile(dataDir, id, [
      { t: 'header', v: 3, id, createdAt: '2026-10-30T00:00:00.000Z' },
      { t: 'seg', kind: 'user', md: 'done task', ts: 1, seq: 1 },
      { t: 'chain', steps: [{ action: 'task', observation: 'done task' }, { action: 'reply', observation: 'final answer' }] },
    ]);

    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]), resumePicker: true });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const sessions = listSessions(dataDir);
    assert.equal(sessions.length, 1, '前置：正常档入列表');
    ctrl.resolveAskAnswer({ type: 'selected', labels: [sessions[0]!.id] });
    await waitFor(() => ctrl.getState().question?.question.includes('Restore this session, or fork from it?') ?? false);
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['restore'] });
    await waitFor(() => ctrl.getState().status === 'idle');

    const view = ctrl.runtime.harness.context.chainView();
    const reparsed = parseJournalFile(file);
    const chainSteps = reparsed.events.filter((e) => e.t === 'chain').flatMap((e) => e.steps);
    assert.equal(view.length, chainSteps.length, '零回灌：chainView 长度与 chain 事件步数一致');
    assert.equal(view.length, 2, '前置：链步数如 fixture');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prev;
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
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
