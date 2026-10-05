import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryInbox } from './inbox';

test('MemoryInbox:send/poll/位点语义(ts 严格大于,至少一次投递的读侧)', async () => {
  const inbox = new MemoryInbox();
  const m1 = await inbox.send('worker', { from: 'lead', text: 'hello' });
  const m2 = await inbox.send('worker', { from: 'lead', text: 'second' });
  assert.notEqual(m1.id, m2.id);
  assert.ok(m1.ts <= m2.ts, 'ts 单调');
  assert.deepEqual(inbox.poll('worker', 0).map((m) => m.text), ['hello', 'second']);
  assert.deepEqual(inbox.poll('worker', m1.ts).map((m) => m.text), ['second'], '位点含等于的上一条之后');
  assert.deepEqual(inbox.poll('other', 0), [], '按收件人隔离');
});
