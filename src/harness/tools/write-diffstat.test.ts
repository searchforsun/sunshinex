import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeDiffStat } from './write-diffstat';

/** G14 写工具 diff stat 钉：新文件全计增/增删对称/无变化全零/大文件护栏回 undefined */
test('新文件：undefined pre-image → 全行计增', () => {
  assert.equal(writeDiffStat(undefined, 'a\nb\n'), '+2 -0');
});

test('修改：增删对称（LCS 语义）', () => {
  assert.equal(writeDiffStat('a\nb\nc\n', 'a\nx\nc\nd\n'), '+2 -1');
});

test('无变化：+0 -0', () => {
  assert.equal(writeDiffStat('a\nb\n', 'a\nb\n'), '+0 -0');
});

test('尾随换行不产空行', () => {
  assert.equal(writeDiffStat('a', 'a\n'), '+0 -0');
});

test('超护栏（4001×4001）回 undefined', () => {
  const big = 'x\n'.repeat(4001);
  assert.equal(writeDiffStat(big, big), undefined);
});
