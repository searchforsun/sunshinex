import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages } from './messages';
import type { HistoryStep } from '../../types';

/** 链行图片附件 → user 消息 images 透出（buildMessages 确定性映射）：task/plan 行载 images 即多模态
 *  user 消息；空文行兜底占位防端点空 text 块；无图行形态零变化（既有 messages.test 为回归锚，此处只钉图片面） */

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
