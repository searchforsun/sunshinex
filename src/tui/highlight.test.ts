import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightLine, HiSpan } from './highlight';

test('highlightLine：ts 关键字着色，其余 plain', () => {
  const spans = highlightLine('ts', 'const a = 1;');
  assert.deepEqual(spans, [
    { text: 'const', kind: 'keyword' },
    { text: ' a = ', kind: 'plain' },
    { text: '1', kind: 'number' },
    { text: ';', kind: 'plain' },
  ]);
});

test('highlightLine：字符串与注释识别', () => {
  const spans = highlightLine('js', 'const s = "hi" // 注释');
  assert.deepEqual(spans, [
    { text: 'const', kind: 'keyword' },
    { text: ' s = ', kind: 'plain' },
    { text: '"hi"', kind: 'string' },
    { text: ' ', kind: 'plain' },
    { text: '// 注释', kind: 'comment' },
  ]);
});

test('highlightLine：python # 注释与关键字', () => {
  const spans = highlightLine('python', 'def f(): # 函数');
  assert.deepEqual(spans, [
    { text: 'def', kind: 'keyword' },
    { text: ' f(): ', kind: 'plain' },
    { text: '# 函数', kind: 'comment' },
  ]);
});

test('highlightLine：sql -- 注释与关键字', () => {
  const spans = highlightLine('sql', 'select * from t -- 取数');
  assert.deepEqual(spans, [
    { text: 'select', kind: 'keyword' },
    { text: ' * ', kind: 'plain' },
    { text: 'from', kind: 'keyword' },
    { text: ' t ', kind: 'plain' },
    { text: '-- 取数', kind: 'comment' },
  ]);
});

test('highlightLine：未知语言整行 plain', () => {
  assert.deepEqual(highlightLine('foobar', 'fn main() {}'), [
    { text: 'fn main() {}', kind: 'plain' },
  ]);
});

test('highlightLine：未闭合字符串按字面透传不吞字', () => {
  const spans = highlightLine('js', 'const s = "未闭合');
  const text = spans.map((s: HiSpan) => s.text).join('');
  assert.equal(text, 'const s = "未闭合');
});
