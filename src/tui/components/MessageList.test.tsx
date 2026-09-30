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

test('MessageList：live reply 期间 MdBufferPreview 显示 tailPartial 原文（表格已开表头可见）', () => {
  const live: LiveBlock = { kind: 'reply', text: '前言。\n\n| a | b |\n|---|\n| 1', startedAt: 0 } as LiveBlock;
  const one = render(
    <MessageList banner={banner} messages={[]} live={live} columns={80} expandAll={false} latestFull={false} />,
  );
  assert.match(one.lastFrame() ?? '', /\| a \| b \|/, '未闭合表格表头原文在动态区');
  one.unmount();
});

test('MessageList：MdBufferPreview 帧高有界——100 行未闭合围栏 live reply 帧高 ≤ cap+2（F1 回归：防 ink3 clearTerminal 整屏重写）', () => {
  const live: LiveBlock = {
    kind: 'reply',
    text: '```ts\n' + Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`).join('\n'),
    startedAt: 0,
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
