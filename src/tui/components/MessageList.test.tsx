import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { MessageList } from './MessageList';
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

test('MessageList：MdBufferPreview 帧高有界——100 行未闭合围栏 live reply 帧高 ≤ cap+2（F1 回归：防 ink3 clearTerminal 整屏重写）', () => {
  const body = '```ts\n' + Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const live: LiveBlock = {
    kind: 'reply',
    text: body,
    startedAt: 0,
    tailStart: 0, // 围栏开栏即结构起点（session mdConsume 镜像）
  } as LiveBlock;
  const rows = 24;
  const cap = Math.min(28, Math.max(8, rows - 6));
  const one = render(
    <MessageList banner={banner} messages={[]} live={live} columns={80} rows={rows} expandAll={false} latestFull={false} />,
  );
  const frame = one.lastFrame() ?? '';
  const height = frame.replace(/\n+$/, '').split('\n').length;
  assert.ok(height <= cap + 2, `帧高 ${height} ≤ cap+2 = ${cap + 2}（尾窗自尾保留 + 省略行 + margin）`);
  assert.ok(frame.includes('const v99 = 99;'), '最新行（尾行）可见');
  assert.ok(!frame.includes('const v0 = 0;'), '超限头行被截去');
  assert.match(frame, /…/, '截断时首行前有省略提示');
  one.unmount();
});
