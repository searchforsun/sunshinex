import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from './chunk';

test('chunkMarkdown：空/纯空白文本返回空数组', () => {
  assert.deepEqual(chunkMarkdown(''), []);
  assert.deepEqual(chunkMarkdown('  \n\n \t '), []);
});

test('chunkMarkdown：标题开启新块，节内段落聚合', () => {
  const md = ['# 标题一', '', '段落甲。', '', '段落乙。', '', '# 标题二', '', '段落丙。', ''].join('\n');
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].startsWith('# 标题一'));
  assert.ok(chunks[0].includes('段落甲。') && chunks[0].includes('段落乙。'));
  assert.ok(chunks[1].startsWith('# 标题二'));
  assert.ok(chunks[1].includes('段落丙。'));
  assert.ok(!chunks[0].includes('段落丙。'), '标题一节不应混入标题二内容');
});

test('chunkMarkdown：所有块 ≤1200 字符（单段超长多块切分）', () => {
  const md = '长段落。'.repeat(600); // 2400 字符无标题单段
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 1200, `块长 ${c.length} 超限`);
});

test('chunkMarkdown：硬切带 100 字符重叠（后块开头 = 前块结尾）', () => {
  const body = Array.from({ length: 100 }, (_, i) => String(i).padStart(3, '0') + '-abcdefghi').join('');
  assert.equal(body.length, 1300); // 单段 1300 字符（每段 3+1+9），无分隔
  const chunks = chunkMarkdown(body);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 1200);
  assert.equal(chunks[1].length, 200);
  assert.equal(chunks[1].slice(0, 100), chunks[0].slice(-100), '重叠区内容应一致');
});

test('chunkMarkdown：混合文档整体不变量（标题/短段/超长节并存）', () => {
  const md = ['# 设计', '', '短段落。', '', '# 实现', '', 'x'.repeat(2000), '', '# 收尾', '', '尾段。'].join('\n');
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.length >= 4);
  for (const c of chunks) assert.ok(c.length <= 1200, `块长 ${c.length} 超限`);
  assert.ok(chunks.some((c) => c.startsWith('# 收尾')));
});
