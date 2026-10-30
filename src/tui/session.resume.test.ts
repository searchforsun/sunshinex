import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { listSessions, parseJournalFile, reduceJournal, sessionsDir } from './session-journal';
import { resolveDataDir } from '../config/data-dir';

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

/** 工作区播种（SUNSHINE.md + 技能目录；daemon.ctx-snap.test seedWorkspace 同形）：快照磁盘形态 */
function seedWorkspace(root: string, sunshine: string, skillId: string, skillDesc: string): void {
  fs.mkdirSync(path.join(root, '.sunshinex', 'skills', skillId), { recursive: true });
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), sunshine, 'utf8');
  fs.writeFileSync(
    path.join(root, '.sunshinex', 'skills', skillId, 'SKILL.md'),
    `---\nname: ${skillId}\ndescription: ${skillDesc}\n---\nbody\n`,
    'utf8',
  );
}

/** resume 选择卡驱动（既有 rig 同形）：选指定档 → restore → 回 idle */
async function resumePick(ctrl: SessionController, id: string): Promise<void> {
  await waitFor(() => ctrl.getState().status === 'awaiting-question');
  ctrl.resolveAskAnswer({ type: 'selected', labels: [id] });
  await waitFor(() => ctrl.getState().question?.question.includes('Restore this session, or fork from it?') ?? false);
  ctrl.resolveAskAnswer({ type: 'selected', labels: ['restore'] });
  await waitFor(() => ctrl.getState().status === 'idle');
}

test('resume 回种落档快照：快照不重读磁盘;档内无 ctx-snap 行回退磁盘并补出生写', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    seedWorkspace(tmp, 'v1 line\n', 'base-skill', 'base skill');
    // 参照拍：磁盘初态的快照导出（ctx-snap 行 fixture 数据面——items+sig 必须同源同拍）
    const probe = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const exported = probe.runtime.harness.context.snapshotExport();
    probe.dispose();

    // 1) 造档含 ctx-snap 行（skills='base-skill' 旧拍）→ 改磁盘（SUNSHINE.md 追加 + 新技能）→ resume
    const id1 = '20261031-snap-frozen';
    writeJournalFile(dataDir, id1, [
      { t: 'header', v: 3, id: id1, createdAt: '2026-10-31T00:00:00.000Z' },
      { t: 'chain', steps: [{ step: 1, action: 'task', observation: '旧任务' }] },
      { t: 'ctx-snap', items: exported.items, sig: exported.sig },
    ]);
    fs.appendFileSync(path.join(tmp, 'SUNSHINE.md'), 'v2 line\n', 'utf8');
    fs.mkdirSync(path.join(tmp, '.sunshinex', 'skills', 'new-skill'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.sunshinex', 'skills', 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: brand new skill\n---\nbody\n', 'utf8');

    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter([]), resumePicker: true });
    await resumePick(ctrl1, id1);
    // 快照不重读磁盘：导出面与落档行逐位相等（磁盘 v2 行与新技能未烘进）
    const snap1 = ctrl1.runtime.harness.context.snapshotExport();
    assert.deepEqual(snap1, exported, '回种后导出面与落档快照逐位相等（不重读磁盘）');
    assert.ok(!snap1.items.some((it) => it.content.includes('v2 line')), '磁盘 SUNSHINE.md 新内容未烘进快照');
    assert.ok(!snap1.items.some((it) => it.content.includes('brand new skill')), '磁盘新技能未烘进快照');
    // 回种成功零出生写追尾：档内 ctx-snap 行仍恰一行
    const events1 = parseJournalFile(path.join(dataDir, 'sessions', id1 + '.jsonl')).events;
    assert.equal(events1.filter((e) => e.t === 'ctx-snap').length, 1, '回种成功零出生写追尾');
    ctrl1.dispose();

    // 2) 造档无 ctx-snap 行（升级前旧档形态）→ resume → 回退磁盘现读 + 档尾补出生写 ctx-snap 行
    const id2 = '20261031-snap-legacy';
    const file2 = writeJournalFile(dataDir, id2, [
      { t: 'header', v: 3, id: id2, createdAt: '2026-10-31T00:00:00.000Z' },
      { t: 'chain', steps: [{ step: 1, action: 'task', observation: '旧任务' }] },
    ]);
    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter([]), resumePicker: true });
    await resumePick(ctrl2, id2);
    const snap2 = ctrl2.runtime.harness.context.snapshotExport();
    assert.ok(snap2.items.some((it) => it.content.includes('v2 line')), '旧档无行 → 回退磁盘现读（新内容在快照）');
    const tail2 = parseJournalFile(file2).events;
    assert.equal(tail2[tail2.length - 1]?.t, 'ctx-snap', 'journal 尾部补出生写 ctx-snap 行');
    assert.ok(reduceJournal(tail2).snapshot !== undefined, '补写行为合法行（归约面可读）');
    ctrl2.dispose();
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('出生写：首个持久化事件建档即铸 header+ctx-snap 档（对等 serve 出生写）', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    seedWorkspace(tmp, 'birth line\n', 'birth-skill', 'birth skill');
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('出生任务');
    await ctrl.waitIdle();
    const jid = ctrl.journal?.currentId;
    assert.ok(jid, '建档已铸 id');
    const file = path.join(sessionsDir(resolveDataDir(tmp)), `${jid}.jsonl`);
    const events = parseJournalFile(file).events;
    assert.equal(events[0]?.t, 'header', '档首 header');
    assert.equal(events[1]?.t, 'ctx-snap', '出生写紧随 header（header+ctx-snap 形态）');
    const snap = reduceJournal(events).snapshot;
    assert.ok(snap, '出生行为合法行（归约面可读）');
    assert.deepEqual(snap, ctrl.runtime.harness.context.snapshotExport(), '出生行与导出面逐位相等');
    ctrl.dispose();
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
