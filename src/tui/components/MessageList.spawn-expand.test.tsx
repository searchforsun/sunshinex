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

test('历史区不再渲染归档 SPAWN 行与配对结果行（2026-09-28 统一口径：子代理由动态区承载）', () => {
  // Static 区内容打印一次后不进动态帧：历史断言一律走 allOutput()（test-ink 口径）
  const f = render(
    <MessageList messages={msgs} columns={80} banner={banner} expandAll={false} latestFull={false} />,
  ).allOutput();
  assert.doesNotMatch(f, /SPAWN reviewer/, '归档 SPAWN 调用行不进时间线');
  assert.doesNotMatch(f, /SPAWN writer/, '归档 SPAWN 调用行不进时间线');
  assert.doesNotMatch(f, /结论行/, '子代理转录不再折入时间线（回看走 Ctrl+B → 全屏）');
});

test('spawn 配对结果行整对剔除（2026-09-28 真机残留修复）：result.callId → call 行 seq 配对命中', () => {
  // 生产链路：spawn 调用行与配对结果行均携带同一 callId——结果行缺 callId 即配不上、整对泄漏进时间线
  const paired: ChatItem[] = [
    { role: 'tool', text: 'SPAWN reviewer', ts: 0, seq: 7, kind: 'call', callId: 'c1', detail: '结论行A', subagentMeta: { steps: 2, durationMs: 1000, tokens: 500 } },
    { role: 'tool', text: 'rv 完成', ts: 0, seq: 9, kind: 'result', callId: 'c1' },
  ];
  const f = render(
    <MessageList messages={paired} columns={80} banner={banner} expandAll={false} latestFull={false} />,
  ).allOutput();
  assert.doesNotMatch(f, /SPAWN reviewer/, '配对调用行不进时间线');
  assert.doesNotMatch(f, /rv 完成/, '配对结果行不进时间线——callId 缺失即整对泄漏（真机残留病根）');
  // 非配对结果行（普通工具）不受误伤
  const normal: ChatItem[] = [
    ...paired,
    { role: 'tool', text: '普通工具结果', ts: 0, seq: 11, kind: 'result', callId: 'other' },
  ];
  const f2 = render(
    <MessageList messages={normal} columns={80} banner={banner} expandAll={false} latestFull={false} />,
  ).allOutput();
  assert.match(f2, /普通工具结果/, '普通工具结果行保留');
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
