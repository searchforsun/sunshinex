import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { MessageList } from './MessageList';
import { BannerInfo } from '../banner-info';
import { ChatItem } from '../session';

const banner = { version: '0.0.0', model: 'test', root: '/tmp/proj' } as unknown as BannerInfo;

const msgs: ChatItem[] = [
  { role: 'tool', text: 'SPAWN reviewer', ts: 0, seq: 7, kind: 'call', detail: 'READ a.ts\n结论行A', subagentMeta: { steps: 2, durationMs: 1000, tokens: 500 } },
  { role: 'tool', text: 'SPAWN writer', ts: 0, seq: 8, kind: 'call', detail: 'WRITE b.ts\n结论行B', subagentMeta: { steps: 1, durationMs: 500, tokens: 300 } },
];

test('spawnExpandedSeqs 命中行展开为 ▾，未命中行保持 ● 折叠', () => {
  // Static 区内容打印一次后不进动态帧：历史断言一律走 allOutput()（test-ink 口径）
  const f = render(
    <MessageList messages={msgs} columns={80} banner={banner} expandAll={false} latestFull={false} spawnExpandedSeqs={[8]} />,
  ).allOutput();
  assert.match(f, /● \[SPAWN\] reviewer/);
  assert.match(f, /▾ \[SPAWN\] writer/);
  assert.match(f, /结论行B/, '命中行转录重放');
  assert.doesNotMatch(f, /结论行A/, '未命中行转录不重放');
});

test('step 行 Markdown 渲染：▶ 前缀保留、内联加粗不再裸露星号（2026-09-27 真机症状）', () => {
  const stepMsgs: ChatItem[] = [
    { role: 'step', text: '维度分区：1. **AI 能力层**（ai/**）2. **生成管线与工作流**', ts: 0, seq: 20 },
  ];
  const out = render(
    <MessageList messages={stepMsgs} columns={120} banner={banner} expandAll={false} latestFull={false} />,
  ).allOutput();
  assert.match(out, /▶/, '▶ 阶段前缀保留');
  assert.match(out, /AI 能力层/, '正文内容呈现');
  assert.doesNotMatch(out, /\*\*AI 能力层\*\*/, '加粗星号不再裸露（Markdown 内联渲染）');
});
