import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteeringChannel } from './steering';

test('steering 通道：enqueue→drain FIFO 出队（空白行忽略）', () => {
  const ch = new SteeringChannel();
  ch.enqueue('User steer: a');
  ch.enqueue('User steer: b');
  ch.enqueue('   ');
  assert.deepEqual(ch.drain(), ['User steer: a', 'User steer: b']);
  assert.deepEqual(ch.drain(), []);
});

test('steering 通道：收口兜底 takePending——只取未投递行补跑，已投递不回流', () => {
  const ch = new SteeringChannel();
  ch.enqueue('a');
  ch.enqueue('b');
  ch.enqueue('c');
  ch.drain(); // a/b/c 已投递进当前 run（链上可见，收口不补跑）
  ch.enqueue('d'); // run 末段入队，未及步边界
  assert.deepEqual(ch.takePending(), ['d']);
  assert.deepEqual(ch.drain(), [], '已投递行不重复出队');
});

test('steering 通道：takePending 兼作撤回取回——取回后重新入队照常投递；pending 反映队列长', () => {
  const ch = new SteeringChannel();
  ch.enqueue('draft');
  ch.enqueue('later');
  assert.equal(ch.pending(), 2);
  assert.deepEqual(ch.takePending(), ['draft', 'later']);
  assert.equal(ch.pending(), 0);
  ch.enqueue('draft');
  ch.enqueue('later');
  assert.deepEqual(ch.drain(), ['draft', 'later']);
});
