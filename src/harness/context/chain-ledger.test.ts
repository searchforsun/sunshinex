import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainLedger } from './chain-ledger';

/** ChainLedger 单元钉（D25/H3 拆件）：append/trimFront 序（步号递增、水位钳制、裁剪后允许跳号）、
 *  restore 按链内最大步号续排、reset 会话级清零——纯状态机零依赖，直测账本本体。 */

test('append/trim 序：步号链内定死递增；trimFront 推进水位，view 自水位起，越界钳制不回退', () => {
  const led = new ChainLedger();
  const pushed = led.append([
    { action: 'task', observation: '指令行' },
    { observation: '结论行' },
    { action: 'notice', observation: '说明行', reasoning: '思考原文' },
  ]);
  assert.deepEqual(pushed.map((s) => s.step), [1, 2, 3], '步号从 1 连续递增');
  assert.equal(pushed[2].reasoning, '思考原文', 'reasoning 随行透传');
  assert.equal(led.fromView(), 0, '初始水位 0');
  assert.equal(led.view().length, 3, '水位 0 时全量可见');

  led.trimFront(2);
  assert.equal(led.fromView(), 2, '水位推进到 2');
  assert.deepEqual(led.view().map((s) => s.step), [3], 'view 只含存续条目');

  led.append([{ observation: '裁剪后新行' }]);
  assert.deepEqual(led.view().map((s) => s.step), [3, 4], '裁剪后步号续排不回绕（允许跳号语义由全链承载）');

  led.trimFront(100); // 越界钳制
  assert.equal(led.fromView(), 4, '水位钳制到链长，不越界');
  assert.equal(led.view().length, 0);
  led.trimFront(0); // n<=0 不动
  assert.equal(led.fromView(), 4);
});

test('restore 按链内最大步号续排；reset 清链/水位/序号归零', () => {
  const led = new ChainLedger();
  led.append([{ observation: 's1' }, { observation: 's2' }]);
  led.restore([{ step: 7, action: 'node', observation: '历史步骤' }], 0);
  assert.equal(led.fromView(), 0, 'restore 覆盖水位');
  assert.deepEqual(led.view(), [{ step: 7, action: 'node', observation: '历史步骤' }], '整链替换');
  const after = led.append([{ observation: '恢复后新步骤' }]);
  assert.deepEqual(after.map((s) => s.step), [8], '步号从最大值 7 续排');
  led.reset();
  assert.equal(led.fromView(), 0, 'reset 水位归零');
  assert.equal(led.view().length, 0, 'reset 链清空');
  const fresh = led.append([{ observation: '新会话首行' }]);
  assert.equal(fresh[0].step, 1, 'reset 序号归零（/new 新会话从 1 重新起算）');
});
