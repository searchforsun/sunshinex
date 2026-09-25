import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { MessageList } from './MessageList';
import { BannerInfo } from '../banner-info';
import { ChatItem, LiveBlock } from '../session';

/** 2026-09-26 用户裁决「工具执行时原地显示运行中状态，不要甩到屏幕底部」：去 Static 全量渲染后，
 *  pending 调用行在历史区原地呈现运行态（动画 glyph + 实时耗时），结果回程定格中性 ● 行。 */

const banner = { version: '0.0.0', model: 'test', root: '/tmp/proj' } as unknown as BannerInfo;

const call = (over: Partial<ChatItem> = {}): ChatItem => ({
  role: 'tool',
  kind: 'call',
  text: 'READ src/a.ts',
  ts: Date.now(),
  seq: 1,
  pending: true,
  ...over,
});

const props = { banner, columns: 80, expandAll: false, latestFull: false } as const;

test('pending 调用行原地运行态：历史区动画 glyph + 耗时（不再依赖底部活动行）', () => {
  const one = render(<MessageList {...props} messages={[call()]} />);
  const f = one.lastFrame() ?? '';
  assert.match(f, /✻ \[READ\] src\/a\.ts/, 'pending 调用行应呈动画 glyph（运行态原地可见）');
  assert.match(f, /\[READ\] src\/a\.ts \d+s/, 'pending 调用行应带实时耗时');
  one.unmount();
});

test('结果回程后调用行定格中性 ● 行：不再显示动画 glyph 与进行中耗时', () => {
  const msgs = [call({ pending: false }), { role: 'tool', kind: 'result', ok: true, text: 'contents…', ts: Date.now(), seq: 2 } as ChatItem];
  const one = render(<MessageList {...props} messages={msgs} />);
  const f = one.lastFrame() ?? '';
  assert.match(f, /● \[READ\] src\/a\.ts/, '完成后调用行应定格中性 ● 形态');
  assert.doesNotMatch(f, /✻ \[READ\]/, '完成后不再显示动画 glyph');
  assert.doesNotMatch(f, /\[READ\] src\/a\.ts \d+s/, '完成后不再显示进行中耗时');
  one.unmount();
});

test('去 Static 后 live 流式块照常渲染（全量渲染不丢动态区）', () => {
  const live: LiveBlock = { kind: 'reply', text: 'drafting…', startedAt: Date.now() };
  const one = render(<MessageList {...props} messages={[call()]} live={live} />);
  const f = one.lastFrame() ?? '';
  assert.match(f, /drafting…/, 'live 流式预览仍应渲染');
  one.unmount();
});

