// 群组面 HTTP 集成（2026-11-26 群组规格 P0/P1）：建群/建 Sunx 归群/群列表详情/房间读取/查询/
// 群主发送（@all 回执、命令结果、破坏件 @all 400、room-only）/改名/删除保护。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('waitFor timeout');
}

test('群组 HTTP：建群/归群/群列表/详情/房间/发送回执/命令/查询/改名/删除保护', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-group-http-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevSunx = process.env.SUNSHINEX_SUNX_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  // 群容器由 SUNSHINEX_SUNX_DIR 单点重定向（data-dir 头注 ②）；不设会把测试群/域写进用户 ~/.sunshinex
  process.env.SUNSHINEX_SUNX_DIR = path.join(tmp, 'sunx');
  const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']) });
  const s = await daemon.start({ port: 0, token: 'test-token' });
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const created = await (await fetch(`${base}/sunx/groups`, { method: 'POST', headers: AUTH, body: JSON.stringify({ name: '研发群' }) })).json() as { ok: true; group: { id: string; name: string } };
    const gid = created.group.id;
    const newSunx = async (name: string): Promise<string> => {
      const r = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp, kind: 'sunx', name, groupId: gid }) });
      assert.equal(r.status, 200, '新建 Sunx 归群');
      return ((await r.json()) as { sessionId: string }).sessionId;
    };
    await newSunx('A');
    await newSunx('B');

    const sessions = await (await fetch(`${base}/sunx/sessions`, { headers: AUTH })).json() as Array<{ id: string; title?: string; groupId?: string }>;
    const aRow = sessions.find((r) => r.title === 'A');
    assert.ok(aRow, 'A 在 SUNX 行集');
    assert.equal(aRow!.groupId, gid, '行投影 groupId');
    const aJid = aRow!.id;

    const groups = await (await fetch(`${base}/sunx/groups`, { headers: AUTH })).json() as { groups: Array<{ id: string; name: string; memberCount: number; isDefault: boolean }> };
    const g = groups.groups.find((x) => x.id === gid);
    assert.equal(g?.name, '研发群');
    assert.equal(g?.memberCount, 2, '成员数（未归档）');
    assert.equal(groups.groups.find((x) => x.isDefault)?.id, 'grp_default');

    const detail = await (await fetch(`${base}/sunx/groups/${gid}`, { headers: AUTH })).json() as { members: unknown[]; owner: { kind: string } };
    assert.equal(detail.members.length, 2);
    assert.equal(detail.owner.kind, 'group');

    const send = await fetch(`${base}/sunx/groups/${gid}/send`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '@全体成员 你好', mentionAll: true }) });
    assert.equal(send.status, 200);
    const sent = await send.json() as { ok: true; messageId: string; targets: unknown[] };
    assert.equal(sent.targets.length, 2);

    await waitFor(async () => {
      const r = await (await fetch(`${base}/sunx/groups/${gid}/messages`, { headers: AUTH })).json() as { messages: Array<{ id: string; deliveries?: unknown[] }> };
      const m = r.messages.find((x) => x.id === sent.messageId);
      return m?.deliveries?.length === 2;
    }, 5000);
    const room = await (await fetch(`${base}/sunx/groups/${gid}/messages`, { headers: AUTH })).json() as {
      messages: Array<{ id: string; kind: string; from: { kind?: string; name: string }; text: string; targets?: unknown[]; deliveries?: Array<{ ok: boolean }> }>;
      cursor: number;
    };
    const human = room.messages.find((x) => x.id === sent.messageId)!;
    assert.equal(human.kind, 'human');
    assert.deepEqual(human.from, { id: gid, name: '群主', kind: 'group' });
    assert.equal(human.deliveries?.length, 2);
    assert.ok(human.deliveries!.every((d) => d.ok === true), '两个目标均受理');
    assert.ok(room.cursor >= 1, '房间 cursor 为事件 seq');

    const cmd = await fetch(`${base}/sunx/groups/${gid}/send`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '/status', mentions: [aJid] }) });
    assert.equal(cmd.status, 200);
    await waitFor(async () => {
      const r = await (await fetch(`${base}/sunx/groups/${gid}/messages`, { headers: AUTH })).json() as { messages: Array<{ kind: string; command?: string }> };
      return r.messages.some((x) => x.kind === 'command' && x.command === '/status');
    }, 5000);
    const afterCmd = await (await fetch(`${base}/sunx/groups/${gid}/messages`, { headers: AUTH })).json() as { messages: Array<{ kind: string; command?: string; from: { id: string } }> };
    const commandMsg = afterCmd.messages.find((x) => x.kind === 'command' && x.command === '/status');
    assert.equal(commandMsg?.from.id, aJid, '命令结果来自目标 Sunx');

    // 群聊控制命令（2026-11-27）：/clear 清排队、/stop 暂停执行+队列、/continue 恢复队列
    const attached = await fetch(`${base}/sunx/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId: aJid }) });
    assert.equal(attached.status, 200, 'A 显式 attach 取 live session');
    const aLive = ((await attached.json()) as { sessionId: string }).sessionId;
    const steer = await fetch(`${base}/session/${aLive}/steer`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '排队清理测试' }) });
    assert.equal(steer.status, 200, '预置一条排队');
    const clearSend = await fetch(`${base}/sunx/groups/${gid}/send`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '/clear', mentions: [aJid] }) });
    assert.equal(clearSend.status, 200, '/clear 受理');
    await waitFor(async () => {
      const r = await (await fetch(`${base}/sunx/groups/${gid}/messages`, { headers: AUTH })).json() as { messages: Array<{ kind: string; command?: string; from: { id: string } }> };
      return r.messages.some((x) => x.kind === 'command' && x.command === '/clear' && x.from.id === aJid);
    }, 5000);
    const snapCleared = await (await fetch(`${base}/session/${aLive}/snapshot`, { headers: AUTH })).json() as { queued: unknown[] };
    assert.equal(snapCleared.queued.length, 0, '/clear 清空排队');

    const stopSend = await fetch(`${base}/sunx/groups/${gid}/send`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '/stop', mentions: [aJid] }) });
    assert.equal(stopSend.status, 200, '/stop 受理');
    await waitFor(async () => (await (await fetch(`${base}/session/${aLive}/snapshot`, { headers: AUTH })).json() as { queuePaused: boolean }).queuePaused === true, 5000);
    const continueSend = await fetch(`${base}/sunx/groups/${gid}/send`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '/continue', mentions: [aJid] }) });
    assert.equal(continueSend.status, 200, '/continue 受理');
    await waitFor(async () => (await (await fetch(`${base}/session/${aLive}/snapshot`, { headers: AUTH })).json() as { queuePaused: boolean }).queuePaused === false, 5000);

    const destructive = await fetch(`${base}/sunx/groups/${gid}/send`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '/delete', mentionAll: true }) });
    assert.equal(destructive.status, 400, '@all 破坏件禁止');
    const roomOnly = await fetch(`${base}/sunx/groups/${gid}/send`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '仅记录' }) });
    assert.equal(roomOnly.status, 200);
    const roomOnlyBody = await roomOnly.json() as { targets: unknown[] };
    assert.equal(roomOnlyBody.targets.length, 0, 'room-only');

    const hits = await (await fetch(`${base}/sunx/groups/${gid}/search?q=${encodeURIComponent('你好')}`, { headers: AUTH })).json() as { results: unknown[] };
    assert.ok(hits.results.length >= 1, '查询命中');

    const renamed = await fetch(`${base}/sunx/groups/${gid}`, { method: 'PATCH', headers: AUTH, body: JSON.stringify({ name: '研发二群' }) });
    assert.equal(renamed.status, 200);
    const delBusy = await fetch(`${base}/sunx/groups/${gid}`, { method: 'DELETE', headers: AUTH });
    assert.equal(delBusy.status, 409, '有成员不可删');
    const delDefault = await fetch(`${base}/sunx/groups/grp_default`, { method: 'DELETE', headers: AUTH });
    assert.equal(delDefault.status, 409, '默认群不可删');
    const tmpGroup = await (await fetch(`${base}/sunx/groups`, { method: 'POST', headers: AUTH, body: JSON.stringify({ name: '临时群' }) })).json() as { group: { id: string } };
    assert.equal((await fetch(`${base}/sunx/groups/${tmpGroup.group.id}`, { method: 'DELETE', headers: AUTH })).status, 200, '空群可删');
  } finally {
    await s.close();
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    if (prevSunx === undefined) delete process.env.SUNSHINEX_SUNX_DIR;
    else process.env.SUNSHINEX_SUNX_DIR = prevSunx;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
