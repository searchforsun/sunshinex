import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentOf } from './client';

test('mcp image content → ExecResult.images dataURL', async () => {
  // 经 makeTool 产出的 executor 间接钉测：构造最小 RegisteredTool 走 client 内部映射
  // 若 makeTool 未导出，则导出 contentOf 供测（export function contentOf）
  const r = contentOf([
    { type: 'text', text: 'shot taken' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
  ]);
  assert.equal(r.text, 'shot taken');
  assert.deepEqual(r.images, ['data:image/png;base64,aGVsbG8=']);
});
test('mcp 纯 text content 形态零变化（回归钉）', () => {
  const r = contentOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  assert.equal(r.text, 'a\nb');
  assert.equal(r.images, undefined);
});
test('mcp 图片超 MAX_IMAGES 钳制', () => {
  const parts = Array.from({ length: 10 }, (_, i) => ({ type: 'image', data: String(i), mimeType: 'image/png' }));
  const r = contentOf(parts);
  assert.equal(r.images!.length, 8);
});
