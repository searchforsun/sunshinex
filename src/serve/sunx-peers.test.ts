// 跨 Sunx 对等消息宿主实现（2026-11-26 用户裁定：「两个工具实现 sunx 之间的聊天」「sunx 可定只投活
// 实例」）：活实例枚举（排己/归档不列/只列在座）+ 投递（idle=submitExternal 起轮、running=steer 排队）
// + 归因前缀与 caller 身份补全。in-memory 会话桩 + 临时 sunx 域容器，不经 daemon。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listLiveSunxPeers, deliverSunxPeerMessage } from './sunx-peers';
import type { PeersSessionLike } from './sunx-peers';
import type { SunxPeerRef } from '../types';

const prevDir = process.env.SUNSHINEX_SUNX_DIR;
const container = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-peers-'));
process.env.SUNSHINEX_SUNX_DIR = container;
test.after(() => {
  if (prevDir === undefined) delete process.env.SUNSHINEX_SUNX_DIR;
  else process.env.SUNSHINEX_SUNX_DIR = prevDir;
  fs.rmSync(container, { recursive: true, force: true });
});

/** 域档案落盘：journal 行（header+user）+ 旁车 meta（title/charterText/root/runs/steps） */
function seedDomain(jid: string, meta: { title?: string; charterText?: string; root?: string; archived?: boolean }): void {
  const dataDir = path.join(container, jid, 'data');
  const dir = path.join(dataDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${jid}.jsonl`),
    [
      JSON.stringify({ t: 'header', v: 3, id: jid, createdAt: new Date(1).toISOString() }),
      JSON.stringify({ t: 'user', text: `首条 ${jid}`, ts: 1 }),
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, `${jid}.meta.json`), JSON.stringify({ kind: 'sunx', ...meta }), 'utf8');
  void dataDir;
}

interface FakeSession extends PeersSessionLike {
  sent: Array<{ text: string; from?: SunxPeerRef }>;
  queued: Array<{ text: string; from?: SunxPeerRef }>;
}

function fakeSession(over: Partial<PeersSessionLike> & { jid?: string; name?: string; st?: string }): FakeSession {
  const s: FakeSession = {
    sent: [],
    queued: [],
    get attachedJournalId(): string | undefined { return over.jid; },
    sessionKind: 'sunx',
    get sunxName(): string | undefined { return over.name; },
    root: over.root ?? 'D:/w/x',
    dataDir: '',
    status: () => over.st ?? 'idle',
    pendingSnapshot: () => [],
    submitExternal(text, _images, from) { s.sent.push({ text, ...(from !== undefined ? { from } : {}) }); return { ok: true }; },
    steer(text, _images, from) { s.queued.push({ text, ...(from !== undefined ? { from } : {}) }); },
    ...over,
  } as FakeSession;
  return s;
}

test('发现:只列活实例(排己/归档不列/未在座不列),名称/品行原样透出', () => {
  seedDomain('peer-a', { title: 'Planner', charterText: '你是规划者。\n先读板。', root: 'D:/w/alpha' });
  seedDomain('peer-archived', { title: 'Archived One', archived: true });
  seedDomain('peer-cold', { title: 'Cold One' });
  seedDomain('peer-running', { title: 'Coder', root: 'D:/w/beta' });
  const sessions = new Map<string, PeersSessionLike>();
  const caller = fakeSession({ jid: 'caller-jid', name: 'Caller', st: 'idle' });
  sessions.set('s-caller', caller);
  sessions.set('s-a', fakeSession({ jid: 'peer-a', name: 'Planner', st: 'idle' }));
  sessions.set('s-r', fakeSession({ jid: 'peer-running', name: 'Coder', st: 'running' }));
  sessions.set('s-x', fakeSession({ jid: 'peer-archived', name: 'Archived One', st: 'idle' })); // 归档在座也不列

  const out = listLiveSunxPeers(sessions, 's-caller');
  assert.deepEqual(out.map((p) => p.id).sort(), ['peer-a', 'peer-running'], '只列活实例且排己/排归档/排冷档');
  const a = out.find((p) => p.id === 'peer-a')!;
  assert.equal(a.name, 'Planner', '名称为 meta.title 原样');
  assert.equal(a.charter, '你是规划者。\n先读板。', '品行原文透出（内容是什么就是什么，不翻译）');
  assert.equal(a.root, 'D:/w/alpha');
  assert.equal(a.running, false);
  assert.equal(out.find((p) => p.id === 'peer-running')!.running, true, 'running 状态随在座会话');
});

test('投递:idle 目标=submitExternal 起轮（用户气泡语义）；前缀 fromSunx+caller 归因随行', () => {
  seedDomain('peer-a', { title: 'Planner' });
  const target = fakeSession({ jid: 'peer-a', name: 'Planner', st: 'idle' });
  const sessions = new Map<string, PeersSessionLike>();
  sessions.set('s-caller', fakeSession({ jid: 'caller-jid', name: 'Caller', st: 'running' }));
  sessions.set('s-a', target);

  const r = deliverSunxPeerMessage(sessions, 's-caller', 'peer-a', '第三列卡住了');
  assert.deepEqual(r, { ok: true, name: 'Planner', queued: false });
  assert.equal(target.sent.length, 1, 'idle 目标走 submitExternal（回显帧+起轮）');
  // 注入 md = 来源前缀 + 正文 + 回答提示行（用户二轮裁定「提示添加到这里」：随消息正文进模型面）
  assert.equal(
    target.sent[0]!.text,
    '[fromSunx: Caller (caller-jid)] 第三列卡住了\n\n(From another Sunx, not from the user. Reply to that Sunx with send_sunx_messages, to="caller-jid".)',
    '前缀格式+正文原样+回答提示行（英文单语——进模型上下文的文案恒英文）',
  );
  assert.deepEqual(target.sent[0]!.from, { id: 'caller-jid', name: 'Caller' }, '结构化归因随行（GUI 来源行）');
});

test('投递:running 目标=steer 入队（类似用户气泡直接进入排队，轮收束补跑）', () => {
  seedDomain('peer-a', { title: 'Planner' });
  const target = fakeSession({ jid: 'peer-a', name: 'Planner', st: 'running' });
  const sessions = new Map<string, PeersSessionLike>();
  sessions.set('s-caller', fakeSession({ jid: 'caller-jid', name: 'Caller', st: 'idle' }));
  sessions.set('s-a', target);

  const r = deliverSunxPeerMessage(sessions, 's-caller', 'peer-a', '好了吗');
  assert.deepEqual(r, { ok: true, name: 'Planner', queued: true });
  assert.equal(target.queued.length, 1, 'running 目标走队列');
  assert.equal(target.sent.length, 0);
  assert.deepEqual(target.queued[0]!.from, { id: 'caller-jid', name: 'Caller' });
});

test('投递:idle→running 受理竞态(409) 回退入队（不丢消息）', () => {
  seedDomain('peer-a', { title: 'Planner' });
  const target = fakeSession({ jid: 'peer-a', name: 'Planner', st: 'idle' });
  target.submitExternal = (text, _images, from) => { target.sent.push({ text, ...(from !== undefined ? { from } : {}) }); return { ok: false, status: 409 }; };
  const sessions = new Map<string, PeersSessionLike>();
  sessions.set('s-caller', fakeSession({ jid: 'caller-jid', name: 'Caller', st: 'idle' }));
  sessions.set('s-a', target);
  const r = deliverSunxPeerMessage(sessions, 's-caller', 'peer-a', '竞态消息');
  assert.deepEqual(r, { ok: true, name: 'Planner', queued: true }, '409 回退 steer，回执=已入队');
  assert.equal(target.queued.length, 1);
});

test('投递拒绝:未知/非活/自己/非 sunx/caller 无 journal 各有明确原因', () => {
  seedDomain('peer-a', { title: 'Planner' });
  const sessions = new Map<string, PeersSessionLike>();
  sessions.set('s-caller', fakeSession({ jid: 'caller-jid', name: 'Caller' }));
  sessions.set('s-a', fakeSession({ jid: 'peer-a', name: 'Planner' }));
  sessions.set('s-std', fakeSession({ jid: 'peer-std', name: 'Normal' }));
  (sessions.get('s-std') as { sessionKind: string }).sessionKind = 'standard';

  const cold = deliverSunxPeerMessage(sessions, 's-caller', 'peer-cold', 'x');
  assert.equal(cold.ok, false);
  assert.match((cold as { error: string }).error, /not a live Sunx instance/, '未在座=只投活实例拒绝');

  const self = deliverSunxPeerMessage(sessions, 's-caller', 'caller-jid', 'x');
  assert.equal(self.ok, false);
  assert.match((self as { error: string }).error, /yourself/, '不能发给自己');

  const notSunx = deliverSunxPeerMessage(sessions, 's-caller', 'peer-std', 'x');
  assert.equal(notSunx.ok, false);
  assert.match((notSunx as { error: string }).error, /not a Sunx session/, '非 sunx 会话拒绝');

  const noJournal = fakeSession({ jid: undefined, name: 'Draft' });
  sessions.set('s-draft', noJournal);
  const early = deliverSunxPeerMessage(sessions, 's-draft', 'peer-a', 'x');
  assert.equal(early.ok, false);
  assert.match((early as { error: string }).error, /no journal yet/, 'caller 未铸档=拒（首轮前无身份）');
});
