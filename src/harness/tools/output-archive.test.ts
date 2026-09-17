import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createToolOutputArchive, TOOL_OUTPUT_CHAR_LIMIT, PREVIEW_CHARS } from './output-archive';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-archive-'));
}

test('超限输出截断为预览+路径提示，原文全文落盘 tool-outputs/', () => {
  const dir = tmpdir();
  const big = 'x'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 1);
  const archive = createToolOutputArchive(() => dir);
  const out = archive.fit('read', big);
  const m = out.match(/\[truncated · full output: (.+)\]/);
  assert.ok(m, '提示行含完整输出路径');
  const file = m[1];
  // 恢复路径纪律：落盘内容必须是原文全文（非 JSON 转义形态），模型 read 回即原文
  assert.equal(fs.readFileSync(file, 'utf8'), big);
  assert.ok(file.includes(path.join('tool-outputs', '')));
  assert.ok(file.endsWith('.txt'));
  assert.ok(out.startsWith('x'.repeat(PREVIEW_CHARS)));
});

test('恰好达到预算不截断（> 判定），未超限不触目录解析（惰性求值）', () => {
  let dirCalls = 0;
  const archive = createToolOutputArchive(() => {
    dirCalls++;
    return tmpdir();
  });
  const exact = 'y'.repeat(TOOL_OUTPUT_CHAR_LIMIT);
  assert.equal(archive.fit('exec', exact), exact);
  assert.equal(dirCalls, 0);
});

test('落盘失败降级为纯截断提示，不向上抛', () => {
  const archive = createToolOutputArchive(
    () => tmpdir(),
    () => {
      throw new Error('disk full');
    },
  );
  const out = archive.fit('exec', 'z'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 5));
  assert.match(out, /\[truncated\]/);
  assert.ok(!out.includes('full output'));
});

test('同实例序号递增：不同超限输入文件名不同且序号单调', () => {
  const dir = tmpdir();
  const archive = createToolOutputArchive(() => dir);
  const a = archive.fit('read', 'a'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 1));
  const b = archive.fit('read', 'b'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 1));
  const fa = a.match(/\[truncated · full output: (.+)\]/)![1];
  const fb = b.match(/\[truncated · full output: (.+)\]/)![1];
  assert.notEqual(fa, fb);
  assert.ok(path.basename(fa).startsWith('1-'));
  assert.ok(path.basename(fb).startsWith('2-'));
});
