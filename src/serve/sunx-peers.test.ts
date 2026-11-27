// 跨 Sunx 对等消息宿主实现（2026-11-26 用户裁定：「两个工具实现 sunx 之间的聊天」「sunx 可定只投活
// 实例」）：活实例枚举（排己/归档不列/只列在座）+ 投递（idle=submitExternal 起轮、running=steer 排队）
// + 归因前缀与 caller 身份补全。in-memory 会话桩 + 临时 sunx 域容器，不经 daemon。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listSunxPeers, deliverSunxPeerMessage, deliverToTarget } from './sunx-peers';
import type { PeersSessionLike } from './sunx-peers';
import { createGroup, readRoom } from './sunx-groups';
import type { SunxPeerRef } from '../types';

const prevDir = process.env.SUNSHINEX_SUNX_DIR;
const container = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-peers-'));
process.env.SUNSHINEX_SUNX_DIR = container;
test.after(() => {
  if (prevDir === undefined) delete process.env.SUNSHINEX_SUNX_DIR;
  else process.env.SUNSHINEX_SUNX_DIR = prevDir;
  fs.rmSync(container, { recursive: true, force: true });
});

/** 域档案落盘：journal 行（header+user）+ 旁车 meta（title/charterText/root/runs/steps/groupId） */
function seedDomain(jid: string, meta: { title?: string; charterText?: string; root?: string; archived?: boolean; groupId?: string }): string {
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
  return dataDir;
}

interface FakeSession extends PeersSessionLike {
  sent: Array<{ text: string; images?: string[]; from?: SunxPeerRef }>;
  queued: Array<{ text: string; images?: string[]; from?: SunxPeerRef }>;
}

function fakeSession(over: Partial<PeersSessionLike> & { jid?: string; name?: string; st?: string; runSeq?: number }): FakeSession {
  const s: FakeSession = {
    sent: [],
    queued: [],
    get attachedJournalId(): string | undefined { return over.jid; },
    sessionKind: 'sunx',
    get sunxName(): string | undefined { return over.name; },
    root: over.root ?? 'D:/w/x',
    dataDir: '',
    status: () => over.st ?? 'idle',
    openRunSeq: () => over.runSeq ?? -1,
    pendingSnapshot: () => [],
    submitExternal(text, images, from) { s.sent.push({ text, ...(images !== undefined && images.length > 0 ? { images } : {}), ...(from !== undefined ? { from } : {}) }); return { ok: true }; },
    steer(text, images, from) { s.queued.push({ text, ...(images !== undefined && images.length > 0 ? { images } : {}), ...(from !== undefined ? { from } : {}) }); },
    ...over,
  } as FakeSession;
  return s;
}

test('发现:存在即列(排己/归档不列;未在座标 not open),名称/品行原样透出', () => {
  seedDomain('peer-a', { title: 'Planner', charterText: '你是规划者。\n先读板。', root: 'D:/w/alpha' });
  seedDomain('peer-archived', { title: 'Archived One', archived: true });
  seedDomain('peer-cold', { title: 'Cold One' });
  seedDomain('peer-running', { title: 'Coder', root: 'D:/w/beta' });
  seedDomain('caller-jid', { title: 'Caller' }); // caller 自己也在域容器（真实形态；计数含己、列表排己）
  const sessions = new Map<string, PeersSessionLike>();
  const caller = fakeSession({ jid: 'caller-jid', name: 'Caller', st: 'idle' });
  sessions.set('s-caller', caller);
  sessions.set('s-a', fakeSession({ jid: 'peer-a', name: 'Planner', st: 'idle' }));
  sessions.set('s-r', fakeSession({ jid: 'peer-running', name: 'Coder', st: 'running' }));
  sessions.set('s-x', fakeSession({ jid: 'peer-archived', name: 'Archived One', st: 'idle' })); // 归档在座也不列

  const out = listSunxPeers(sessions, 's-caller');
  assert.deepEqual(out.map((p) => p.id).sort(), ['grp_default', 'peer-a', 'peer-cold', 'peer-running'], '存在即列（含未在座冷档），排己/排归档；群目标行置首');
  const g = out.find((p) => p.id === 'grp_default')!;
  assert.equal(g.kind, 'group');
  assert.equal(g.name, '默认群组');
  assert.equal(g.memberCount, 4, '群目标行成员数=未归档同群实例（含 caller 自己）');
  assert.equal(g.live, true);
  const a = out.find((p) => p.id === 'peer-a')!;
  assert.equal(a.name, 'Planner', '名称为 meta.title 原样');
  assert.equal(a.charter, '你是规划者。\n先读板。', '品行原文透出（内容是什么就是什么，不翻译）');
  assert.equal(a.root, 'D:/w/alpha');
  assert.equal(a.running, false);
  assert.equal(a.live, true, '在座标 live');
  assert.equal(out.find((p) => p.id === 'peer-cold')!.live, false, '未在座 live=false（存在即活，在座只是状态）');
  assert.equal(out.find((p) => p.id === 'peer-running')!.running, true, 'running 状态随在座会话');
});

test('投递:idle 目标=submitExternal 起轮（用户气泡语义）；前缀 fromSunx+caller 归因随行', () => {
  seedDomain('peer-a', { title: 'Planner' });
  const target = fakeSession({ jid: 'peer-a', name: 'Planner', st: 'idle' });
  const sessions = new Map<string, PeersSessionLike>();
  sessions.set('s-caller', fakeSession({ jid: 'caller-jid', name: 'Caller', st: 'running', runSeq: 7 }));
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
  assert.deepEqual(target.sent[0]!.from, { id: 'caller-jid', name: 'Caller', runSeq: 7 }, '结构化归因随行（GUI 来源行+发送轮次锚，点击定位该轮）');
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

test('投递:未在座实例先 attach 开座再投递（ensureLive 缝；与点侧栏行同链）', () => {
  seedDomain('peer-a', { title: 'Planner' });
  const sessions = new Map<string, PeersSessionLike>();
  sessions.set('s-caller', fakeSession({ jid: 'caller-jid', name: 'Caller', st: 'idle' }));
  // 目标未在座：ensureLive 模拟 attach（开座后 Map 里出现运行时）
  const ensureLive = (jid: string): boolean => {
    if (jid !== 'peer-a') return false;
    sessions.set('s-a2', fakeSession({ jid: 'peer-a', name: 'Planner', st: 'idle' }));
    return true;
  };
  const r = deliverSunxPeerMessage(sessions, 's-caller', 'peer-a', '开座投递', { ensureLive });
  assert.deepEqual(r, { ok: true, name: 'Planner', queued: false }, 'attach 后按 idle 常规投递');
  const a = sessions.get('s-a2') as FakeSession;
  assert.equal(a.sent.length, 1, '消息落到新开的座');
  // ensureLive 失败=不可开（未知档）→ 明确拒绝
  const bad = deliverSunxPeerMessage(sessions, 's-caller', 'peer-x', 'x', { ensureLive: () => false });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /unknown or not openable/, '开座失败=named 拒绝');
});

test('投递拒绝:未知/未在座(无开座缝)/自己/非 sunx/caller 无 journal 各有明确原因', () => {
  seedDomain('peer-a', { title: 'Planner' });
  const sessions = new Map<string, PeersSessionLike>();
  sessions.set('s-caller', fakeSession({ jid: 'caller-jid', name: 'Caller' }));
  sessions.set('s-a', fakeSession({ jid: 'peer-a', name: 'Planner' }));
  sessions.set('s-std', fakeSession({ jid: 'peer-std', name: 'Normal' }));
  (sessions.get('s-std') as { sessionKind: string }).sessionKind = 'standard';

  const cold = deliverSunxPeerMessage(sessions, 's-caller', 'peer-cold', 'x'); // 无 ensureLive 缝
  assert.equal(cold.ok, false);
  assert.match((cold as { error: string }).error, /unknown or not openable/, '无开座缝=未在座即拒');

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

test('群作用域：同群 list + 群目标行；跨群不列；回群主写房间；成员→成员镜像；跨群/归档拒绝', () => {
  const created = createGroup('测试群');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const gid = created.group.id;
  const callerData = seedDomain('caller-jid', { groupId: gid });
  const aData = seedDomain('peer-a', { title: 'A', groupId: gid });
  const bData = seedDomain('peer-b', { title: 'B', groupId: gid });
  const xData = seedDomain('peer-x', { title: 'X', groupId: 'grp_other' });
  const archData = seedDomain('peer-arch', { title: 'Arch', groupId: gid, archived: true });

  const sessions = new Map<string, PeersSessionLike>();
  sessions.set('s-caller', fakeSession({ jid: 'caller-jid', name: 'Caller', dataDir: callerData }));
  sessions.set('s-a', fakeSession({ jid: 'peer-a', name: 'A', dataDir: aData }));
  sessions.set('s-b', fakeSession({ jid: 'peer-b', name: 'B', dataDir: bData }));
  sessions.set('s-x', fakeSession({ jid: 'peer-x', name: 'X', dataDir: xData }));
  sessions.set('s-arch', fakeSession({ jid: 'peer-arch', name: 'Arch', dataDir: archData }));

  const out = listSunxPeers(sessions, 's-caller');
  const ids = out.map((p) => p.id);
  assert.deepEqual(ids.slice(0, 1), [gid], '群目标行置首');
  assert.deepEqual(ids.slice(1).sort(), ['peer-a', 'peer-b'], '只列同群未归档成员（排己）');
  assert.equal(out.find((p) => p.id === gid)?.name, '测试群');
  assert.equal(out.find((p) => p.id === gid)?.memberCount, 3, '成员数=caller+A+B（归档/跨群不计）');

  const toGroup = deliverSunxPeerMessage(sessions, 's-caller', gid, '回复群主');
  assert.deepEqual(toGroup, { ok: true, name: '测试群', queued: false, kind: 'group' }, '群目标回执 kind=group');
  const room1 = readRoom(gid);
  assert.equal(room1.messages.length, 1);
  assert.equal(room1.messages[0]!.kind, 'peer');
  assert.deepEqual(room1.messages[0]!.to, { id: gid, name: '群主', kind: 'group' });
  assert.equal(room1.messages[0]!.from.id, 'caller-jid');

  const toA = deliverSunxPeerMessage(sessions, 's-caller', 'peer-a', '给 A');
  assert.deepEqual(toA, { ok: true, name: 'A', queued: false }, '成员目标回执不带 kind（旧形不变）');
  const room2 = readRoom(gid);
  assert.equal(room2.messages.length, 2, '成员→成员成功投递镜像到房间');
  assert.equal(room2.messages[1]!.to?.id, 'peer-a');

  const cross = deliverSunxPeerMessage(sessions, 's-caller', 'peer-x', 'x');
  assert.equal(cross.ok, false);
  assert.match((cross as { error: string }).error, /not in your group/, '跨群拒绝');
  const arch = deliverSunxPeerMessage(sessions, 's-caller', 'peer-arch', 'x');
  assert.equal(arch.ok, false);
  assert.match((arch as { error: string }).error, /archived Sunx instance/, '归档拒绝');
});

test('deliverToTarget：群主引用块进正文 + fromSunx kind=group；群/归档校验', () => {
  const aData = seedDomain('peer-a', { title: 'A' });
  const xData = seedDomain('peer-x', { title: 'X', groupId: 'grp_other' });
  const archData = seedDomain('peer-arch', { title: 'Arch', archived: true });
  const target = fakeSession({ jid: 'peer-a', name: 'A', dataDir: aData });
  const x = fakeSession({ jid: 'peer-x', name: 'X', dataDir: xData });
  const arch = fakeSession({ jid: 'peer-arch', name: 'Arch', dataDir: archData });
  const sessions = new Map<string, PeersSessionLike>();
  sessions.set('s-a', target);
  sessions.set('s-x', x);
  sessions.set('s-arch', arch);
  const owner = { id: 'grp_default', name: '群主', kind: 'group' as const };

  const r = deliverToTarget(sessions, owner, 'peer-a', '你好', {
    groupId: 'grp_default',
    quote: { name: 'A', text: '上一句' },
  });
  assert.deepEqual(r, { ok: true, name: 'A', queued: false });
  assert.equal(
    target.sent[0]!.text,
    '[fromSunx: 群主 (grp_default)] > [A] 上一句\n你好\n\n(From another Sunx, not from the user. Reply to that Sunx with send_sunx_messages, to="grp_default".)',
    '群主引用块在正文前部，回信提示指向群 id',
  );
  assert.deepEqual(target.sent[0]!.from, owner, 'fromSunx kind=group 随行');

  const img = 'data:image/png;base64,AAAA';
  const withImg = deliverToTarget(sessions, owner, 'peer-a', '', { groupId: 'grp_default', images: [img] });
  assert.equal(withImg.ok, true);
  assert.deepEqual(target.sent[1]!.images, [img], '图片随行到目标用户气泡（空文本纯图）');

  const cross = deliverToTarget(sessions, owner, 'peer-x', 'x', { groupId: 'grp_default' });
  assert.equal(cross.ok, false);
  assert.match((cross as { error: string }).error, /not in your group/);
  const archived = deliverToTarget(sessions, owner, 'peer-arch', 'x', { groupId: 'grp_default' });
  assert.equal(archived.ok, false);
  assert.match((archived as { error: string }).error, /archived Sunx instance/);
});

test('deliverToTarget：目标 awaiting(ask_question 挂起)拒投——回答在成员会话', () => {
  const aData = seedDomain('peer-a', { title: 'A' });
  const target = fakeSession({ jid: 'peer-a', name: 'A', dataDir: aData, pendingSnapshot: () => [{}] });
  const sessions = new Map<string, PeersSessionLike>();
  sessions.set('s-a', target);
  const r = deliverToTarget(sessions, { id: 'grp_default', name: '群主', kind: 'group' }, 'peer-a', 'hi', { groupId: 'grp_default' });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /awaiting input/);
  assert.equal(target.sent.length + target.queued.length, 0, '挂起期间不投递');
});
