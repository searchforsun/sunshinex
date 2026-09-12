import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatItem } from './session';
import { HISTORY_VIEWPORT_ROUNDS, reviewWindow, splitRounds } from './history-view';

function msg(role: ChatItem['role'], text: string): ChatItem {
  return { role, text, ts: 0, seq: 0 };
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

test('reviewWindow：末轮向前取 6 轮，endIdx 越界双向钳制', () => {
  const rounds = splitRounds(Array.from({ length: 8 }, (_, i) => msg('user', `t${i}`)));
  const { start, end, view } = reviewWindow(rounds, 7);
  assert.equal(end, 7);
  assert.equal(start, 8 - HISTORY_VIEWPORT_ROUNDS);
  assert.equal(view.length, HISTORY_VIEWPORT_ROUNDS);
  assert.equal(reviewWindow(rounds, 99).end, 7);
  assert.equal(reviewWindow(rounds, -3).end, 0);
  assert.equal(reviewWindow([], 0).view.length, 0);
});
