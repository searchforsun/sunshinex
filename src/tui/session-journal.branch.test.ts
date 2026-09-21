import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { test } from 'node:test';
import {
  branchFrom, listAnchors, parseJournalFile, readActivePointer, SessionJournal, sessionsDir,
} from './session-journal';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'journal-branch-'));
}
/** 造一个最小合法档：header + N 轮（user+msg） */
function makeJournal(dataDir: string, id: string, turns: string[]): void {
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  const lines = [`{"t":"header","v":1,"id":"${id}","createdAt":"2026-09-20T00:00:00.000Z"}`];
  for (const text of turns) {
    lines.push(`{"t":"user","text":${JSON.stringify(text)}}`);
    lines.push(`{"t":"msg","item":{"role":"assistant","text":"ok","ts":0,"seq":1}}`);
  }
  fs.writeFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), lines.join('\n') + '\n', 'utf8');
}

test('branchFrom: 前缀逐字节复制 + header 重写 + 指针切换', () => {
  const dataDir = tmpRoot();
  makeJournal(dataDir, 'src01', ['first', 'second']);
  // 源档 5 行；锚点=第 2 轮 user 行（行 3）→ upToLine=2，新档含 1..2 行
  const newId = branchFrom(dataDir, 'src01', 2, 'rewind', { now: new Date('2026-09-20T01:00:00Z') });
  assert.notEqual(newId, 'src01');
  const rawSrc = fs.readFileSync(path.join(sessionsDir(dataDir), 'src01.jsonl'), 'utf8').split('\n');
  const rawNew = fs.readFileSync(path.join(sessionsDir(dataDir), newId + '.jsonl'), 'utf8').split('\n');
  assert.equal(rawNew.length, 3); // 2 行 + 尾空串
  assert.equal(rawNew[1], rawSrc[1]); // 逐字节相等
  const header = JSON.parse(rawNew[0]);
  assert.equal(header.v, 1);
  assert.equal(header.id, newId);
  assert.deepEqual(header.forkedFrom, { sourceSessionId: 'src01', upToLine: 2, kind: 'rewind' });
  assert.equal(readActivePointer(dataDir), newId);
});

test('branchFrom: upToLine=1 产出仅 header 的空会话档', () => {
  const dataDir = tmpRoot();
  makeJournal(dataDir, 'src02', ['only']);
  const newId = branchFrom(dataDir, 'src02', 1, 'fork');
  const raw = fs.readFileSync(path.join(sessionsDir(dataDir), newId + '.jsonl'), 'utf8').split('\n');
  assert.equal(raw.length, 2);
  assert.equal(JSON.parse(raw[0]).forkedFrom.upToLine, 1);
});

test('branchFrom: 源档一个字节不动', () => {
  const dataDir = tmpRoot();
  makeJournal(dataDir, 'src03', ['a']);
  const file = path.join(sessionsDir(dataDir), 'src03.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  const beforeMtime = fs.statSync(file).mtimeMs;
  branchFrom(dataDir, 'src03', 2, 'rewind');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime);
});

test('branchFrom: 越界/坏行/缺档拒绝', () => {
  const dataDir = tmpRoot();
  makeJournal(dataDir, 'src04', ['a']);
  assert.throws(() => branchFrom(dataDir, 'src04', 0, 'rewind'), /INVALID_ARG/);
  assert.throws(() => branchFrom(dataDir, 'src04', 99, 'rewind'), /INVALID_ARG/);
  fs.writeFileSync(path.join(sessionsDir(dataDir), 'broken.jsonl'),
    '{"t":"header","v":1,"id":"broken","createdAt":"x"}\n{broken\n', 'utf8');
  assert.throws(() => branchFrom(dataDir, 'broken', 2, 'rewind'), /INVALID_ARG/);
  assert.throws(() => branchFrom(dataDir, 'no-such', 1, 'rewind'));
});

test('listAnchors: 行号 1-based 且与 user 事件对应', () => {
  const dataDir = tmpRoot();
  makeJournal(dataDir, 'src05', ['first', 'second']);
  const parsed = parseJournalFile(path.join(sessionsDir(dataDir), 'src05.jsonl'));
  const anchors = listAnchors(parsed);
  assert.deepEqual(anchors.map((a) => a.line), [2, 4]);
  assert.equal(anchors[0].text, 'first');
});

test('listAnchors: 撕裂尾行不入锚点', () => {
  const dataDir = tmpRoot();
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(dataDir), 'torn.jsonl'),
    '{"t":"header","v":1,"id":"torn","createdAt":"x"}\n{"t":"user","text":"ok"}\n{"t":"msg","item":{to', 'utf8');
  const anchors = listAnchors(parseJournalFile(path.join(sessionsDir(dataDir), 'torn.jsonl')));
  assert.deepEqual(anchors.map((a) => a.line), [2]);
});
