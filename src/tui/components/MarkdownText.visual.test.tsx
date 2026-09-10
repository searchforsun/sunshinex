import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { render } from '../test-ink';
import { MarkdownText } from './MarkdownText';

function frameOf(text: string, columns = 100): string {
  const { lastFrame, unmount } = render(<MarkdownText text={text} columns={columns} />);
  const f = lastFrame() ?? '';
  unmount();
  return f;
}

test('MarkdownText：标题渲染（# 符号不出现）', () => {
  const f = frameOf('# 一级标题');
  assert.match(f, /一级标题/);
  assert.ok(!f.includes('#'), '标题 # 符号应被吞掉');
});

test('MarkdownText：无序/有序列表（符号不出现，有序重排）', () => {
  const f = frameOf('- 甲\n- 乙\n\n1. 丙\n2. 丁');
  assert.match(f, /甲/);
  assert.match(f, /乙/);
  assert.match(f, /丙/);
  assert.match(f, /丁/);
  assert.ok(!f.includes('- 甲'), '无序列表 - 符号应被吞掉');
});

test('MarkdownText：代码块围栏不出现，语言标签与正文出现', () => {
  const f = frameOf('```js\nconst a = 1;\n```');
  assert.match(f, /js/);
  assert.match(f, /const a = 1/);
  assert.ok(!f.includes('```'), '围栏 ``` 应被吞掉');
});

test('MarkdownText：表格对齐输出单元格', () => {
  const f = frameOf('| 环境 | 副本 |\n| --- | --- |\n| 生产 | 3 |');
  assert.match(f, /环境/);
  assert.match(f, /副本/);
  assert.match(f, /生产/);
  assert.match(f, /3/);
  assert.ok(!f.includes('| ---'), '表格分隔行应转为对齐分隔线，而非原样 | --- |');
});

test('MarkdownText：行内加粗/行内代码符号不出现', () => {
  const f = frameOf('**加粗** 与 `行内代码`');
  assert.match(f, /加粗/);
  assert.match(f, /行内代码/);
  assert.ok(!f.includes('**'), '** 符号应被吞掉');
  assert.ok(!f.includes('`'), '` 符号应被吞掉');
});

test('MarkdownText：引用与分割线', () => {
  const f = frameOf('> 引用内容\n\n---');
  assert.match(f, /引用内容/);
  assert.ok(!f.includes('>'), '> 符号应被吞掉');
  assert.ok(!f.includes('---'), '--- 应转为横线');
});

test('MarkdownText：裸文本（无 Markdown 符号）原样输出', () => {
  const f = frameOf('这是普通答复 ok');
  assert.match(f, /这是普通答复 ok/);
});
