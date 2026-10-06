import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptCollector } from './transcript';
import type { SessionEvent } from '../types';

/** 纯件测试（零 daemon/网络）：TranscriptCollector 条目累积与配对语义。
 *  口径钉板：user=`> <goal>`；assistant=done reply 全文；tool=`● <verb>\n⎿ <result 首行>`
 *  （call 未配对占位 `⎯ …` → 实取 `…`；乱序按 callId 归位；无 callId FIFO 兜底）；
 *  G3 kind 扩：error/notice/delegation 两态与 agent-message → error|notice 两 kind 归档（§5.3 归档面） */

function ev(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent {
  return { type, ts: 4242, ...(text !== undefined ? { text } : {}), ...(payload !== undefined ? { payload } : {}) };
}

test('① submit+done(reply)：user/assistant 两条序与内容；其余事件忽略', () => {
  const c = new TranscriptCollector();
  c.push(ev('token', '流式'));
  c.push(ev('usage', undefined, { turnTotal: 1 }));
  c.submit('把测试跑绿');
  c.push(ev('route', undefined, { tier: 'base' }));
  c.push(ev('done', '测试全绿', { stopReason: 'done' }));
  const es = c.entries();
  assert.equal(es.length, 2, 'token/usage/route 非归档面事件不产条目');
  assert.equal(es[0]!.kind, 'user');
  assert.equal(es[0]!.md, '> 把测试跑绿');
  assert.equal(es[1]!.kind, 'assistant');
  assert.equal(es[1]!.md, '测试全绿');
  assert.equal(es[1]!.ts, 4242, 'assistant 条 ts=done 事件 ts');
  assert.ok(es[0]!.seq < es[1]!.seq, 'seq 全局单调');
});

test('② tool-call+tool-result 同 callId：单条配对 md（verb 行 + result 首行）', () => {
  const c = new TranscriptCollector();
  c.push(ev('tool-call', 'create_task', { callId: 'c1', input: { title: 'A' }, status: 'pending' }));
  // 挂起面：call 已到 result 未到 → 占位条先入（单条、占位行）
  assert.equal(c.entries().length, 1);
  assert.equal(c.entries()[0]!.md, '● create_task\n⎿ …');
  c.push(ev('tool-result', 'task t1 created\nboard: t1 pending', { callId: 'c1', ok: true, tool: 'create_task', full: 'task t1 created\nboard: t1 pending', status: 'completed' }));
  const es = c.entries();
  assert.equal(es.length, 1, '同 callId 配对归并为单条（不新增条目）');
  assert.equal(es[0]!.kind, 'tool');
  assert.equal(es[0]!.md, '● create_task\n⎿ task t1 created', 'result 只取首行');
  assert.equal(es[0]!.ts, 4242);
});

test('③ 乱序：result 先到 call 后到 → 按 callId 归位同条（verb 回填）', () => {
  const c = new TranscriptCollector();
  c.push(ev('tool-result', 'file content here', { callId: 'x', ok: true, tool: 'read', full: 'file content here', status: 'completed' }));
  // result 先行：条目即刻入列（verb 未知占位），等 call 回填
  assert.equal(c.entries().length, 1);
  assert.equal(c.entries()[0]!.md, '● …\n⎿ file content here');
  c.push(ev('tool-call', 'read', { callId: 'x', input: { path: 'a.ts' }, status: 'pending' }));
  const es = c.entries();
  assert.equal(es.length, 1, '后到 call 归位同条（不新增）');
  assert.equal(es[0]!.md, '● read\n⎿ file content here');
});

test('④ 无 callId：FIFO 兜底——result 配最老未配对条，后来者保持占位', () => {
  const c = new TranscriptCollector();
  c.push(ev('tool-call', 'read', { status: 'pending' }));
  c.push(ev('tool-call', 'grep', { status: 'pending' }));
  c.push(ev('tool-result', 'first result', { ok: true, status: 'completed' }));
  const es = c.entries();
  assert.equal(es.length, 2, '无 callId 不并条，各自占位');
  assert.equal(es[0]!.md, '● read\n⎿ first result', '无 callId result 归最老未配对条（FIFO）');
  assert.equal(es[1]!.md, '● grep\n⎿ …', '后来条保持占位');
});

test('⑤ call 未配对：占位条定格（result 永不到场不蒸发）', () => {
  const c = new TranscriptCollector();
  c.push(ev('tool-call', 'bash', { callId: 'z', input: { command: 'ls' }, status: 'pending' }));
  c.push(ev('done', '收尾', { stopReason: 'done' }));
  const es = c.entries();
  assert.equal(es.length, 2);
  assert.equal(es[0]!.kind, 'tool');
  assert.equal(es[0]!.md, '● bash\n⎿ …');
  assert.equal(es[1]!.md, '收尾');
  assert.ok(es[0]!.seq < es[1]!.seq);
});

test('⑥ kind 扩五路：error→error（缺 text 回落 error）；notice→notice；delegation-started/ended→单行 notice（ended 取 payload.status）；agent-message→[from → to] text', () => {
  const c = new TranscriptCollector();
  c.push(ev('error', 'boom'));
  c.push(ev('error')); // 无 text 面：md 回落字面 'error'
  c.push(ev('notice', '技能已安装'));
  c.push(ev('delegation-started', undefined, { delegationId: 'd1', kind: 'subagent', label: 'build' }));
  c.push(ev('delegation-ended', undefined, { delegationId: 'd1', kind: 'subagent', label: 'build', status: 'done' }));
  c.push(ev('delegation-ended', undefined, { delegationId: 'd2', kind: 'graph-node', label: 'deploy', status: 'failed' }));
  c.push(ev('agent-message', undefined, { messageId: 'm1', from: 'lead', to: 'worker', text: '先跑测试' }));
  const es = c.entries();
  assert.deepEqual(
    es.map((e) => e.kind),
    ['error', 'error', 'notice', 'notice', 'notice', 'notice', 'notice'],
    '五路归档只产 error/notice 两 kind',
  );
  assert.deepEqual(
    es.map((e) => e.md),
    ['boom', 'error', '技能已安装', '✻ build started', '✻ build done', '✻ deploy failed', '[lead → worker] 先跑测试'],
    'md 口径：error=text|error；notice=text；delegation=`✻ label <started|status>`；agent-message=[from → to] text',
  );
  for (let i = 1; i < es.length; i++) assert.ok(es[i].seq > es[i - 1].seq, 'kind 扩条目共用同一 seq 单调序列');
});

