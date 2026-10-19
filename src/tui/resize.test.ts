import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResizeGate, RESIZE_DEBOUNCE_MS } from './resize';

test('resize 防抖：窗口常量为 200ms（拖拽安静阈值）', () => {
  assert.equal(RESIZE_DEBOUNCE_MS, 200);
});

test('resize 冻结-重放：突发首事件冻结、settle 重放；连发收敛为一次重放，dispose 后不再触发', async () => {
  let freezes = 0;
  let repaints = 0;
  const listeners: Array<() => void> = [];
  const source = {
    on: (_e: 'resize', l: () => void) => listeners.push(l),
    off: (_e: 'resize', l: () => void) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  // 事件分发按真实 EventEmitter 语义：只触达当前订阅者（dispose 后订阅已注销，emit 自然成为空操作）
  const emit = (): void => {
    for (const l of [...listeners]) l();
  };
  // 防抖窗口压到 20ms，测试不等 200ms
  const gate = createResizeGate({ source, onFreeze: () => (freezes += 1), onRepaint: () => (repaints += 1), debounceMs: 20 });
  assert.equal(listeners.length, 1, '应订阅 resize');

  emit(); // 突发首事件：冻结定格（不重放）
  assert.equal(freezes, 1);
  assert.equal(repaints, 0, '首事件只冻结不重放');
  emit();
  emit();
  emit(); // 拖拽连发：继续冻结态，settle 顺延
  assert.equal(freezes, 1, '连发不再重复冻结');
  assert.equal(repaints, 0, '拖拽中零重放');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(repaints, 1, '窗口安静后收敛重放一次');

  emit(); // 新突发：再次冻结 → settle 重放
  assert.equal(freezes, 2, 'settle 后新突发的首事件重新冻结');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(repaints, 2);

  gate.dispose();
  emit();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(repaints, 2, 'dispose 后 resize 不再重放');
});

test('resize 冻结-重放：无 onFreeze 宿主退回旧「首事件立即重绘」语义', async () => {
  let repaints = 0;
  const listeners: Array<() => void> = [];
  const source = {
    on: (_e: 'resize', l: () => void) => listeners.push(l),
    off: (_e: 'resize', l: () => void) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const gate = createResizeGate({ source, onRepaint: () => (repaints += 1), debounceMs: 20 });
  listeners[0]!();
  assert.equal(repaints, 1, '首事件立即重绘');
  listeners[0]!();
  assert.equal(repaints, 1, '连发进入防抖');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(repaints, 2, 'settle 收敛重绘');
  gate.dispose();
});
