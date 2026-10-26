import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentOf, execResultFromMcp } from './client';
import { CodedToolError } from '../tools';

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
test('mcp isError 结果抛 CodedToolError 且 images 随行（失败语义保真，错误亦可带图）', () => {
  assert.throws(
    () => execResultFromMcp('mcp__fs__shot', { isError: true, content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] }),
    (e: unknown) =>
      e instanceof CodedToolError &&
      e.code === 'MCP_TOOL_ERROR' &&
      e.message === 'MCP tool returned an error: mcp__fs__shot' &&
      Array.isArray(e.images) &&
      e.images[0] === 'data:image/png;base64,aGVsbG8=',
  );
});
test('mcp 成功态映射：text 收 stdout、images 原样随行（execResultFromMcp 回归钉）', () => {
  const r = execResultFromMcp('mcp__fs__shot', {
    content: [{ type: 'text', text: 'done' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' }],
  });
  assert.deepEqual(r, { exitCode: 0, stdout: 'done', stderr: '', timedOut: false, images: ['data:image/jpeg;base64,aGVsbG8='] });
});
