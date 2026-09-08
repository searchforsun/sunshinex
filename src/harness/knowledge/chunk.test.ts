import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from './chunk';

/** 计算前块尾部与后块头部的最长公共重叠长度（验证 ~100 重叠契约） */
function maxOverlap(a: string, b: string): number {
  const cap = Math.min(a.length, b.length, 300);
  for (let len = cap; len > 0; len--) {
    if (a.endsWith(b.slice(0, len))) return len;
  }
  return 0;
}

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

test('chunkMarkdown：超长段落按句子边界硬切，每块 ≤1200 且句子完整', () => {
  const md = Array.from({ length: 200 }, (_, i) => `这是第${i + 1}个测试句子，用于验证分块行为。`).join('');
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= 1200, `块长 ${c.length} 超限`);
    assert.ok(c.endsWith('。'), '切块应落在句子边界');
  }
  const joined = chunks.join('\n');
  for (let i = 1; i <= 200; i++) {
    assert.ok(joined.includes(`这是第${i}个测试句子`), `缺少第${i}句`);
  }
});

test('chunkMarkdown：无句子边界文本按 1200 上限硬切，后块带 100 字符重叠', () => {
  const body = Array.from({ length: 100 }, (_, i) => String(i).padStart(3, '0') + '-abcdefghi').join('');
  assert.equal(body.length, 1300); // 单段 1300 字符（每段 3+1+9），无分隔
  const chunks = chunkMarkdown(body);
  assert.equal(chunks.length, 2);
  for (const c of chunks) assert.ok(c.length <= 1200, `块长 ${c.length} 超限`);
  assert.equal(chunks[1].slice(0, 100), chunks[0].slice(-100), '重叠区内容应一致');
  assert.ok(maxOverlap(chunks[0], chunks[1]) >= 100, '重叠应达到 ~100 字符');
});

test('chunkMarkdown：混合文档整体不变量（标题/短段/超长节并存）', () => {
  const md = ['# 设计', '', '短段落。', '', '# 实现', '', 'x'.repeat(2000), '', '# 收尾', '', '尾段。'].join('\n');
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.length >= 4);
  for (const c of chunks) assert.ok(c.length <= 1200, `块长 ${c.length} 超限`);
  assert.ok(chunks.some((c) => c.startsWith('# 收尾')));
});
