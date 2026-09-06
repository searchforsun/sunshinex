import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextWindow, estimateTokens } from './window';
import { ContextItem } from '../../types';

test('estimate 按真实 token 近似：CJK×1 + 其余÷4', () => {
  const w = new ContextWindow();
  assert.equal(estimateTokens('abcd'), 1); // ceil(4/4)
  assert.equal(estimateTokens('你好'), 2); // CJK 逐字
  assert.equal(estimateTokens('ab你好'), 3); // 2 + ceil(2/4)
  assert.equal(estimateTokens(''), 0);
  const est = w.estimate([{ kind: 'instruction', content: 'abcd' }]);
  assert.equal(est.used, 1, '无 kind 权重：4 ASCII → 1');
  assert.equal(est.items.length, 1);
  assert.ok(est.items[0].id.length > 0);
});

test('estimate 无 kind 权重：同内容异 kind 同值', () => {
  const w = new ContextWindow();
  const a = w.estimate([{ kind: 'history', content: '同长内容' }]);
  const b = w.estimate([{ kind: 'system', content: '同长内容' }]);
  assert.equal(a.used, b.used);
});

test('estimate 返回逐项 chunk id（可重现）', () => {
  const w = new ContextWindow();
  const a = w.estimate([{ kind: 'history', content: 'hello' }]);
  const b = w.estimate([{ kind: 'history', content: 'hello' }]);
  assert.equal(a.items[0].id, b.items[0].id);
});

test('used 超过 total 时 shouldCompact 为 true', () => {
  const w = new ContextWindow();
  assert.equal(w.shouldCompact({ total: 100, used: 101, reserve: 10 }), true);
  assert.equal(w.shouldCompact({ total: 100, used: 50, reserve: 10 }), false);
});

test('compact 产出结构化 chunk 并过滤 priority=0', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [
    { kind: 'history', content: '用户说你好' },
    { kind: 'history', content: '重复的冗余日志 x'.repeat(50) },
  ];
  const chunks = await w.compact(items);
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((c) => c.priority > 0));
  assert.ok(chunks.every((c) => c.id.length > 0));
});

test('verifyChecksum 三态：first 注册 / replay 重放 / new 新一轮', () => {
  const w = new ContextWindow();
  const a = [{ id: 'a', summary: 'x', type: 'history', priority: 1 }];
  const b = [{ id: 'b', summary: 'y', type: 'history', priority: 1 }];
  assert.equal(w.verifyChecksum(a), 'first');
  assert.equal(w.verifyChecksum(a), 'replay');
  assert.equal(w.verifyChecksum(b), 'new');
  assert.equal(w.verifyChecksum(b), 'replay');
  assert.equal(w.verifyChecksum(a), 'new');
});

test('checksum 返回基线前 16 位，未注册时为 null', () => {
  const w = new ContextWindow();
  assert.equal(w.checksum(), null);
  w.verifyChecksum([{ id: 'a', summary: 'x', type: 'history', priority: 1 }]);
  assert.match(w.checksum() ?? '', /^[0-9a-f]{16}$/);
});

test('summarize/reinject 产出带 checksum 标记的压缩摘要条目', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [{ kind: 'instruction', content: '## 规则一\n重要背景内容' }];
  const chunks = await w.compact(items);
  const out = w.reinject(chunks);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'history');
  assert.match(out[0].content, /^\[压缩摘要 checksum=[0-9a-f]{16}\]/);
  assert.ok(out[0].content.includes('重要背景内容'));
});

test('compact 摘要可重现（相同输入产生相同 chunk id）', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [{ kind: 'instruction', content: '## 规则一\n内容' }];
  const a = await w.compact(items);
  const b = await w.compact(items);
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
});

test('compact 摘要预算化：超限按丢弃序丢块，白名单 kind 保留', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [
    { kind: 'system', content: '## 系统规则\n系统级锚点内容' },
    { kind: 'history', content: '## 旧块A\n' + 'A'.repeat(1200) },
    { kind: 'history', content: '## 旧块B\n' + 'B'.repeat(1200) },
  ];
  const chunks = await w.compact(items, { summaryTokenBudget: 400 });
  assert.equal(chunks.length, 2, '应恰好丢弃一个 history 块');
  assert.ok(chunks.some((c) => c.type === 'system'), '白名单 system 块保留');
  const joined = chunks.map((c) => c.summary).join('\n');
  assert.ok(joined.includes('旧块B'), '位置最旧的 A 先被丢弃，B 保留');
  assert.ok(!joined.includes('AAAA'), '被丢弃块不出现');
});

test('compact 摘要预算化：未传 summaryTokenBudget 行为不变', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [
    { kind: 'history', content: '## 块一\n' + 'x'.repeat(1200) },
    { kind: 'history', content: '## 块二\n' + 'y'.repeat(1200) },
  ];
  const a = await w.compact(items);
  const b = await w.compact(items, { force: true });
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
  assert.equal(a.length, 2);
});

test('compact 摘要预算化：丢尽可丢块仍超限 → 确定性均匀截断', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [
    { kind: 'system', content: '## 系统\n' + 'S'.repeat(1200) },
    { kind: 'history', content: '## 历史\n' + 'H'.repeat(1200) },
  ];
  const chunks = await w.compact(items, { summaryTokenBudget: 100 });
  const t = chunks.reduce((s, c) => s + estimateTokens(c.summary), 0);
  assert.ok(t <= 100, `截断后 Σ token ${t} 应 ≤ 100`);
  assert.ok(chunks.some((c) => c.type === 'system'), 'system 块可截断但不丢弃');
  const again = await w.compact(items, { summaryTokenBudget: 100 });
  assert.deepEqual(chunks.map((c) => c.summary), again.map((c) => c.summary), '同输入确定性一致');
});
