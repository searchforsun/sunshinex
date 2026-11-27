// 群存储（2026-11-26 群组规格 P0）：默认群惰性补种、建/改名/删除、重名/空名、默认群与有成员保护。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_GROUP_ID, appendRoomCommand, appendRoomDelivery, appendRoomHuman, appendRoomPeer, createGroup, deleteGroup,
  groupById, inferQuote, lastMessageAt, listGroupMembers, listGroups, prepareGroupSend, readRoom, renameGroup, replyPreviewOf, roomPath, searchRoom,
  type GroupLiveSession,
} from './sunx-groups';
import { enumerateContainerSessions } from './sessions-list-handlers';
import { readSessionMeta, writeSessionMeta } from '../session/journal';
import { sunxContainerDir, sunxGroupsDir } from '../config/data-dir';

const prevDir = process.env.SUNSHINEX_SUNX_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-groups-'));
process.env.SUNSHINEX_SUNX_DIR = path.join(root, 'sunx');
test.after(() => {
  if (prevDir === undefined) delete process.env.SUNSHINEX_SUNX_DIR;
  else process.env.SUNSHINEX_SUNX_DIR = prevDir;
  fs.rmSync(root, { recursive: true, force: true });
});

test('默认群惰性补种；建群/重名/改名/删空群/默认群不可删', () => {
  const groups = listGroups();
  assert.equal(groups[0]?.id, DEFAULT_GROUP_ID, '默认群补种');
  assert.equal(groups[0]?.name, '默认群组');
  assert.ok(fs.existsSync(path.join(sunxGroupsDir(), 'groups.json')), '读面落盘 groups.json');

  const c = createGroup('研发群');
  assert.equal(c.ok, true);
  if (!c.ok) return;
  assert.match(c.group.id, /^grp_[0-9a-f]{12}$/, '群 id 前缀/长度');
  assert.equal(groupById(c.group.id)?.name, '研发群');

  assert.equal(createGroup('研发群').ok, false, '重名 409');
  assert.equal(createGroup('   ').ok, false, '空名 400');
  assert.equal(createGroup('x'.repeat(61)).ok, false, '超长 400');
  assert.equal(renameGroup(c.group.id, '研发二群').ok, true);
  assert.equal(groupById(c.group.id)?.name, '研发二群');
  assert.equal(renameGroup(c.group.id, '默认群组').ok, false, '改名撞默认群');

  assert.equal(deleteGroup(DEFAULT_GROUP_ID, 0).ok, false, '默认群不可删');
  assert.equal(deleteGroup(c.group.id, 1).ok, false, '有成员 409');

  fs.mkdirSync(path.dirname(roomPath(c.group.id)), { recursive: true });
  fs.writeFileSync(roomPath(c.group.id), '', 'utf8');
  assert.equal(deleteGroup(c.group.id, 0).ok, true, '空群可删');
  assert.equal(groupById(c.group.id), undefined);
  assert.equal(fs.existsSync(roomPath(c.group.id)), false, '房间目录随群清');
});

test('meta.groupId 读回 / 换群写 / 行投影有效归属（缺失=默认群）', () => {
  const seed = (jid: string, meta: Record<string, unknown>): string => {
    const dataDir = path.join(sunxContainerDir(), jid, 'data');
    const dir = path.join(dataDir, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${jid}.jsonl`),
      [JSON.stringify({ t: 'header', v: 3, id: jid, createdAt: new Date(1).toISOString() }), JSON.stringify({ t: 'user', text: jid, ts: 1 }), ''].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(dir, `${jid}.meta.json`), JSON.stringify({ kind: 'sunx', ...meta }), 'utf8');
    return dataDir;
  };
  const dataA = seed('jid-a', { title: 'A', root: 'D:/w', groupId: 'grp_a' });
  const dataB = seed('jid-b', { title: 'B', root: 'D:/w' });
  assert.equal(readSessionMeta(dataA, 'jid-a').groupId, 'grp_a');
  assert.equal(readSessionMeta(dataB, 'jid-b').groupId, undefined, '存量无键');

  writeSessionMeta(dataA, 'jid-a', { groupId: 'grp_b' });
  assert.equal(readSessionMeta(dataA, 'jid-a').groupId, 'grp_b', '换群覆盖 meta.groupId');
  assert.equal(readSessionMeta(dataA, 'jid-a').title, 'A', '换群不丢其余 meta');

  const rows = enumerateContainerSessions({
    containerDir: sunxContainerDir(),
    kind: 'sunx',
    sessions: new Map(),
    domainColumns: (r) => (r.root !== undefined ? { root: r.root } : {}),
  });
  assert.equal(rows.find((r) => r.id === 'jid-a')?.groupId, 'grp_b', '行投影=meta.groupId');
  assert.equal(rows.find((r) => r.id === 'jid-b')?.groupId, DEFAULT_GROUP_ID, '行投影缺失=默认群');
});

test('房间：human/peer/command + delivery 折叠、seq 游标、reset、引用、搜索', () => {
  const gid = 'grp_room';
  const owner = { id: gid, name: '群主', kind: 'group' as const };
  const a = { id: 'jid_a', name: 'A', runSeq: 7, kind: 'sunx' as const };
  const b = { id: 'jid_b', name: 'B', kind: 'sunx' as const };
  const human = appendRoomHuman(gid, {
    from: owner,
    text: '@A @B 评审一下\n第二行',
    mentions: [{ id: 'jid_a', name: 'A' }, { id: 'jid_b', name: 'B' }],
    targets: [{ id: 'jid_a', name: 'A' }, { id: 'jid_b', name: 'B' }],
  });
  assert.equal(human.seq, 1);
  assert.equal(appendRoomDelivery(gid, { msgId: human.id, to: 'jid_a', name: 'A', ok: true }), 2);
  assert.equal(appendRoomDelivery(gid, { msgId: human.id, to: 'jid_b', name: 'B', ok: false, error: 'attach failed' }), 3);
  const peer = appendRoomPeer(gid, { from: a, to: owner, text: '评审结论：通过', replyTo: human.id, replyPreview: { from: owner, text: '@A @B 评审一下' } });
  assert.equal(peer.seq, 4);
  const cmd = appendRoomCommand(gid, { from: a, to: owner, text: 'session idle', command: '/status', replyTo: human.id });

  const all = readRoom(gid);
  assert.deepEqual(all.messages.map((m) => m.kind), ['human', 'peer', 'command']);
  assert.equal(all.cursor, 5);
  assert.equal(all.hasMore, false);
  const h = all.messages[0]!;
  assert.equal(h.updatedSeq, 3, '老 human 消息的 updatedSeq=回执最大 seq');
  assert.deepEqual(h.deliveries, [
    { to: 'jid_a', name: 'A', ok: true },
    { to: 'jid_b', name: 'B', ok: false, error: 'attach failed' },
  ]);
  assert.equal(all.messages[2]!.command, '/status');
  assert.equal(all.messages[2]!.runSeq, 7);

  const after1 = readRoom(gid, { after: 1 });
  assert.deepEqual(after1.messages.map((m) => m.kind), ['human', 'peer', 'command'], 'after=1 含 human（其回执 seq 2/3 后到）');
  assert.equal(after1.cursor, 5);
  const after4 = readRoom(gid, { after: 4 });
  assert.deepEqual(after4.messages.map((m) => m.kind), ['command']);
  const after5 = readRoom(gid, { after: 5 });
  assert.equal(after5.messages.length, 0);
  const reset = readRoom(gid, { after: 999 });
  assert.equal(reset.reset, true);
  assert.equal(reset.messages.length, 3);
  const before5 = readRoom(gid, { before: 5 });
  assert.deepEqual(before5.messages.map((m) => m.kind), ['human', 'peer']);

  assert.deepEqual(replyPreviewOf(gid, human.id), { from: owner, text: '@A @B 评审一下' });
  assert.equal(replyPreviewOf(gid, 'nope'), undefined);

  const q1 = inferQuote(gid, 'jid_a');
  assert.equal(q1?.replyTo, human.id, '群目标：最近收到的群主消息');
  assert.equal(q1?.replyPreview.text, '@A @B 评审一下');
  assert.equal(inferQuote(gid, 'jid_a', 'jid_b'), undefined, '成员目标：B 尚未给 A 发过消息');
  appendRoomPeer(gid, { from: b, to: a, text: 'B 给 A 的话' });
  assert.equal(inferQuote(gid, 'jid_a', 'jid_b')?.replyPreview.text, 'B 给 A 的话');

  const hits = searchRoom(gid, '评审');
  assert.equal(hits.length, 2, 'human + peer 命中');
  assert.equal(hits[0]!.seq, 4, '按 seq 降序');
  assert.ok(hits[0]!.text.includes('评审'));
  assert.equal(searchRoom(gid, 'IDLE').length, 1, '大小写不敏感');
  assert.equal(searchRoom(gid, '  ').length, 0);
  assert.ok((lastMessageAt(gid) ?? 0) > 0);

  fs.appendFileSync(roomPath(gid), 'not-json\n{"t":"msg","seq":"bad"}\n', 'utf8');
  assert.equal(readRoom(gid).messages.length, 4, '坏行跳过');
  void cmd;
});

test('群主发送准备：@all 快照/归档排除、room-only、破坏件单目标、命令零目标、replyTo 校验', () => {
  const created = createGroup('发送群');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const gid = created.group.id;
  const members = [
    { id: 'jid_a', name: 'A', live: true, running: false, awaiting: false, updatedAt: 3, root: '' },
    { id: 'jid_b', name: 'B', live: false, running: false, awaiting: false, updatedAt: 2, root: '' },
    { id: 'jid_c', name: 'C', live: false, running: false, awaiting: false, updatedAt: 1, root: '', archived: true },
  ];

  const all = prepareGroupSend(gid, { text: '@全体成员 你好', mentionAll: true }, members);
  assert.equal(all.ok, true);
  if (!all.ok) return;
  assert.deepEqual(all.prepared.targets, [{ id: 'jid_a', name: 'A' }, { id: 'jid_b', name: 'B' }], '@all 排除归档');
  const roomAll = readRoom(gid);
  assert.equal(roomAll.messages[0]!.mentionAll, true);
  assert.equal(roomAll.messages[0]!.targets?.length, 2);

  const roomOnly = prepareGroupSend(gid, { text: '只是记录' }, members);
  assert.equal(roomOnly.ok, true);
  if (roomOnly.ok) assert.deepEqual(roomOnly.prepared.targets, [], '无 @=room-only');
  assert.equal(readRoom(gid).messages[1]!.targets?.length, 0);

  const single = prepareGroupSend(gid, { text: '/delete', mentions: ['jid_a'] }, members);
  assert.equal(single.ok, true, '破坏件单目标允许');
  if (single.ok) assert.equal(single.prepared.command, '/delete');
  const allDestroy = prepareGroupSend(gid, { text: '/delete', mentionAll: true }, members);
  assert.equal(allDestroy.ok, false);
  if (!allDestroy.ok) assert.equal(allDestroy.status, 400);
  const multiDestroy = prepareGroupSend(gid, { text: '/delete', mentions: ['jid_a', 'jid_b'] }, members);
  assert.equal(multiDestroy.ok, false, '破坏件多目标禁止');
  const noTargetCommand = prepareGroupSend(gid, { text: '/status' }, members);
  assert.equal(noTargetCommand.ok, false, '命令必须至少 1 个 @');
  const allStatus = prepareGroupSend(gid, { text: '/status', mentionAll: true }, members);
  assert.equal(allStatus.ok, true, '非破坏命令可 @all');

  const badReply = prepareGroupSend(gid, { text: 'x', mentions: ['jid_a'], replyTo: 'm_nope' }, members);
  assert.equal(badReply.ok, false);
  if (!badReply.ok) assert.equal(badReply.status, 400);

  const noMembers = prepareGroupSend(gid, { text: '@all', mentionAll: true }, [members[2]!]);
  assert.equal(noMembers.ok, false);
  if (!noMembers.ok) assert.equal(noMembers.status, 409);
});

test('群主发送准备：图片随行/命令拒图/模型权限透传字段/plan 拒绝', () => {
  const created = createGroup('图片群');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const gid = created.group.id;
  const members = [{ id: 'jid_a', name: 'A', live: true, running: false, awaiting: false, updatedAt: 1, root: '' }];
  const img = 'data:image/png;base64,AAAA';

  const withImg = prepareGroupSend(gid, { text: '', images: [img], mentions: ['jid_a'], model: 'm1', mode: 'read-only' }, members);
  assert.equal(withImg.ok, true, '纯图片允许（text 空）');
  if (withImg.ok) {
    assert.deepEqual(withImg.prepared.images, [img]);
    assert.equal(withImg.prepared.model, 'm1');
    assert.equal(withImg.prepared.mode, 'read-only');
  }
  const room = readRoom(gid);
  assert.deepEqual(room.messages[room.messages.length - 1]!.images, [img], '房间 human 消息带图片');

  const badImg = prepareGroupSend(gid, { text: 'x', images: ['not-data'], mentions: ['jid_a'] }, members);
  assert.equal(badImg.ok, false);
  if (!badImg.ok) assert.equal(badImg.status, 400);
  const cmdImg = prepareGroupSend(gid, { text: '/status', images: [img], mentions: ['jid_a'] }, members);
  assert.equal(cmdImg.ok, false, '命令不接图片');
  const plan = prepareGroupSend(gid, { text: '/plan', mentionAll: true }, members);
  assert.equal(plan.ok, false, 'Sunx 无计划模式');
  if (!plan.ok) assert.equal(plan.status, 400);
  const badMode = prepareGroupSend(gid, { text: 'x', mode: 'plan' as never, mentions: ['jid_a'] }, members);
  assert.equal(badMode.ok, false, '权限只收三档');
  const empty = prepareGroupSend(gid, { text: '', mentions: ['jid_a'] }, members);
  assert.equal(empty.ok, false, '无文本无图片=400');
});

test('listGroupMembers：透出成员会话 ask pending（pid/req）供群页 ask 卡', () => {
  const jid = 'jid_ask';
  const dataDir = path.join(sunxContainerDir(), jid, 'data');
  const dir = path.join(dataDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${jid}.jsonl`), [JSON.stringify({ t: 'header', v: 3, id: jid, createdAt: new Date(1).toISOString() }), JSON.stringify({ t: 'user', text: 'A', ts: 1 }), ''].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, `${jid}.meta.json`), JSON.stringify({ kind: 'sunx', groupId: 'grp_ask', title: 'A' }), 'utf8');
  const sessions = new Map<string, GroupLiveSession>();
  sessions.set('s-ask', {
    attachedJournalId: jid,
    status: () => 'idle',
    pendingSnapshot: () => [{ pid: 'p1', kind: 'ask', req: { question: 'Q?', options: [{ label: '是' }] } }],
  });
  const rows = listGroupMembers('grp_ask', sessions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.awaiting, true);
  assert.deepEqual(rows[0]!.asks, [{ pid: 'p1', req: { question: 'Q?', options: [{ label: '是' }] } }]);
});
