import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatItem } from './session';
import { collapsibleBlocks, HISTORY_VIEWPORT_ROUNDS, REVIEW_DEFAULT_EXPANDED, reviewViewport, splitRounds } from './history-view';

function msg(role: ChatItem['role'], text: string, detail?: string): ChatItem {
  return { role, text, ts: 0, seq: 0, ...(detail !== undefined ? { detail } : {}) };
}

test('splitRounds：用户消息切轮，非用户消息并入当前轮', () => {
  const rounds = splitRounds([
    msg('user', '甲'),
    msg('tool', '调用'),
    msg('assistant', '答甲'),
    msg('user', '乙'),
    msg('assistant', '答乙'),
  ]);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].start, 0);
  assert.deepEqual(rounds[0].items.map((m) => m.role), ['user', 'tool', 'assistant']);
  assert.equal(rounds[1].start, 3);
  assert.deepEqual(rounds[1].items.map((m) => m.text), ['乙', '答乙']);
});

test('splitRounds：开头无用户消息的杂项兜底为首轮', () => {
  const rounds = splitRounds([msg('system', '欢迎'), msg('user', '甲')]);
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds[0].items.map((m) => m.role), ['system']);
  assert.equal(rounds[1].start, 1);
});

test('splitRounds：空消息返回空轮', () => {
  assert.deepEqual(splitRounds([]), []);
});

test('collapsibleBlocks：仅含可展开原文的思考/工具结果块（调用行不占焦点步进）', () => {
  const rounds = splitRounds([
    msg('user', '甲'),
    msg('tool', 'READ a.ts', 'obs-a'),
    msg('assistant', '答'),
    msg('thinking', 'Thought for 1s', '全文'),
    msg('tool', 'READ b.ts'),
    msg('system', 'sys'),
  ]);
  assert.deepEqual(collapsibleBlocks(rounds), [
    { round: 0, item: 1 },
    { round: 0, item: 3 },
  ]);
  assert.deepEqual(collapsibleBlocks([]), []);
});

test('reviewViewport：展开集 = 最新 3 块 ∪ 焦点块（至多 4 块），窗口锚定焦点块所在轮', () => {
  const rounds = splitRounds([
    msg('user', '甲'),
    msg('tool', 'b0', 'obs-b0'),
    msg('tool', 'b1', 'obs-b1'),
    msg('assistant', '答甲'),
    msg('user', '乙'),
    msg('tool', 'b2', 'obs-b2'),
    msg('tool', 'b3', 'obs-b3'),
    msg('tool', 'b4', 'obs-b4'),
    msg('assistant', '答乙'),
  ]);
  // 块序：0=(0,1) 1=(0,2) 2=(1,1) 3=(1,2) 4=(1,3)
  const keyOf = (i: number) => {
    const b = collapsibleBlocks(rounds)[i];
    return `${b.round}:${b.item}`;
  };
  const v4 = reviewViewport(rounds, 4);
  assert.equal(v4.end, 1, '窗口末轮锚定焦点块所在轮');
  assert.equal(v4.start, 0);
  assert.deepEqual([...v4.expanded].sort(), [keyOf(2), keyOf(3), keyOf(4)].sort(), '焦点在末块：默认 3 块展开');
  const v1 = reviewViewport(rounds, 1);
  assert.equal(v1.end, 0, '焦点上移，窗口随动');
  assert.deepEqual([...v1.expanded].sort(), [keyOf(1), keyOf(2), keyOf(3), keyOf(4)].sort(), '焦点块并入默认 3 块（至多 4 块展开）');
  assert.equal(reviewViewport(rounds, -5).end, 0, '焦点越界下钳制');
  assert.equal(reviewViewport(rounds, 99).end, 1, '焦点越界上钳制');
  assert.equal(reviewViewport([], 0).view.length, 0, '空消息零视口');
});

test('reviewViewport：视口最多 6 轮（锚定焦点块所在轮向前取）', () => {
  const msgs: ChatItem[] = [];
  for (let i = 0; i < 8; i++) msgs.push(msg('user', `t${i}`), msg('tool', `k${i}`, `obs-k${i}`));
  const rounds = splitRounds(msgs);
  assert.equal(reviewViewport(rounds, 5).view.length, HISTORY_VIEWPORT_ROUNDS);
  assert.equal(reviewViewport(rounds, 0).view.length, 1);
  assert.equal(reviewViewport(rounds, 5).expanded.size, REVIEW_DEFAULT_EXPANDED, '默认展开最新 3 块');
});
