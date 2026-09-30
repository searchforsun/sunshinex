// src/tui/md-ansi.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMd, wrapAnsiLines, ansiLineCount, tailPartial, normalizeCjkLine, isFenceLine, createMdRender } from './md-ansi';

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');

test('renderMd：表格成框线、ANSI 输出、宽度受控', () => {
  const out = renderMd('| a | b |\n|---|---|\n| 1 | 2 |', 60);
  assert.ok(out.includes('│'), '表格框线成形');
  assert.ok(strip(out).split('\n').every((l) => l.length <= 60), '行宽 ≤ width');
});

test('renderMd：全角分隔行归一后成表（|───|───|）', () => {
  const out = renderMd('| 包 | 职责 |\n|───|───|\n| x | y |', 60);
  assert.ok(out.includes('│'), '全角分隔行归一生效');
});

test('wrapAnsiLines：20 万列无空格行折行不爆栈、ANSI 码不切坏', () => {
  const huge = '\x1b[31m' + 'a'.repeat(200_000) + '\x1b[0m';
  const out = wrapAnsiLines(huge, 60);
  const lines = out.split('\n');
  assert.ok(lines.length > 3000, '已按宽折行');
  assert.ok(lines.every((l) => strip(l).length <= 60), '剥码后行宽恒 ≤ 60');
  assert.ok(!/\u001b$/.test(out), '行尾不留半截转义码');
});

test('ansiLineCount：剥码行数', () => {
  assert.equal(ansiLineCount('\x1b[31m甲\x1b[0m\n乙\n'), 2);
});

test('tailPartial：表格已开返回表头起原文；闭合后返回未完行；无未完返回空', () => {
  assert.equal(tailPartial('前言。\n\n| a | b |\n|---|\n| 1'), '| a | b |\n|---|\n| 1');
  assert.equal(tailPartial('| a |\n|───|\n| 1'), '| a |\n|───|\n| 1', '全角分隔行也识别为已开表格');
  assert.equal(tailPartial('第一行\n第二行'), '第二行');
  assert.equal(tailPartial('完整。\n'), '');
});

test('tailPartial：未闭合围栏返回围栏原文（含开栏行）', () => {
  assert.equal(tailPartial('```\ncode'), '```\ncode');
});

test('normalizeCjkLine：全角管道/破折号/冒号归一；围栏内原样', () => {
  assert.equal(normalizeCjkLine('｜ a ｜───｜', false), '| a |---|');
  assert.equal(normalizeCjkLine('|：x：|', false), '|:x:|');
  assert.equal(normalizeCjkLine('｜ 不动 ｜', true), '｜ 不动 ｜');
});

test('isFenceLine：以 ```/~~~ 开头即围栏行（开/闭奇偶由调用侧跟踪）', () => {
  assert.ok(isFenceLine('```ts'));
  assert.ok(isFenceLine('``` 后内容'));
  assert.ok(isFenceLine('~~~'));
  assert.ok(!isFenceLine('普通行'));
});

test('createMdRender：闭包绑定 width/highlighter（streamer options 不透传，实测定形）', () => {
  const render40 = createMdRender(40);
  const out = render40('| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(out.includes('│'), '表格渲染成功');
  assert.ok(out.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').split('\n').every((l) => l.length <= 40), 'width 绑定生效');
});
