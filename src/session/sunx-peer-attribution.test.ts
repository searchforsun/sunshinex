// 跨 Sunx 归因贯通（2026-11-26 用户裁定「send_sunx_messages 前缀加上 fromSunx」「发送类似用户气泡
// 直接进入排队」）：user 事件 payload.fromSunx → 内核条目 → seg 行落档 → 重放回种；steer 排队行同链
// （入队→落档→drain 出队归因不丢）。纯内核/段级行件测试，不经 daemon。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionKernel } from './kernel';
import type { KernelEvent } from './kernel';
import { kernelEventRows, reduceSegRows, reduceSteerRows } from './seglog';
import type { SegRowLike } from './seglog';
import { applySeed, initialKernelState } from './entry';
import type { KernelEntry } from './entry';

const PEER = { id: 'sunx-jid-aaa', name: 'Planner' };
const PEER_RUN = { id: 'sunx-jid-aaa', name: 'Planner', runSeq: 12 };

test('user 条归因:submit(fromSunx) → 条目携带 + seg 行落档 + 重放回种同字段', () => {
  const events: KernelEvent[] = [];
  const k = new SessionKernel({ onKernelEvent: (ev) => events.push(ev) });
  k.submit('[fromSunx: Planner (sunx-jid-aaa)] 看板第三列卡住了', undefined, PEER);
  const entry = k.replay().find((e) => e.kind === 'user');
  assert.ok(entry, 'user 条应入内核');
  assert.deepEqual(entry.fromSunx, PEER, '条目携带来源归因');
  assert.match(entry.md, /^\[fromSunx: Planner \(sunx-jid-aaa\)\] /, '前缀原样进 md（模型面/链面来源说明）');

  // 写面:seg-open 行携带 fromSunx
  const segOpen = events.find((ev) => ev.t === 'seg-open');
  assert.ok(segOpen !== undefined);
  const rows = kernelEventRows(segOpen) as SegRowLike[];
  assert.deepEqual(rows[0]?.fromSunx, PEER, 'seg 行随档携带 fromSunx');

  // 读面:重放回种同字段（旧档无字段=普通用户条——由下方无字段用例对照）
  const replay = reduceSegRows(rows);
  assert.deepEqual(replay[0]?.fromSunx, PEER, 'replay 归因不丢');
  const seeded = applySeed(initialKernelState(), replay as ReadonlyArray<KernelEntry & { seq?: number }>);
  assert.deepEqual(seeded.entries[0]?.fromSunx, PEER, 'seed 回种归因不丢');
});

test('群主归因 kind=group:条目/seg/重放往返;非法 kind 丢弃;旧档无 kind 视为 sunx', () => {
  const owner = { id: 'grp_x', name: '群主', kind: 'group' as const };
  const events: KernelEvent[] = [];
  const k = new SessionKernel({ onKernelEvent: (ev) => events.push(ev) });
  k.submit('[fromSunx: 群主 (grp_x)] hi', undefined, owner);
  assert.deepEqual(k.replay().find((e) => e.kind === 'user')?.fromSunx, owner, '条目携带 kind=group');
  const rows = kernelEventRows(events.find((ev) => ev.t === 'seg-open')!) as SegRowLike[];
  assert.deepEqual(reduceSegRows(rows)[0]?.fromSunx, owner, 'seg 行往返 kind=group');
  const legacy = reduceSegRows([{ t: 'seg', kind: 'user', md: 'x', ts: 1, seq: 1, fromSunx: { id: 'a', name: 'n' } }]);
  assert.deepEqual(legacy[0]?.fromSunx, { id: 'a', name: 'n' }, '旧档无 kind 原样（GUI 按 sunx 处理）');
  const bad = reduceSegRows([{ t: 'seg', kind: 'user', md: 'x', ts: 1, seq: 1, fromSunx: { id: 'a', name: 'n', kind: 'weird' } }]);
  assert.deepEqual(bad[0]?.fromSunx, { id: 'a', name: 'n' }, '非法 kind 丢弃，归因仍在');
});

test('user 条归因:runSeq 轮次锚随档往返（点击归因行定位到发送方该轮）', () => {
  const events: KernelEvent[] = [];
  const k = new SessionKernel({ onKernelEvent: (ev) => events.push(ev) });
  k.submit('[fromSunx: Planner (sunx-jid-aaa)] hi', undefined, PEER_RUN);
  const entry = k.replay().find((e) => e.kind === 'user');
  assert.deepEqual(entry?.fromSunx, PEER_RUN, '条目携带 runSeq');
  const segOpen = events.find((ev) => ev.t === 'seg-open');
  const rows = kernelEventRows(segOpen!) as SegRowLike[];
  assert.deepEqual(reduceSegRows(rows)[0]?.fromSunx, PEER_RUN, 'seg 行往返 runSeq 不丢');
  // 坏值净化：runSeq 非正/非数即弃（归因仍在，退化为只打开会话）
  const replay = reduceSegRows([{ t: 'seg', kind: 'user', md: 'x', ts: 1, seq: 1, fromSunx: { id: 'a', name: 'n', runSeq: -3 } }]);
  assert.deepEqual(replay[0]?.fromSunx, { id: 'a', name: 'n' });
});

test('user 条归因:普通用户提交零字段（旧行为逐字节不变）', () => {
  const k = new SessionKernel();
  k.submit('普通消息');
  const entry = k.replay().find((e) => e.kind === 'user');
  assert.equal(entry?.fromSunx, undefined, '无来源=普通用户条（渲染面零归因行）');
});

test('坏载荷净化:payload.fromSunx 缺 id/name 即弃（行面字段不予信任）', () => {
  const k = new SessionKernel();
  k.pump({ type: 'user', text: 'x', payload: { fromSunx: { id: 'a' } }, ts: 1 });
  assert.equal(k.replay().find((e) => e.kind === 'user')?.fromSunx, undefined);
  // 行读面:坏 fromSunx 同样弃
  const replay = reduceSegRows([{ t: 'seg', kind: 'user', md: 'x', ts: 1, seq: 1, fromSunx: { id: '' , name: 'n' } }]);
  assert.equal(replay[0]?.fromSunx, undefined);
});

test('排队归因:steerEnqueue(fromSunx) → steer 行落档 → drain 出队携带（气泡归因不丢）', () => {
  const events: KernelEvent[] = [];
  const k = new SessionKernel({ onKernelEvent: (ev) => events.push(ev) });
  k.steerEnqueue('[fromSunx: Planner (sunx-jid-aaa)] 请汇总', undefined, PEER);
  const steerEv = events.filter((ev) => ev.t === 'steer').pop();
  assert.ok(steerEv !== undefined && steerEv.t === 'steer');
  const rows = kernelEventRows(steerEv) as SegRowLike[];
  assert.deepEqual((rows[0]?.items as Array<{ fromSunx?: unknown }>)[0]?.fromSunx, PEER, 'steer 行随档携带 fromSunx');
  // 读面（重启装载）
  const restored = reduceSteerRows(rows);
  assert.deepEqual(restored[0]?.fromSunx, PEER, 'steer 行重放归因不丢');
  // 轮收束补跑：steerTakePending 原样带出
  k.steerMoveToFront(0);
  const drained = k.steerDrain();
  assert.deepEqual(drained[0]?.fromSunx, PEER, 'drain 出队归因随行（出队气泡同显来源行）');
});
