import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteeringChannel } from './steering';

test('steering 通道：enqueue→drain FIFO 出队，delivered 只计已投递', () => {
  const ch = new SteeringChannel();
  assert.equal(ch.delivered(), 0);
  ch.enqueue('User steer: a');
  ch.enqueue('User steer: b');
  assert.deepEqual(ch.drain(), ['User steer: a', 'User steer: b']);
  assert.equal(ch.delivered(), 2);
  assert.deepEqual(ch.drain(), []);
});

test('steering 通道：收口兜底 takePending——只取未投递行补跑，已投递不重复计数', () => {
  const ch = new SteeringChannel();
  ch.enqueue('a');
  ch.enqueue('b');
  ch.enqueue('c');
  ch.drain(); // a/b/c 已投递进当前 run（链上可见，收口不补跑）
  ch.enqueue('d'); // run 末段入队，未及步边界
  assert.deepEqual(ch.takePending(), ['d']);
  assert.equal(ch.delivered(), 3);
  assert.deepEqual(ch.drain(), []);
  assert.equal(ch.delivered(), 3);
});

test('steering 通道：takePending 兼作撤回取回——取回后重新入队，投递计数不虚增', () => {
  const ch = new SteeringChannel();
  ch.enqueue('draft');
  ch.enqueue('later');
  assert.deepEqual(ch.takePending(), ['draft', 'later']);
  ch.enqueue('draft');
  ch.enqueue('later');
  assert.deepEqual(ch.drain(), ['draft', 'later']);
  assert.equal(ch.delivered(), 2);
});
