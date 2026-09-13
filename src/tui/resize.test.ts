import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResizeDebouncer, createResizeGate, RESIZE_DEBOUNCE_MS } from './resize';

test('resize 防抖：首事件立即执行，后续事件交由防抖窗口', () => {
  const d = createResizeDebouncer();
  assert.equal(d.bump(), true, '首个 resize 事件应立即重绘');
  assert.equal(d.bump(), false, '拖拽中的连发事件不应立即重绘');
  assert.equal(d.bump(), false);
  assert.equal(d.bumps(), 3);
});

test('resize 防抖：窗口到期 fire 后，下一个事件再次立即执行', () => {
  const d = createResizeDebouncer();
  d.bump();
  d.bump();
  d.fire();
  assert.equal(d.bump(), true, '防抖窗口安静后首个事件应立即重绘');
});

test('resize 防抖：窗口常量为 200ms（拖拽安静阈值）', () => {
  assert.equal(RESIZE_DEBOUNCE_MS, 200);
});

test('resize 收敛层：连发事件按防抖收敛为一次重绘，dispose 后不再触发', async () => {
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
  const gate = createResizeGate({ source, onRepaint: () => (repaints += 1), debounceMs: 20 });
  assert.equal(listeners.length, 1, '应订阅 resize');

  emit(); // 首事件：立即重绘
  assert.equal(repaints, 1);
  emit();
  emit();
  emit(); // 拖拽连发：进入防抖
  assert.equal(repaints, 1, '防抖窗口内连发不重绘');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(repaints, 2, '窗口安静后收敛重绘一次');

  gate.dispose();
  emit();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(repaints, 2, 'dispose 后 resize 不再重绘');
});
