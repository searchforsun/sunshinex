import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages } from './messages';
import type { HistoryStep } from '../../types';

/** 链行图片附件 → user 消息 images 透出（buildMessages 确定性映射）：task/plan 行载 images 即多模态
 *  user 消息；空文行兜底占位防端点空 text 块；无图行形态零变化（既有 messages.test 为回归锚，此处只钉图片面）。
 *  Task 3 延伸：渲染期图片历史剪枝（仅最近 N=3 个带图行保图，更早行剥图加 [image elided] 标记）+
 *  tool-result 行图片以批收口后的合成 user 帧（content '(tool image)'）透出——不插在批内 role:tool 之间 */

const STABLE = 'stable';
const IMG = 'data:image/png;base64,aGVsbG8=';

function row(r: Partial<HistoryStep>): HistoryStep {
  return { step: 1, observation: r.observation ?? '', ...(r.action !== undefined ? { action: r.action } : {}), ...(r.images !== undefined ? { images: r.images } : {}) };
}

test('task 行载 images：user 消息携带 images（文本+附件同消息透出）', () => {
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain: [row({ action: 'task', observation: '看图说话', images: [IMG] })] });
  assert.deepEqual(msgs[1], { role: 'user', content: '看图说话', images: [IMG] });
});

test('plan 行载 images 同形态透出（spec §4.4 计划书行按指令行同形）', () => {
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain: [row({ action: 'plan', observation: 'plan doc', images: [IMG] })] });
  assert.deepEqual(msgs[1], { role: 'user', content: 'plan doc', images: [IMG] });
});

test('空文行+images：文本兜底占位（防端点空 text 块），images 原样', () => {
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain: [row({ action: 'task', observation: '', images: [IMG] })] });
  assert.deepEqual(msgs[1], { role: 'user', content: '(image)', images: [IMG] });
});

test('无图行/空白 images 列形态零变化（回归钉子）', () => {
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain: [row({ action: 'task', observation: 'plain' }), row({ action: 'task', observation: 'empty', images: [] })] });
  assert.deepEqual(msgs.slice(1), [
    { role: 'user', content: 'plain' },
    { role: 'user', content: 'empty' },
  ]);
});

/* ---------- 渲染期图片历史剪枝 + tool-result 伴随 user 帧（spec §3.2；journal 全量留档不受影响） ---------- */

test('tool-result 行载 images：tool 消息（纯文本）+ 批收口后合成 user 帧', () => {
  const chain: HistoryStep[] = [
    { step: 1, action: 'tool-call', observation: '[tool] mcp__cu__screenshot {}' },
    { step: 1, action: 'tool-result', observation: 'shot ok', images: [IMG] },
  ];
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain });
  // 无 task 行 → 全链视为当轮（既有思考回传半径语义）：当轮批 assistant 恒带 reasoning 字段（零思考轮兜底空串）
  assert.deepEqual(msgs[1], { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'mcp__cu__screenshot', argsJson: '{}' }], reasoning: '' });
  assert.deepEqual(msgs[2], { role: 'tool', content: 'shot ok', toolCallId: 'call_1' });
  assert.deepEqual(msgs[3], { role: 'user', content: '(tool image)', images: [IMG] });
});

test('历史图片剪枝：仅最近 N=3 个带图行保图，更早行剥图加 [image elided] 标记', () => {
  const mk = (n: number): HistoryStep => ({ step: n, action: 'tool-call', observation: `[tool] t${n} {}` });
  const chain: HistoryStep[] = [1, 2, 3, 4, 5].flatMap((n) => [mk(n), { step: n, action: 'tool-result' as const, observation: `r${n}`, images: [IMG] }]);
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain });
  const withImg = msgs.filter((m) => m.role === 'user' && m.images !== undefined);
  assert.equal(withImg.length, 3);
  const toolMsgs = msgs.filter((m) => m.role === 'tool') as Array<{ content: string }>;
  assert.equal(toolMsgs.filter((m) => m.content.includes('[image elided]')).length, 2);
});

test('imageHistoryLimit 覆盖与 0 值', () => {
  const chain: HistoryStep[] = [{ step: 1, action: 'task', observation: '看图', images: [IMG] }];
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain }, 0);
  assert.deepEqual(msgs[1], { role: 'user', content: '看图\n[image elided]' });
});
