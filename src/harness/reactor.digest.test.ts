import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStepDigest, StepRecord } from './reactor';

test('digest：取尾 20 步、单步 itemChars 截断（未触总长上限时步数守恒）', () => {
  const steps: StepRecord[] = Array.from({ length: 25 }, (_, i) => ({
    step: i + 1,
    action: 'read',
    observation: `line-${i} ${'x'.repeat(300)}`,
  }));
  // 总长上限放宽到 4000：本用例只验「取尾 + 单步截断」；总长面由下一用例单独验
  // （20 行 × (7 + 120) = 2559 > 1500，字符级头截断必然减少行数——两断言不可同案并存）
  const d = buildStepDigest(steps, { maxSteps: 20, itemChars: 120, totalChars: 4000 });
  const lines = d.split('\n');
  assert.equal(lines.length, 20);
  assert.ok(lines[0].includes('line-5'), '取尾：保留最近 20 步（自第 6 步起）');
  assert.ok(lines[19].includes('line-24'));
  assert.ok(lines.every((l) => l.length <= 168), '单步 = 前缀 + itemChars 上限');
  assert.equal(lines[0].length, '[read] '.length + 120, '单步 = 前缀 + itemChars 上限（itemChars 截观察首行）');
  assert.ok(d.length <= 4000);
});

test('digest：总长超 totalChars 时自头部截断、保尾部', () => {
  const steps: StepRecord[] = Array.from({ length: 25 }, (_, i) => ({
    step: i + 1,
    action: 'read',
    observation: `line-${i} ${'x'.repeat(300)}`,
  }));
  const d = buildStepDigest(steps, { maxSteps: 20, itemChars: 120, totalChars: 1500 });
  assert.equal(d.length, 1500, '恰好截到 totalChars 上限');
  assert.ok(d.includes('line-24'), '尾部（最近一步）保留');
  assert.ok(!d.includes('line-5'), '较早步骤被从头截掉');
});

test('digest：无 action 的步骤降级为 note 形态；空 steps 返回空串', () => {
  const cfg = { maxSteps: 20, itemChars: 120, totalChars: 1500 };
  const d = buildStepDigest([{ step: 1, observation: 'model output is not valid JSON' }], cfg);
  assert.ok(d.includes('[note] model output is not valid JSON'));
  assert.equal(buildStepDigest([], cfg), '');
});
