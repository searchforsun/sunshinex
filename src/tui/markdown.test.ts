import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, inlineText, alignTable, MdBlock, MdInline } from './markdown';

test('parseMarkdown：标题各级别', () => {
  const blocks = parseMarkdown('# 一级\n## 二级\n### 三级\n###### 六级\n####### 七级归六');
  assert.equal(blocks.length, 5);
  assert.deepEqual(blocks[0], { type: 'heading', level: 1, inlines: [{ kind: 'text', text: '一级' }] });
  assert.equal((blocks[1] as { level: number }).level, 2);
  assert.equal((blocks[2] as { level: number }).level, 3);
  assert.equal((blocks[3] as { level: number }).level, 6);
  assert.equal((blocks[4] as { level: number }).level, 6);
});

test('parseMarkdown：无序列表合并，每项一行', () => {
  const blocks = parseMarkdown('- a\n- b\n* c');
  assert.equal(blocks.length, 1);
  const list = blocks[0] as Extract<MdBlock, { type: 'list' }>;
  assert.equal(list.ordered, false);
  assert.deepEqual(list.items.map(inlineText), ['a', 'b', 'c']);
});

test('parseMarkdown：有序列表合并（中文顿号编号同样识别）', () => {
  const blocks = parseMarkdown('1. 甲\n2. 乙\n3、丙');
  const list = blocks[0] as Extract<MdBlock, { type: 'list' }>;
  assert.equal(list.ordered, true);
  assert.deepEqual(list.items.map(inlineText), ['甲', '乙', '丙']);
});

test('parseMarkdown：围栏代码块含语言标签，内容原样', () => {
  const blocks = parseMarkdown('```js\nconst a = 1;\n```');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { type: 'fence', lang: 'js', code: 'const a = 1;' });
});

test('parseMarkdown：未闭合围栏降级为段落（流式容错）', () => {
  const blocks = parseMarkdown('```js\nconst a = 1;');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(inlineText((blocks[0] as Extract<MdBlock, { type: 'paragraph' }>).inlines), '```js\nconst a = 1;');
});

test('parseMarkdown：引用合并多行', () => {
  const blocks = parseMarkdown('> 第一行\n> 第二行');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'quote');
  assert.equal(inlineText((blocks[0] as Extract<MdBlock, { type: 'quote' }>).inlines), '第一行\n第二行');
});

test('parseMarkdown：表格解析出 headers/rows，分隔行不落数据', () => {
  const blocks = parseMarkdown('| 环境 | 副本 |\n| --- | --- |\n| 生产 | 3 |\n| 测试 | 2 |');
  assert.equal(blocks.length, 1);
  const table = blocks[0] as Extract<MdBlock, { type: 'table' }>;
  assert.deepEqual(table.headers.map(inlineText), ['环境', '副本']);
  assert.deepEqual(table.rows.map((r) => r.map(inlineText)), [['生产', '3'], ['测试', '2']]);
});

test('parseMarkdown：分割线 hr', () => {
  assert.deepEqual(parseMarkdown('---'), [{ type: 'hr' }]);
  assert.deepEqual(parseMarkdown('***'), [{ type: 'hr' }]);
  assert.deepEqual(parseMarkdown('___'), [{ type: 'hr' }]);
});

test('parseMarkdown：段落合并连续普通行，空行分隔块', () => {
  const blocks = parseMarkdown('第一段甲\n第一段乙\n\n第二段');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(inlineText((blocks[0] as Extract<MdBlock, { type: 'paragraph' }>).inlines), '第一段甲\n第一段乙');
});

test('parseInline：bold/italic/code/strike 及嵌套', () => {
  const nodes = parseInline('**加粗** *斜体* `code` ~~删除~~');
  assert.deepEqual(nodes, [
    { kind: 'bold', children: [{ kind: 'text', text: '加粗' }] },
    { kind: 'text', text: ' ' },
    { kind: 'italic', children: [{ kind: 'text', text: '斜体' }] },
    { kind: 'text', text: ' ' },
    { kind: 'code', text: 'code' },
    { kind: 'text', text: ' ' },
    { kind: 'strike', children: [{ kind: 'text', text: '删除' }] },
  ]);
});

test('parseInline：未闭合标记按字面输出，不吞字', () => {
  const nodes = parseInline('**未闭合 *斜');
  assert.equal(inlineText(nodes), '**未闭合 *斜');
});

test('parseInline：code 内不嵌套解析其它标记', () => {
  const nodes = parseInline('`**不是粗体**`');
  assert.deepEqual(nodes, [{ kind: 'code', text: '**不是粗体**' }]);
});

test('inlineText：递归拼纯文本', () => {
  const inlines: MdInline[] = [
    { kind: 'bold', children: [{ kind: 'text', text: '加' }, { kind: 'code', text: '粗' }] },
    { kind: 'text', text: '尾' },
  ];
  assert.equal(inlineText(inlines), '加粗尾');
});

test('alignTable：CJK 宽度对齐，表头/分隔线/数据行齐全', () => {
  const out = alignTable(['环境', '副本'], [['生产', '3'], ['测试', '2']], 100);
  assert.equal(out.length, 4);
  assert.match(out[0], /环境/);
  assert.match(out[0], /副本/);
  assert.match(out[1], /-/);
  assert.match(out[2], /生产/);
  assert.match(out[3], /测试/);
});

test('alignTable：列对齐（CJK 记 2 宽）', () => {
  const out = alignTable(['环境', '副本'], [['生产', '3'], ['测试', '2']], 100);
  // 列宽按「环境/生产/测试」max=2、副本列 max=2（「副本」宽 4，数据「3/2」宽 1，故补齐到 4）
  const data = out[2];
  assert.equal(data, '| 生产 | 3    |');
});

test('alignTable：超宽（列数×2 > columns）返回空数组', () => {
  const out = alignTable(['a', 'b', 'c'], [['1', '2', '3']], 5);
  assert.deepEqual(out, []);
});

test('alignTable：列缺失按空串补齐', () => {
  const out = alignTable(['a', 'b'], [['1']], 100);
  assert.equal(out.length, 3);
  assert.equal(out[2], '| 1 |   |');
});
