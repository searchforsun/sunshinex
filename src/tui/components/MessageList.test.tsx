import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { MessageList, replyPreviewWindow } from './MessageList';
import { ChatItem, LiveBlock } from '../session';
import { BannerInfo } from '../banner-info';

const banner: BannerInfo = { version: '1.0', model: 'm', root: 'r' } as BannerInfo;
const mk = (over: Partial<ChatItem>): ChatItem => ({ role: 'assistant', text: '', ts: 1, seq: 1, ...over });

test('MessageList：ansi 条目直嵌 Text（框线表格呈现），普通条目照旧', () => {
  const one = render(
    <MessageList
      banner={banner}
      messages={[mk({ seq: 1, text: '│ a │ b │\n├───┼───┤', ansi: true })]}
      columns={80}
      expandAll={false}
      latestFull={false}
    />,
  );
  assert.ok(one.allOutput().includes('│ a │ b │'), 'ANSI 表格行原样上屏');
  one.unmount();
});

test('MessageList：ansi 条目防双重渲染——星号字面原样直嵌（markdansi 不转义星号，不得再过 MarkdownText 加粗）', () => {
  const one = render(
    <MessageList
      banner={banner}
      messages={[mk({ seq: 2, text: '**bold** 字面与结论行', ansi: true })]}
      columns={80}
      expandAll={false}
      latestFull={false}
    />,
  );
  assert.ok(one.allOutput().includes('**bold**'), '星号字面保留（经 MarkdownText 二次渲染会被吃成粗体字形）');
  one.unmount();
});

test('MessageList：ansi 条目间区域间距统一单空行——尾部 \\n 即块间 margin，marginBottom 折 0（不再双空行）', () => {
  const one = render(
    <MessageList
      banner={banner}
      messages={[
        mk({ seq: 1, text: '片段甲首行\n片段甲次行\n', ansi: true }),
        mk({ seq: 2, text: '片段乙首行\n', ansi: true }),
      ]}
      columns={80}
      expandAll={false}
      latestFull={false}
    />,
  );
  const lines = one.allOutput().replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').replace(/\n+$/, '').split('\n');
  const i = lines.findIndex((l) => l.includes('片段甲次行'));
  let gap = 0;
  for (let j = i + 1; j < lines.length && lines[j]!.trim() === ''; j++) gap++;
  assert.equal(gap, 1, `ansi→ansi 边界空行数应恒 1（实际 ${gap}——margin 叠加时代为 2）`);
  one.unmount();
});

test('MessageList：live reply 期间 MdBufferPreview 按水位切片显示未消费结构（表格已开表头可见，已入档内容不重演）', () => {
  // 源里表格已入档（渲染态在 Static），水位指向后续未消费结构起点——预览只显示水位之后的内容
  const text = '前言。\n\n| a | b |\n|---|\n| 1 |\n\n四、后续\n\n| x | y |\n|---|\n| 2';
  const live: LiveBlock = { kind: 'reply', text, startedAt: 0, tailStart: text.indexOf('| x | y |') } as LiveBlock;
  const one = render(
    <MessageList banner={banner} messages={[]} live={live} columns={80} expandAll={false} latestFull={false} />,
  );
  assert.match(one.lastFrame() ?? '', /\| x \| y \|/, '水位后的未消费结构在预览');
  assert.ok(!((one.lastFrame() ?? '').includes('| a | b |')), '已入档的前一张表不以裸文本重演（同屏重复病根）');
  one.unmount();
});

test('MessageList：tailStart 缺省（无未消费结构）预览只显示当前未完行', () => {
  const live: LiveBlock = { kind: 'reply', text: '前言。\n\n已完结段落\n未完行', startedAt: 0 } as LiveBlock;
  const one = render(
    <MessageList banner={banner} messages={[]} live={live} columns={80} expandAll={false} latestFull={false} />,
  );
  assert.match(one.lastFrame() ?? '', /未完行/, '未完行在预览');
  assert.ok(!((one.lastFrame() ?? '').includes('已完结段落')), '已入档段落不重演');
  one.unmount();
});

test('MessageList：MdBufferPreview 恒高窗口——100 行未闭合围栏取尾封顶、无标记行（2026-10-01「不自动反弹」改口径：恒高即帧高限界）', () => {
  const body = '```ts\n' + Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const live: LiveBlock = {
    kind: 'reply',
    text: body,
    startedAt: 0,
    tailStart: 0, // 围栏开栏即结构起点（session mdConsume 镜像）
  } as LiveBlock;
  const rows = 24;
  const one = render(
    <MessageList banner={banner} messages={[]} live={live} columns={80} rows={rows} expandAll={false} latestFull={false} />,
  );
  const frame = one.lastFrame() ?? '';
  // 物理行口径：只剥 log-update 的单个尾随换行——帧尾空白行（margin/垫行）是画布实行，剥多即错账
  const height = frame.replace(/\n$/, '').split('\n').length;
  assert.equal(height, 9, `帧高恒 = 窗口 8 + margin 1（实际 ${height}）`);
  assert.ok(frame.includes('const v99 = 99;'), '最新行（尾行）可见');
  assert.ok(!frame.includes('const v0 = 0;'), '超窗头行被截去');
  assert.ok(!frame.includes('…'), '无截断标记行（标记行随截断出现即 +1 行反弹，恒高口径移除）');
  one.unmount();
});

test('MessageList：MdBufferPreview 恒高窗口——流式三态（短尾段/超窗长尾/块间排空）恒 8 行，输入区零顶跳（防反弹钉）', () => {
  // 三态恒等以纯装配函数钉（排空态帧写全空白，test-ink 的 last 只更新非空白写捕不到帧）；
  // 帧高恒等已由上例渲染口径（9/9）与本函数三态恒 8 行共同锁死
  const rows = 24;
  const windowRows = Math.max(4, Math.min(8, rows - 10));
  const windows = [
    '段一', // 短尾段：窗口顶部空行补齐
    Array.from({ length: 30 }, (_, i) => `第${i}行`).join('\n'), // 超窗：自尾保留
    '', // 块闭合到下一 delta 之间：尾段排空，窗口恒在（空白垫）
  ].map((tailText) => {
    const live: LiveBlock = { kind: 'reply', text: `已入档。\n\n${tailText}`, startedAt: 0 } as LiveBlock;
    return replyPreviewWindow(live, 80, windowRows);
  });
  for (const w of windows) {
    assert.equal(w.length, windowRows, `窗口恒 ${windowRows} 行（实际 ${w.length}）`);
  }
  assert.ok(windows[0]!.every((l) => l === '' || l.includes('段一')), '短尾段顶部空行补齐');
  assert.match(windows[1]![windowRows - 1] ?? '', /第29行/, '超窗自尾保留（最新行可见）');
  assert.ok(windows[1]!.every((l) => !l.includes('第0行')), '超窗头行截去');
  assert.ok(windows[2]!.every((l) => l === ''), '排空态窗口恒在（空白垫，帧高零变化）');
});
