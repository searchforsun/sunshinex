import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteeringChannel } from './steering';

test('steering 通道(G14.89 两档)：普通入队 drain 不出(排队=轮收束补跑)；置首条目 drain 出队(插入发送)', () => {
  const ch = new SteeringChannel();
  ch.enqueue('User steer: a');
  ch.enqueue('User steer: b');
  ch.enqueue('   ');
  assert.deepEqual(ch.drain(), [], '普通排队条目不经步边界消费');
  assert.equal(ch.pending(), 2, '普通条目留队');
  ch.moveToFront(1); // b 置首+标记
  assert.deepEqual(ch.drain(), ['User steer: b'], '置首条目步边界注入');
  assert.deepEqual(ch.pendingItems(), ['User steer: a'], '普通条目不受影响');
  assert.deepEqual(ch.drain(), [], '非置首不再出');
});

test('steering 通道：收口兜底 takePending——普通与置首剩余全部补跑，已 drain 投递的不回流', () => {
  const ch = new SteeringChannel();
  ch.enqueue('a');
  ch.enqueue('b');
  ch.enqueue('c');
  ch.moveToFront(0); // a 插入发送:步边界 drain 投递
  assert.deepEqual(ch.drain(), ['a']);
  ch.enqueue('d'); // run 末段入队，未及步边界
  assert.deepEqual(ch.takePending(), ['b', 'c', 'd'], '轮收束兜底按序补跑');
  assert.deepEqual(ch.drain(), [], '已投递行不重复出队');
});

test('steering 通道：takePending 兼作撤回取回——取回后重新入队照常投递；pending 反映队列长；置首后 move 保标记', () => {
  const ch = new SteeringChannel();
  ch.enqueue('draft');
  ch.enqueue('later');
  assert.equal(ch.pending(), 2);
  assert.deepEqual(ch.takePending(), ['draft', 'later']);
  assert.equal(ch.pending(), 0);
  ch.enqueue('draft');
  ch.enqueue('later');
  ch.moveToFront(1);
  ch.move(0, 1); // 置首条目再拖拽:标记随条目走
  assert.deepEqual(ch.drain(), ['later'], 'front 标记随条目移动');
});
