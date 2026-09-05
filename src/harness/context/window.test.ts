import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextWindow } from './window';
import { ContextItem } from '../../types';

test('estimate 按 kind 加权估算 token', () => {
  const w = new ContextWindow();
  const est = w.estimate([{ kind: 'instruction', content: 'abcd' }]);
  assert.equal(est.used, 2); // ceil(4 字符 × 1.2 / 4) = ceil(1.2) = 2
  assert.equal(est.items.length, 1);
  assert.equal(est.items[0].weight, 1.2);
  assert.ok(est.items[0].id.length > 0);
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
