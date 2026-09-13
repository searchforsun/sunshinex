import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_SEGMENT_MAX_LINES, stableReplySegment } from './reply-flusher';

test('reply-flusher：段落边界切块，seg 含边界空行的换行且为严格中缀', () => {
  const text = '第一段。\n\n第二段。';
  assert.equal(stableReplySegment(text, 0), '第一段。\n\n');
  assert.equal(stableReplySegment(text, 5), '\n', '残留空行单独放行（只推进不入档）');
  assert.equal(stableReplySegment(text, 6), null, '只剩未完结行：无安全点');
});

test('reply-flusher：闭合围栏整体放行，seg 含边界换行', () => {
  const text = '```json\n{"a": 1}\n```\n\n后续。';
  assert.equal(stableReplySegment(text, 0), '```json\n{"a": 1}\n```\n\n', '闭合 + 空行边界：围栏整块放行');
  const tail = text.indexOf('后续。');
  assert.equal(stableReplySegment(text, tail), null, '只剩未完结尾段：不入档');
});

test('reply-flusher：围栏内空行不产生切点（代码块完整性）', () => {
  const text = '```js\n行1\n\n行2\n```\n\n后文。';
  assert.equal(stableReplySegment(text, 0), '```js\n行1\n\n行2\n```\n\n', '围栏内空行不得切块');
  const mid = text.indexOf('行1');
  assert.equal(
    stableReplySegment(text, mid),
    '行1\n\n行2\n```\n\n',
    '从围栏内容起扫（防御路径）：补全至闭合围栏 + 段落边界，拼接仍无损',
  );
});

test('reply-flusher：围栏开启未闭合时零切点', () => {
  const text = '前言。\n\n```json\n{"a": 1}\n';
  assert.equal(stableReplySegment(text, 0), '前言。\n\n', '围栏前的段落正常放行');
  const after = text.indexOf('```json');
  assert.equal(stableReplySegment(text, after), null, '围栏内（未闭合）不可切');
});

test('reply-flusher：无空行超长段按最近换行兜底切块', () => {
  const longPara = Array.from({ length: 30 }, (_, i) => `行${i}`).join('\n');
  const seg = stableReplySegment(longPara, 0);
  assert.ok(seg !== null, '超长段应触发兜底切块');
  assert.equal(seg.split('\n').length - 1, REPLY_SEGMENT_MAX_LINES, '首块恰为上限行数');
});

test('reply-flusher：纯空白切段返回原串（session 侧只推进不入档）', () => {
  assert.equal(stableReplySegment('\n\n正文', 0), '\n\n');
});

test('reply-flusher：无换行或已追平返回 null', () => {
  assert.equal(stableReplySegment('单行生成中', 0), null);
  assert.equal(stableReplySegment('a\nb\n', 4), null);
  assert.equal(stableReplySegment('', 0), null);
});

test('reply-flusher：GFM 表格超兜底线也整表放行，不中途切割', () => {
  const header = '| 模块 | 问题 | 建议 |';
  const divider = '| --- | --- | --- |';
  const rows = Array.from({ length: 30 }, (_, i) => `| 服务${i} | 问题${i} | 建议${i} |`);
  const table = [header, divider, ...rows].join('\n');
  const text = `前言。\n\n${table}\n\n后续。`;
  assert.equal(
    stableReplySegment(text, 0),
    `前言。\n\n${table}\n\n`,
    '32 行表格远超 24 行兜底：整表 + 空行一起放行',
  );
});

test('reply-flusher：表格流式未完（尾行为表格行且无换行）不切，等待整表', () => {
  const partial = ['| A | B |', '| --- | --- |', '| 行1 | 值 |', '| 行2 | 值'].join('\n');
  const text = `前言。\n\n${partial}`;
  const committed = '前言。\n\n'.length;
  assert.equal(stableReplySegment(text, committed), null, '表格未闭合不切');
});

test('reply-flusher：表格闭合于内容行即整表放行（不等后续段落边界）', () => {
  const header = '| 模块 | 问题 |';
  const divider = '| --- | --- |';
  const rows = ['| 服务A | 超卖风险 |', '| 服务B | 幂等缺失 |'];
  const table = [header, divider, ...rows].join('\n');
  // 表格后无空行直接跟正文（模型省略空行的常见输出）
  const text = `前言。\n\n${table}\n正文紧跟表格。`;
  const seg = stableReplySegment(text, 0);
  assert.ok(seg !== null, '表格闭合于内容行应立即产生切点');
  assert.ok(seg!.includes('| 服务B | 幂等缺失 |'), '切点应覆盖整张表');
  assert.ok(!seg!.includes('正文紧跟'), '表格后的正文不入本段');
});
