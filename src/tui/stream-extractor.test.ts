import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAIN_LIMIT, ReplyStreamExtractor } from './stream-extractor';

/** 喂入若干片段，返回拼接后的提取文本与提取器终态 */
function collect(chunks: string[]): { out: string; ex: ReplyStreamExtractor } {
  let out = '';
  const ex = new ReplyStreamExtractor((t) => { out += t; });
  for (const c of chunks) ex.feed(c);
  return { out, ex };
}

test('提取器：reply 字段逐段透出，协议骨架不上屏', () => {
  const { out, ex } = collect(['{"done":true,', '"reply":"你好', '世界"}']);
  assert.equal(out, '你好世界');
  assert.equal(ex.currentMode, 'settled');
});

test('提取器：转义序列还原（\\n \\t \\" \\\\ \\/ \\uXXXX 跨块）', () => {
  const { out } = collect(['{"reply":"a\\nb\\t', 'c\\"d\\\\e\\/f\\u4f6', '0g"}']);
  assert.equal(out, 'a\nb\tc"d\\e/f你g');
});

test('提取器：键名跨块分裂仍可识别', () => {
  const { out } = collect(['{"done":true,"rep', 'ly":"ok"}']);
  assert.equal(out, 'ok');
});

test('提取器：tool 键先现则忽略整回合（输入内出现 reply 字样也不误提取）', () => {
  const { out, ex } = collect(['{"tool":"write","input":{"path":"a.txt","content":"see \\"reply\\" 字样"},"done":false}']);
  assert.equal(out, '');
  assert.equal(ex.currentMode, 'ignore');
});

test('提取器：首个非空白非 { 视为裸文本，原文透传（含前导空白）', () => {
  const { out, ex } = collect(['  这是裸文本\n', '第二行']);
  assert.equal(out, '  这是裸文本\n第二行');
  assert.equal(ex.currentMode, 'plain');
});

test('提取器：reset 复位后提取下一回合', () => {
  let out = '';
  const ex = new ReplyStreamExtractor((t) => { out += t; });
  ex.feed('{"done":true,"reply":"第一"}');
  assert.equal(out, '第一');
  ex.reset();
  ex.feed('{"tool":"read","input":{"path":"a"}}');
  assert.equal(out, '第一');
  ex.reset();
  ex.feed('{"reply":"第二"}');
  assert.equal(out, '第一第二');
});

test('提取器：转义引号不触发收束（\\" 不终止 reply）', () => {
  const { out, ex } = collect(['{"reply":"say \\"hi\\" now"}']);
  assert.equal(out, 'say "hi" now');
  assert.equal(ex.currentMode, 'settled');
});

test('提取器：协议违规输出超长即截断（不整段灌屏）', () => {
  let out = '';
  const ex = new ReplyStreamExtractor((t) => { out += t; });
  ex.feed('x'.repeat(PLAIN_LIMIT + 500));
  assert.equal(ex.currentMode, 'plain');
  assert.ok(out.startsWith('xxxx'), '前段应透出');
  assert.ok(out.length < PLAIN_LIMIT + 500, '超长应截断');
  assert.ok(out.includes('已截断'), '应给出截断提示');
});

test('提取器：协议违规输出未超限则全文透传', () => {
  let out = '';
  const ex = new ReplyStreamExtractor((t) => { out += t; });
  ex.feed('短文本');
  assert.equal(out, '短文本');
  assert.ok(!out.includes('已截断'));
});
