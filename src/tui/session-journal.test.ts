import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SessionJournal,
  listSessions,
  newSessionId,
  parseJournalFile,
  readActivePointer,
  reduceJournal,
  sessionsDir,
  writeActivePointer,
  type JournalEvent,
} from './session-journal';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-jr-'));

test('newSessionId：UTC 紧凑时间戳 + 4 位随机尾，50 次无重复', () => {
  const id = newSessionId();
  assert.match(id, /^\d{8}T\d{6}Z-[0-9a-z]{4}$/);
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add(newSessionId());
  assert.equal(seen.size, 50);
});

test('空会话零落盘：未建档 log 丢弃、flush no-op、目录不创建', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.log({ t: 'user', text: '早于建档应丢弃' });
  assert.equal(j.currentId, undefined);
  assert.equal(j.pending, 0);
  assert.equal(j.flush(), false);
  assert.equal(fs.existsSync(sessionsDir(dataDir)), false, '空会话零文件');
});

test('建档→log→flush：header(v=1,id)+事件逐行落盘；缓冲空二次 flush no-op', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  j.log({ t: 'user', text: '你好' });
  j.log({ t: 'model', tier: 'large' });
  assert.equal(j.pending, 3, 'header + 2 事件');
  assert.equal(j.flush(), true);
  assert.equal(j.flush(), false, '缓冲空 flush 不写盘');
  const lines = fs.readFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalEvent);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].t, 'header');
  assert.deepEqual(lines.slice(1), [{ t: 'user', text: '你好' }, { t: 'model', tier: 'large' }]);
  const { events } = parseJournalFile(path.join(sessionsDir(dataDir), id + '.jsonl'));
  assert.equal(events[0].t, 'header');
});

test('rotate：旧档不动、新 header 入缓冲、flush 后指针指向新 id', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const oldId = j.currentId!;
  j.log({ t: 'user', text: '旧会话输入' });
  j.flush();
  const newId = newSessionId();
  assert.notEqual(newId, oldId);
  j.rotate(newId);
  assert.equal(j.currentId, newId);
  j.log({ t: 'user', text: '新会话输入' });
  j.flush();
  const oldLines = fs.readFileSync(path.join(sessionsDir(dataDir), oldId + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(oldLines.length, 2, '旧档 header+事件不动');
  const newLines = fs.readFileSync(path.join(sessionsDir(dataDir), newId + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(newLines.length, 2, '新档 header+事件');
  assert.equal(readActivePointer(dataDir), newId, '指针=最近一次 flush 的会话');
});

test('attach 续挂：后续事件追加至既有文件', () => {
  const dataDir = tmp();
  const id = newSessionId();
  const a = new SessionJournal(dataDir);
  a.start();
  const ownId = a.currentId!;
  a.rotate(id);
  a.log({ t: 'user', text: '第一段' });
  a.flush();
  const b = new SessionJournal(dataDir);
  b.attach(id);
  b.log({ t: 'user', text: '第二段' });
  b.flush();
  const lines = fs.readFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.filter((l) => (JSON.parse(l) as JournalEvent).t === 'header').length, 1, 'header 不重复');
  assert.equal(lines.length, 3, 'header + 2 事件');
  void ownId;
});

test('parseJournalFile：事件往返逐条相等；尾行撕裂与中段坏行截断并标 truncated', () => {
  const dataDir = tmp();
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  const good = path.join(sessionsDir(dataDir), 'good.jsonl');
  fs.writeFileSync(good, [
    JSON.stringify({ t: 'header', v: 1, id: 'good', createdAt: 'x' }),
    JSON.stringify({ t: 'user', text: '完整事件' }),
  ].join('\n'), 'utf8');
  const ok = parseJournalFile(good);
  assert.equal(ok.truncated, false);
  assert.equal((ok.events[1] as { t: string }).t, 'user');

  const torn = path.join(sessionsDir(dataDir), 'torn.jsonl');
  fs.writeFileSync(torn, [
    JSON.stringify({ t: 'header', v: 1, id: 'torn', createdAt: 'x' }),
    JSON.stringify({ t: 'user', text: '完整' }),
    '{"t":"user","te',
  ].join('\n'), 'utf8');
  const rt = parseJournalFile(torn);
  assert.equal(rt.truncated, true);
  assert.equal(rt.events.length, 2, '停在上条完整事件');

  const mid = path.join(sessionsDir(dataDir), 'mid.jsonl');
  fs.writeFileSync(mid, [
    JSON.stringify({ t: 'header', v: 1, id: 'mid', createdAt: 'x' }),
    '{broken',
    JSON.stringify({ t: 'user', text: '坏行之后' }),
  ].join('\n'), 'utf8');
  const rm = parseJournalFile(mid);
  assert.equal(rm.truncated, true);
  assert.equal(rm.events.length, 1);
});

test('reduceJournal：未知版本上报 version（拒载判断由调用方守卫）', () => {
  const dataDir = tmp();
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  const file = path.join(sessionsDir(dataDir), 'v99.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ t: 'header', v: 99, id: 'v99', createdAt: 'x' }),
    JSON.stringify({ t: 'user', text: 'x' }),
  ].join('\n'), 'utf8');
  const r = reduceJournal(parseJournalFile(file).events);
  assert.equal(r.version, 99);
});

test('reduceJournal：全词汇归约——链累积/压缩后态覆盖/消息直汇 nextSeq 取最大/末值覆盖 todos·model·view', () => {
  const r = reduceJournal([
    { t: 'header', v: 1, id: 'a', createdAt: 'x' },
    { t: 'user', text: '问一句' },
    { t: 'msg', item: { role: 'user', text: '问一句', ts: 1, seq: 1 } },
    { t: 'chain', steps: [{ step: 1, observation: 's1' }] },
    { t: 'chain', steps: [{ step: 2, action: 'edit', observation: 's2' }] },
    { t: 'compact', chainFrom: 1, compacted: [{ kind: 'system', content: '摘要块' }] },
    { t: 'msg', item: { role: 'assistant', text: '答一句', ts: 2, seq: 5 } },
    { t: 'todos', items: [{ text: '旧待办', done: true }] },
    { t: 'todos', items: [{ text: '新待办', done: false }] },
    { t: 'model', tier: 'small' },
    { t: 'model', tier: 'large' },
    { t: 'view', expandAll: false, latestFull: true },
  ]);
  assert.equal(r.version, 1);
  assert.deepEqual(r.history, ['问一句']);
  assert.deepEqual(r.chain, [{ step: 1, observation: 's1' }, { step: 2, action: 'edit', observation: 's2' }]);
  assert.equal(r.chainFrom, 1);
  assert.deepEqual(r.compacted, [{ kind: 'system', content: '摘要块' }]);
  assert.equal(r.messages.length, 2);
  assert.equal(r.nextSeq, 5);
  assert.deepEqual(r.todos, [{ text: '新待办', done: false }]);
  assert.equal(r.model, 'large');
  assert.deepEqual(r.view, { expandAll: false, latestFull: true });
});

test('listSessions：mtime 降序 + 首条用户输入摘要；缺目录返回空数组', () => {
  const dataDir = tmp();
  assert.deepEqual(listSessions(dataDir), []);
  const older = newSessionId();
  const newer = newSessionId();
  const a = new SessionJournal(dataDir);
  a.rotate(older);
  a.log({ t: 'user', text: '较早会话的首条输入' });
  a.flush();
  fs.utimesSync(path.join(sessionsDir(dataDir), older + '.jsonl'), new Date(), new Date(1_000_000_000));
  const b = new SessionJournal(dataDir);
  b.rotate(newer);
  b.log({ t: 'user', text: '较新会话的首条输入' });
  b.flush();
  const metas = listSessions(dataDir);
  assert.deepEqual(metas.map((m) => m.id), [newer, older], '最新在前');
  assert.equal(metas[0].firstUser, '较新会话的首条输入');
});

test('活动指针：写入后读回；无指针/损坏返回 undefined', () => {
  const dataDir = tmp();
  assert.equal(readActivePointer(dataDir), undefined);
  writeActivePointer(dataDir, 'abc-1');
  assert.equal(readActivePointer(dataDir), 'abc-1');
});
