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

test('MessageList：live reply 期间 MdBufferPreview 显示 tailPartial 原文（表格已开表头可见）', () => {
  const live: LiveBlock = { kind: 'reply', text: '前言。\n\n| a | b |\n|---|\n| 1', committedLen: 0, startedAt: 0 } as LiveBlock;
  const one = render(
    <MessageList banner={banner} messages={[]} live={live} columns={80} expandAll={false} latestFull={false} />,
  );
  assert.match(one.lastFrame() ?? '', /\| a \| b \|/, '未闭合表格表头原文在动态区');
  one.unmount();
});
