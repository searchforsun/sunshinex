import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionJournal, listSessions, purgeSession, sessionsDir, SESSIONS_INDEX_NAME } from './session-journal';

/** 会话账本可读面钉（OKF index/log 件）：INDEX.md 派生索引随 listSessions 重建；
 *  <id>.transcript.md 镜像只收 user/终态 seg 行（机械行不入镜），失败旁路不阻断主档 */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-jr-read-'));

const readTranscript = (dataDir: string, id: string): string[] =>
  fs.readFileSync(path.join(sessionsDir(dataDir), `${id}.transcript.md`), 'utf8').split('\n').filter((l) => l.length > 0);

test('listSessions 重建 INDEX.md：行含 id/时间/摘要，updatedAt 降序', () => {
  const dataDir = tmp();
  const j1 = new SessionJournal(dataDir);
  j1.start();
  j1.log({ t: 'user', text: '第一条会话的问题' });
  const j2 = new SessionJournal(dataDir);
  j2.start();
  j2.log({ t: 'user', text: '第二条会话的问题' });
  const metas = listSessions(dataDir);
  assert.equal(metas.length, 2);
  const index = fs.readFileSync(path.join(sessionsDir(dataDir), SESSIONS_INDEX_NAME), 'utf8');
  assert.ok(index.startsWith('# Session Index\n'), '索引带头部');
  const lines = index.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 2, '两会话两行');
  assert.ok(lines[0]!.includes(metas[0]!.id), '首行=最新会话（updatedAt 降序同列表）');
  assert.ok(lines[0]!.includes('第二条会话的问题'), '摘要随行');
  assert.ok(!lines[0]!.includes('第一条'), '降序：旧会话不占首行');
  assert.ok(index.includes('byte-exact source of record'), '头注声明 jsonl 为逐字节权威');
});

test('镜像只收 user 与终态 seg 行；msg-update/seg-update/snapshots/board 机械行不入镜', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  j.log({ t: 'user', text: '帮我看下这个报错' });
  j.log({ t: 'seg', kind: 'assistant', md: '这是我的分析结论。', ts: 1, seq: 1 });
  j.log({ t: 'seg', kind: 'thinking', md: '思考过程不入镜', ts: 2, seq: 2 });
  j.log({ t: 'seg', kind: 'tool', md: '', ts: 3, seq: 3, callId: 'c1' });
  j.log({ t: 'seg-update', seq: 3, ts: 4, result: { text: '工具结果不入镜', ok: true } });
  j.log({ t: 'msg-update', item: { kind: 'text', text: '增量行不入镜' } as never });
  j.log({ t: 'snapshots', files: [] });
  j.log({ t: 'board', e: { type: 'task-updated' } as never });
  j.log({ t: 'seg', kind: 'error', md: '出错了', ts: 5, seq: 5 });
  const lines = readTranscript(dataDir, id);
  assert.deepEqual(lines, ['[user] 帮我看下这个报错', '[assistant] 这是我的分析结论。', '[error] 出错了'], '仅三类终态行入镜');
});

test('镜像单行化截断 500 字：多行正文折叠为单行', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  j.log({ t: 'user', text: '第一行\n第二行\n第三行' });
  j.log({ t: 'seg', kind: 'assistant', md: '长'.repeat(600), ts: 1, seq: 1 });
  const lines = readTranscript(dataDir, id);
  assert.equal(lines[0], '[user] 第一行 第二行 第三行', '换行折叠单空格');
  assert.equal(lines[1]!.length, 500, '整行（含角色前缀）截断 500');
  assert.ok(lines[1]!.startsWith('[assistant] '), '角色前缀保留');
});

test('镜像失败旁路：transcript 被目录占位时主档照常落盘', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  fs.mkdirSync(path.join(sessionsDir(dataDir), `${id}.transcript.md`));
  j.log({ t: 'user', text: '镜像会失败' });
  const jsonl = fs.readFileSync(path.join(sessionsDir(dataDir), `${id}.jsonl`), 'utf8');
  assert.ok(jsonl.includes('镜像会失败'), '主档事件在盘');
});

test('attach 续挂旧档：镜像续写同一文件（会话延续同账本）', () => {
  const dataDir = tmp();
  const j1 = new SessionJournal(dataDir);
  j1.start();
  const id = j1.currentId!;
  j1.log({ t: 'user', text: '上半场' });
  const j2 = new SessionJournal(dataDir);
  j2.attach(id);
  j2.log({ t: 'user', text: '下半场' });
  assert.deepEqual(readTranscript(dataDir, id), ['[user] 上半场', '[user] 下半场'], '续挂同文件追加');
});

test('purgeSession 覆盖 transcript 镜像：<id>. 前缀全家清理', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  j.log({ t: 'user', text: '待删除' });
  purgeSession(dataDir, id);
  assert.ok(!fs.existsSync(path.join(sessionsDir(dataDir), `${id}.transcript.md`)), '镜像随会话删除');
});
