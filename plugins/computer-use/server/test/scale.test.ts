import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shrinkToEdge, toPhysical } from '../src/scale';

test('shrinkToEdge：1568 长边封顶与不放大', () => {
  assert.deepEqual(shrinkToEdge(3136, 1568), { width: 1568, height: 784 });
  assert.deepEqual(shrinkToEdge(800, 600), { width: 800, height: 600 });
});

test('toPhysical：缩放比反算（sent→orig）', () => {
  assert.deepEqual(toPhysical(100, 50, { origWidth: 2000, origHeight: 1000, sentWidth: 1000, sentHeight: 500 }), { x: 200, y: 100 });
});
