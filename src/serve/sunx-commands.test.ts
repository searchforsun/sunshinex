// 群命令通道（2026-11-26 群组规格 P0）：runCommand 带 fromSunx 的 user 行归因；命令正文不加前缀，
// 解析仍看首 token；capture 收命令结果。只测 /status（不触模型/存储）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from './session-commands';
import type { SessionEvent } from '../types';

interface FakeRuntime {
  pump(e: SessionEvent): void;
  status(): string;
  snapshotResponse(): { status: string; model: string; mode: string };
  commandAbort?: AbortController;
}

function fakeRuntime(): { rt: FakeRuntime; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const rt: FakeRuntime = {
    pump: (e) => events.push(e),
    status: () => 'idle',
    snapshotResponse: () => ({ status: 'idle', model: 'test-model', mode: 'full-access' }),
  };
  return { rt, events };
}

test('runCommand fromSunx: user 行归因 + 结果 capture + 原始命令正文（无前缀）', async () => {
  const { rt, events } = fakeRuntime();
  const captured: string[] = [];
  const r = await runCommand(rt as never, '/status', (t) => captured.push(t), { id: 'grp_x', name: '群主', kind: 'group' });
  assert.equal(r, 'ok');
  assert.equal(captured.length, 1);
  assert.match(captured[0]!, /test-model/, '/status 结果捕获');
  const user = events.find((e) => e.type === 'user');
  assert.deepEqual(user, {
    type: 'user',
    text: '/status',
    ts: user!.ts,
    payload: { fromSunx: { id: 'grp_x', name: '群主', kind: 'group' } },
  });
  const result = events.find((e) => e.type === 'tool-result');
  assert.equal(result?.text, captured[0], 'tool-result 文本=捕获结果');
});

test('runCommand 无归因时 user 行不带 payload（旧路径零变化）', async () => {
  const { rt, events } = fakeRuntime();
  await runCommand(rt as never, '/status');
  const user = events.find((e) => e.type === 'user');
  assert.equal(user?.payload, undefined);
});

test('未知命令=unsupported（不落 user 行）', async () => {
  const { rt, events } = fakeRuntime();
  const r = await runCommand(rt as never, '/nope');
  assert.equal(r, 'unsupported');
  assert.equal(events.length, 0);
});
