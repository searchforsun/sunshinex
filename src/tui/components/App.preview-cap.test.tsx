import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePreviewCap } from './App';

test('computePreviewCap：总帧高 = chrome 实账 + cap ≤ rows-1（ink3 outputHeight>=rows 即 clearTerminal——「贴地不再上提」的数字前提）', () => {
  // 典型 chrome：活动行 1 + 输入框 3 + 状态栏 1 + 预览 margin/… 2 = 7；rows=30 时 cap=22 → 帧高 29 ≤ 29 ✓
  assert.equal(computePreviewCap(30, 7), 22);
  // 高视口封顶 28：rows=60, chrome=7 → 52 → 28（绝对上限）
  assert.equal(computePreviewCap(60, 7), 28);
  // 矮视口保底 4：预算为负也不出 0/负数（此时帧高可能仍触顶，clearTerminal 为最后兜底）
  assert.equal(computePreviewCap(10, 12), 4);
  // 子代理面板在场（运行 3 子代理 = 3+2 边框）：chrome 增大 cap 同步收缩
  assert.equal(computePreviewCap(30, 12), 17);
});
