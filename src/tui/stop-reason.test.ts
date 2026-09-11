import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeIncomplete } from './stop-reason';

test('describeIncomplete：护栏原因各有明确文案', () => {
  assert.match(describeIncomplete('deadline'), /时间上限/);
  assert.match(describeIncomplete('budget'), /预算/);
  assert.match(describeIncomplete('max-steps'), /步数上限/);
});

test('describeIncomplete：正常完成与模型失败不由本函数重复上屏', () => {
  assert.equal(describeIncomplete('done'), '');
  assert.equal(describeIncomplete('model-error'), '', '模型失败已走 error 通道，避免双份提示');
  assert.equal(describeIncomplete(undefined), '');
});
