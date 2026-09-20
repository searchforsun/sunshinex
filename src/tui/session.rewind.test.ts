import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { AskUserRequest } from '../types';
import { resolveDataDir } from '../config/data-dir';
import { listAnchors, listSessions, parseJournalFile, readActivePointer, sessionsDir } from './session-journal';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** env 钉私有数据目录（须在 SessionController 构造前——writeSnapshot sink 的 blobsDir 构造期固定）；返回恢复函数 */
function pinDataDir(dataDir: string): () => void {
  const saved = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  return () => {
    if (saved === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = saved;
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 等待含指定子串的问题卡挂起并返回（跨两次 askUser 的 idle 空窗安全） */
async function waitQuestion(ctrl: SessionController, substr: string): Promise<AskUserRequest> {
  await waitFor(() => ctrl.getState().question?.question.includes(substr) ?? false);
  return ctrl.getState().question!;
}

async function twoTurnSession(tmp: string): Promise<SessionController> {
  const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([
    '{"done":true,"reply":"first done"}',
    '{"done":true,"reply":"second done"}',
  ]) });
  await ctrl.submit('任务一');
  await ctrl.waitIdle();
  await ctrl.submit('任务二');
  await ctrl.waitIdle();
  return ctrl;
}

test('listAnchors: 斜杠命令（含 /rewind 自身入档行）不产生锚点', () => {
  const dataDir = tmpdir('rewind-t5e-');
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(dataDir), 'sl.jsonl'), [
      '{"t":"header","v":1,"id":"sl","createdAt":"x"}',
      '{"t":"user","text":"真实任务"}',
      '{"t":"user","text":"/rewind"}',
    ].join('\n') + '\n', 'utf8');
    const anchors = listAnchors(parseJournalFile(path.join(sessionsDir(dataDir), 'sl.jsonl')));
    assert.deepEqual(anchors.map((a) => a.text), ['真实任务']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('/rewind：回退到任务二 → 对话面=仅任务一，任务二文本回填输入框，源档保留', async () => {
  const tmp = tmpdir('rewind-t5a-');
  const restore = pinDataDir(path.join(tmp, 'data'));
  try {
    const ctrl = await twoTurnSession(tmp);
    const dataDir = resolveDataDir(tmp);
    const srcId = readActivePointer(dataDir)!;

    const p = ctrl.submit('/rewind');
    const anchorsQ = await waitQuestion(ctrl, 'Rewind to which turn?');
    assert.equal(anchorsQ.options.length, 2);
    ctrl.resolveAskAnswer({ type: 'selected', labels: [anchorsQ.options[1].label] });
    const actionQ = await waitQuestion(ctrl, 'What to restore?');
    assert.deepEqual(actionQ.options.map((o) => o.label), ['conversation only']);
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['conversation only'] });
    await p;

    const s = ctrl.getState();
    assert.equal(s.status, 'idle');
    const texts = s.messages.filter((m) => m.role === 'user').map((m) => m.text);
    assert.ok(texts.includes('任务一'), '对话面应保留任务一');
    assert.ok(!texts.includes('任务二'), '任务二应被回退');
    assert.equal(ctrl.takeBackfill(), '任务二');
    assert.notEqual(readActivePointer(dataDir), srcId, '活动指针应切到分档新档');
    const metas = listSessions(dataDir);
    assert.equal(metas.length, 2);
    const branched = metas.find((m) => m.id !== srcId)!;
    assert.equal(branched.forkedFrom?.sourceSessionId, srcId);
    assert.equal(branched.forkedFrom?.kind, 'rewind');
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/rewind 含 write 轮：Restore code 把文件回退到锚点时点', async () => {
  const tmp = tmpdir('rewind-t5b-');
  const restore = pinDataDir(path.join(tmp, 'data'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'v0');
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([
      '{"phase":"act","tool":"write","input":{"path":"a.txt","content":"v1"}}',
      '{"done":true,"reply":"t1 done"}',
      '{"phase":"act","tool":"write","input":{"path":"a.txt","content":"v2"}}',
      '{"done":true,"reply":"t2 done"}',
    ]) });
    await ctrl.submit('任务一：写 v1');
    await ctrl.waitIdle();
    await ctrl.submit('任务二：写 v2');
    await ctrl.waitIdle();
    assert.equal(fs.readFileSync(path.join(tmp, 'a.txt')).toString(), 'v2');

    const p = ctrl.submit('/rewind');
    const anchorsQ = await waitQuestion(ctrl, 'Rewind to which turn?');
    ctrl.resolveAskAnswer({ type: 'selected', labels: [anchorsQ.options[1].label] });
    const actionQ = await waitQuestion(ctrl, 'What to restore?');
    assert.deepEqual(actionQ.options.map((o) => o.label), ['code and conversation', 'conversation only', 'code only']);
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['code and conversation'] });
    await p;

    assert.equal(fs.readFileSync(path.join(tmp, 'a.txt')).toString(), 'v1', '代码应回到任务二开场时点（任务一写完的 v1）');
    assert.equal(ctrl.takeBackfill(), '任务二：写 v2');
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/fork：复制平行会话，源档字节不动、两者血缘正确', async () => {
  const tmp = tmpdir('rewind-t5c-');
  const restore = pinDataDir(path.join(tmp, 'data'));
  try {
    const ctrl = await twoTurnSession(tmp);
    const dataDir = resolveDataDir(tmp);
    const srcId = readActivePointer(dataDir)!;
    const srcFile = path.join(sessionsDir(dataDir), srcId + '.jsonl');
    const srcBytes = fs.readFileSync(srcFile, 'utf8');

    const p = ctrl.submit('/fork');
    const anchorsQ = await waitQuestion(ctrl, 'Fork from which turn?');
    ctrl.resolveAskAnswer({ type: 'selected', labels: [anchorsQ.options[0].label] });
    await waitQuestion(ctrl, 'Fork a parallel session');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['fork'] });
    await p;

    assert.equal(fs.readFileSync(srcFile, 'utf8').startsWith(srcBytes), true, '源档前缀应逐字节不变（仅允许尾部追加：/fork 命令行与快照事件）');
    assert.equal(ctrl.takeBackfill(), '任务一');
    const metas = listSessions(dataDir);
    const fork = metas.find((m) => m.forkedFrom?.kind === 'fork')!;
    assert.equal(fork.forkedFrom?.sourceSessionId, srcId);
    assert.ok(fs.readFileSync(srcFile, 'utf8').includes('任务二'), 'fork 不丢弃未来：源档仍含任务二');
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/resume 列表血缘：fork 出的新档列表行带 ↳ 标注', async () => {
  const tmp = tmpdir('rewind-t5d-');
  const restore = pinDataDir(path.join(tmp, 'data'));
  try {
    const ctrl = await twoTurnSession(tmp);
    const dataDir = resolveDataDir(tmp);
    const srcId = readActivePointer(dataDir)!;
    const p = ctrl.submit('/fork');
    const anchorsQ = await waitQuestion(ctrl, 'Fork from which turn?');
    ctrl.resolveAskAnswer({ type: 'selected', labels: [anchorsQ.options[0].label] });
    await waitQuestion(ctrl, 'Fork a parallel session');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['fork'] });
    await p;
    const metas = listSessions(dataDir);
    const fork = metas.find((m) => m.forkedFrom)!;
    const src = metas.find((m) => !m.forkedFrom)!;
    assert.ok(fork.firstUser?.startsWith('↳'), '血缘标注应拼入列表摘要');
    assert.ok(fork.firstUser!.includes(src.id.slice(0, 8)));
    assert.equal(fork.forkedFrom?.sourceSessionId, srcId);
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
