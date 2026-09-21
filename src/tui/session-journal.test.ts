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

test('空会话零落盘：未建档 log 丢弃、目录不创建', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.log({ t: 'user', text: '早于建档应丢弃' });
  assert.equal(j.currentId, undefined);
  assert.equal(fs.existsSync(sessionsDir(dataDir)), false, '空会话零文件');
});

test('建档即落盘：header 立即写盘+指针；事件逐条 append（规格 2026-09-22 D1/D3）', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  const file = path.join(sessionsDir(dataDir), id + '.jsonl');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, 'header 先于任何事件在盘');
  assert.equal(readActivePointer(dataDir), id, '建档即切指针');
  j.log({ t: 'user', text: '你好' });
  j.log({ t: 'model', tier: 'large' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalEvent);
  assert.equal(lines.length, 3, 'header + 2 事件逐行在盘（无缓冲）');
  assert.equal(lines[0].t, 'header');
  assert.deepEqual(lines.slice(1), [{ t: 'user', text: '你好' }, { t: 'model', tier: 'large' }]);
  const { events } = parseJournalFile(file);
  assert.equal(events[0].t, 'header');
});

test('rotate：旧档不动、新档 header 立即写盘、指针指向新 id', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const oldId = j.currentId!;
  j.log({ t: 'user', text: '旧会话输入' });
  const newId = newSessionId();
  assert.notEqual(newId, oldId);
  j.rotate(newId);
  assert.equal(j.currentId, newId);
  j.log({ t: 'user', text: '新会话输入' });
  const oldLines = fs.readFileSync(path.join(sessionsDir(dataDir), oldId + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(oldLines.length, 2, '旧档 header+事件不动');
  const newLines = fs.readFileSync(path.join(sessionsDir(dataDir), newId + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalEvent);
  assert.equal(newLines.length, 2, '新档 header+事件');
  assert.equal(newLines[0].t, 'header');
  assert.equal(readActivePointer(dataDir), newId, '指针=轮转会话');
});

test('attach 续挂：换 id 更新指针、后续事件追加至既有文件', () => {
  const dataDir = tmp();
  const id = newSessionId();
  const a = new SessionJournal(dataDir);
  a.start();
  a.rotate(id);
  a.log({ t: 'user', text: '第一段' });
  const b = new SessionJournal(dataDir);
  b.attach(id);
  assert.equal(readActivePointer(dataDir), id, 'attach 即切指针');
  b.log({ t: 'user', text: '第二段' });
  const lines = fs.readFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.filter((l) => (JSON.parse(l) as JournalEvent).t === 'header').length, 1, 'header 不重复');
  assert.equal(lines.length, 3, 'header + 2 事件');
});

test('seal：清单非空尾追 snapshots 事件、空清单零事件（规格 D2）', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  const file = path.join(sessionsDir(dataDir), id + '.jsonl');
  j.seal([]);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, '空清单零事件');
  j.seal([{ path: 'src/a.ts', hash: 'h1' }]);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalEvent);
  assert.deepEqual(lines[1], { t: 'snapshots', files: [{ path: 'src/a.ts', hash: 'h1' }] });
});

test('指针收敛：逐事件追加不重写指针（规格 D4）', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const pointerFile = path.join(dataDir, 'sessions-active.json');
  fs.utimesSync(pointerFile, new Date(1_000_000_000), new Date(1_000_000_000)); // 预置旧 mtime，消除同毫秒写入假绿（评审 Minor M-1）
  const before = fs.statSync(pointerFile).mtimeMs;
  for (let i = 0; i < 20; i++) j.log({ t: 'msg', item: { role: 'assistant', text: 'r' + i, ts: i, seq: i } });
  assert.equal(fs.statSync(pointerFile).mtimeMs, before, '同 id 内追加零指针写');
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

test('reduceJournal：全词汇归约 + 未知事件类型跳过（additive 兼容，规格 D6）', () => {
  const r = reduceJournal([
    { t: 'header', v: 1, id: 'a', createdAt: 'x' },
    { t: 'snapshots', files: [{ path: 'a.ts', hash: 'h1' }] }, // reduce 不消费（快照属回退面非恢复面）
    JSON.parse('{"t":"future-event","x":1}') as JournalEvent, // 真未知类型（未来版本事件）：跳过不炸（switch 无 default）
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
  ] as JournalEvent[]);
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
  assert.equal(JSON.stringify(r).includes('snapshots'), false, '回放零快照泄漏');
});

test('listSessions：mtime 降序 + 首条用户输入摘要；缺目录返回空数组', () => {
  const dataDir = tmp();
  assert.deepEqual(listSessions(dataDir), []);
  const older = newSessionId();
  const newer = newSessionId();
  const a = new SessionJournal(dataDir);
  a.rotate(older);
  a.log({ t: 'user', text: '较早会话的首条输入' });
  fs.utimesSync(path.join(sessionsDir(dataDir), older + '.jsonl'), new Date(), new Date(1_000_000_000));
  const b = new SessionJournal(dataDir);
  b.rotate(newer);
  b.log({ t: 'user', text: '较新会话的首条输入' });
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
