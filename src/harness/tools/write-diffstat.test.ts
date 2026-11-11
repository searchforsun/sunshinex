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

test('超护栏(中段 4001×4001)回 undefined;同文大文件裁剪后 +0 -0(2026-11-11 公共前后缀裁剪)', () => {
  // 同文:前后缀裁剪吃掉全部行 → 中段空 → 零差(不再误触护栏)
  const same = 'x\n'.repeat(4001);
  assert.equal(writeDiffStat(same, same), '+0 -0');
  // 全行相异:无公共前后缀,中段 4001×4001 > 16M 格 → 宁缺勿拖
  const old = 'x\n'.repeat(4001);
  const neu = 'y\n'.repeat(4001);
  assert.equal(writeDiffStat(old, neu), undefined);
});

test('大文件小改动:公共前后缀裁剪后正常出数(2026-11-11 根修——几千行文件改 2 行不再 +0-0/无 ±)', () => {
  const head = 'l\n'.repeat(3000);
  const tail = 't\n'.repeat(3000);
  const oldText = `${head}old line\n${tail}`;
  const newText = `${head}new a\nnew b\n${tail}`;
  assert.equal(writeDiffStat(oldText, newText), '+2 -1');
});

test('CRLF→LF 归一不产幻影 ±(2026-11-12 用户裁定「+3 -1 应为 +2 -0」根根因)', () => {
  // edit 重写文件把 CRLF 行归一成 LF:语义上未动的行不再计 -1+1
  const oldText = '<!-- header -->\r\n<html>\r\n';
  const newText = '<!-- header -->\n<!-- 编辑测试1 -->\n<html>\n';
  assert.equal(writeDiffStat(oldText, newText), '+1 -0');
});
