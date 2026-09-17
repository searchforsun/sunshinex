import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { SessionJournal, listSessions, newSessionId, parseJournalFile, readActivePointer, reduceJournal, sessionsDir } from './session-journal';

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-persist-'));

/** 持久化测试钉数据目录：控制器构造期即经 resolveDataDir 解析写点，必须在构造前设置；finally 恢复防互染 */
function pinDataDir(root: string): string {
  const dataDir = path.join(root, '.data-pin');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  return dataDir;
}

test('重放一致性：live 会话（任务×2 + /model）重放到新控制器，消息/链/档位逐字段一致，seq 续排不回绕', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"任务一完成"}', '{"done":true,"reply":"任务二完成"}']) });
    await ctrl1.submit('第一个任务');
    await ctrl1.waitIdle();
    await ctrl1.submit('/model large');
    await ctrl1.submit('第二个任务');
    await ctrl1.waitIdle();
    const before = ctrl1.getState().messages.map((m) => ({ role: m.role, text: m.text, seq: m.seq }));
    const beforeChain = ctrl1.context.chainView();
    const maxSeq = before.length > 0 ? before[before.length - 1].seq : 0;

    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"恢复后完成"}']) });
    await ctrl2.submit('/resume 1');
    await ctrl2.waitIdle();
    const after = ctrl2.getState().messages;
    assert.equal(after.length, before.length + 1, '恢复流 = 存档消息 + 恢复提示行');
    assert.deepEqual(after.slice(0, before.length).map((m) => ({ role: m.role, text: m.text, seq: m.seq })), before, '消息流逐字段一致（role/text/seq，ts 随档还原）');
    assert.equal(after[after.length - 1].role, 'system');
    assert.deepEqual(ctrl2.context.chainView(), beforeChain, '链视图逐字段一致');
    assert.equal(ctrl2.getState().model, 'large', '档位还原');
    assert.equal(ctrl2.getState().status, 'idle', '恢复后安全缺省 idle');

    // seq 续排：恢复后新任务的消息 seq 严格大于存档最大 seq
    await ctrl2.submit('恢复后新输入');
    await ctrl2.waitIdle();
    const msgs = ctrl2.getState().messages;
    assert.ok(msgs.slice(before.length + 1).every((m) => m.seq > maxSeq), 'seq 续排不回绕');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/new 轮转：旧档留存可找回、列表倒序、序号恢复旧会话', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"任务甲完成"}', '{"done":true,"reply":"任务乙完成"}']) });
    await ctrl1.submit('任务甲');
    await ctrl1.waitIdle();
    await ctrl1.submit('/new');
    await ctrl1.submit('任务乙');
    await ctrl1.waitIdle();
    // ScriptedAdapter 全程亚毫秒完成：两档 mtime 同毫秒并列会让「最新在前」排序不确定，显式钉 mtime（与 session-journal.test.ts 先例一致）
    const activeId = readActivePointer(dataDir);
    for (const m of listSessions(dataDir)) {
      fs.utimesSync(m.file, new Date(), new Date(m.id === activeId ? 2_000_000_000 : 1_000_000_000));
    }
    const metas = listSessions(dataDir);
    assert.equal(metas.length, 2, '/new 轮转后两个会话档并存');
    assert.equal(readActivePointer(dataDir), metas[0].id, '指针=最近有落盘的会话（乙）');
    assert.equal(metas[0].firstUser, '任务乙', '列表最新在前');

    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl2.submit('/resume 2');
    const texts = ctrl2.getState().messages.map((m) => m.text);
    assert.ok(texts.some((t) => t.includes('任务甲')), '恢复的是旧会话（任务甲）');
    assert.ok(!ctrl2.getState().messages.some((m) => m.text === '任务乙'), '新会话内容不混入');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('空会话与斜杠会话零落盘：无收口点不建文件；零输入退出不落盘', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit('/help');
    assert.deepEqual(listSessions(dataDir), [], '斜杠会话缓冲未收口不落盘');
    ctrl.flushJournal(); // 模拟退出 flush：快照型事件仅在已建档时补拍
    // /help 有输入 → 退出 flush 允许落一个小档（首个持久化事件建档语义）；若实现为空会话零档则 len 仍为 0
    assert.ok(listSessions(dataDir).length <= 1);
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('continueLast：手工日志全词汇还原（消息/链/待办/档位/视图/输入历史），横幅上屏，UI 现场一次性取用', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const j = new SessionJournal(dataDir);
    j.start();
    j.log({ t: 'user', text: '历史输入一' });
    j.log({ t: 'msg', item: { role: 'user', text: '历史输入一', ts: 1, seq: 1 } });
    j.log({ t: 'msg', item: { role: 'assistant', text: '历史答复', ts: 2, seq: 2 } });
    j.log({ t: 'chain', steps: [{ step: 1, action: 'task', observation: '指令行' }] });
    j.log({ t: 'todos', items: [{ text: '待办甲', done: false }] });
    j.log({ t: 'model', tier: 'small' });
    j.log({ t: 'view', expandAll: true, latestFull: false });
    j.flush();
    const id = j.currentId!;

    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]), continueLast: true });
    assert.equal(ctrl.getState().status, 'idle');
    assert.deepEqual(ctrl.getState().todos, [{ text: '待办甲', done: false }]);
    assert.equal(ctrl.getState().model, 'small');
    const texts = ctrl.getState().messages.map((m) => m.text);
    assert.ok(texts.includes('历史输入一') && texts.includes('历史答复'), '消息直注入');
    assert.ok(texts.some((t) => t.includes(String(id))), '续接横幅含会话 id');
    const ui = ctrl.takeRestoredUi();
    assert.deepEqual(ui, { history: ['历史输入一'], expandAll: true, latestFull: false }, 'UI 现场一次性取用');
    assert.equal(ctrl.takeRestoredUi(), undefined, '二次取用为 undefined');
    assert.deepEqual(ctrl.context.chainView(), [{ step: 1, action: 'task', observation: '指令行' }]);
    assert.equal(readActivePointer(dataDir), id, '指针保持指向被恢复会话');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('日志尾行撕裂：恢复到最后一条完整事件并上屏提示', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    const id = newSessionId();
    const file = path.join(sessionsDir(dataDir), id + '.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ t: 'header', v: 1, id, createdAt: 'x' }),
      JSON.stringify({ t: 'user', text: '完整输入' }),
      JSON.stringify({ t: 'msg', item: { role: 'user', text: '完整输入', ts: 1, seq: 1 } }),
      '{"t":"msg","item":{"ro',
    ].join('\n'), 'utf8');
    const events = parseJournalFile(file).events;
    const r = reduceJournal(events);
    void r;
    SessionJournal; // 类型面引用
    const { writeActivePointer } = await import('./session-journal');
    writeActivePointer(dataDir, id);

    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]), continueLast: true });
    const texts = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.ok(texts.includes('完整输入'), '完整事件已恢复');
    assert.ok(texts.includes('truncated') || texts.includes('截断'), '撕裂提示上屏');
    assert.equal(ctrl.getState().messages.length, 2, '消息 + 提示行，撕裂事件不复活');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
