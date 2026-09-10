import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, wrapByWidth, bandLines } from './text-band';

test('displayWidth：CJK 记 2，ASCII 记 1', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('a中'), 3);
});

test('wrapByWidth：按显示宽度折行且不丢字', () => {
  assert.deepEqual(wrapByWidth('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(wrapByWidth('中文中文', 4), ['中文', '中文']);
});

test('wrapByWidth：不拆宽字符（宽度 3 装不下两个汉字）', () => {
  assert.deepEqual(wrapByWidth('中文', 3), ['中', '文']);
});

test('bandLines：左右各留 1 空格并补齐至 columns', () => {
  const lines = bandLines('hi', 10);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], ' hi       ');
  assert.equal(displayWidth(lines[0]), 10);
});

test('bandLines：多行 + 折行各自补齐', () => {
  const lines = bandLines('a\nbb', 6);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], ' a    ');
  assert.equal(lines[1], ' bb   ');
  assert.ok(lines.every((l) => displayWidth(l) === 6));
});
