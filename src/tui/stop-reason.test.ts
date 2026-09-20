import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeIncomplete } from './stop-reason';
import { StopReason } from '../types';

test('describeIncomplete：护栏原因各有明确文案', () => {
  assert.match(describeIncomplete('deadline'), /time limit/);
  assert.match(describeIncomplete('budget'), /budget exhausted/);
  assert.match(describeIncomplete('max-steps'), /max steps/);
});

test('describeIncomplete：正常完成与模型失败不由本函数重复上屏', () => {
  assert.equal(describeIncomplete('done'), '');
  assert.equal(describeIncomplete('model-error'), '', '模型失败已走 error 通道，避免双份提示');
  assert.equal(describeIncomplete(undefined), '');
});

test('describeIncomplete：未知值走兜底文案不静默（D11）', () => {
  assert.match(describeIncomplete('paused' as StopReason), /Incomplete:/);
});
