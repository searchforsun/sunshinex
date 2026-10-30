import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceSegRows, reduceSteerRows, kernelEventRows } from './seglog';
import type { KernelEvent } from './kernel';
import type { KernelEntry } from './entry';

/** seg/steer 行的图片附件面：user 条 images 随档原样落行、读面净化回落（非 data:image 串丢弃/坏形回落
 *  undefined）；steer 行 items 随行 images 同读面。行面字段不予信任是既有 seglog 纪律，此处钉图片载荷同纪律 */

const PNG = 'data:image/png;base64,aGVsbG8=';
const JPEG = 'data:image/jpeg;base64,aGVsbG8y';

function userEntry(images: string[] | undefined): KernelEntry {
  return { seq: 7, ts: 100, kind: 'user', md: '看图', ...(images !== undefined ? { images } : {}) };
}

test('kernelEventRows：user 条 images → seg 行 images 字段原样落档', () => {
  const rows = kernelEventRows({ t: 'seg-open', entry: userEntry([PNG, JPEG]), open: false });
  assert.equal(rows.length, 1);
  assert.deepEqual((rows[0] as { images?: string[] }).images, [PNG, JPEG]);
});

test('reduceSegRows：user seg 行 images 回读；坏形净化（非串/非 data: 前缀丢弃，空列回落 undefined）', () => {
  const good = reduceSegRows([{ t: 'seg', kind: 'user', md: '看图', ts: 100, seq: 7, images: [PNG, 'junk', 42] }]);
  assert.deepEqual(good[0]!.images, [PNG]);
  const none = reduceSegRows([{ t: 'seg', kind: 'user', md: 'x', ts: 1, seq: 1, images: ['not-image'] }]);
  assert.equal(none[0]!.images, undefined);
  const absent = reduceSegRows([{ t: 'seg', kind: 'user', md: 'x', ts: 1, seq: 1 }]);
  assert.equal(absent[0]!.images, undefined);
  // tool 行 images 随档(2026-10-31 截屏回显:工具结果图全 kind 通用,读侧净化同 user——
  // 旧「非 user 行忽略」门随投影层带图一并退役)
  const tool = reduceSegRows([{ t: 'seg', kind: 'tool', md: '', ts: 1, seq: 2, name: 'exec', images: [PNG, 'junk', 42] }]);
  assert.deepEqual(tool[0]!.images, [PNG]);
  const toolNone = reduceSegRows([{ t: 'seg', kind: 'tool', md: '', ts: 1, seq: 3, name: 'exec', images: ['not-image'] }]);
  assert.equal(toolNone[0]!.images, undefined);
  // seg-update 回填行 images 合并(重载后 result 后到面同样带图)
  const backfill = reduceSegRows([
    { t: 'seg', kind: 'tool', md: '', ts: 1, seq: 4, name: 'screenshot' },
    { t: 'seg-update', seq: 4, ts: 2, result: { text: '[image]', ok: true }, images: [PNG] },
  ]);
  assert.deepEqual(backfill[0]!.images, [PNG]);
});

test('steer 行 images 面读写往返：写面随 items 落行、读面净化回种', () => {
  const ev: KernelEvent = { t: 'steer', items: [{ seq: 0, text: '带图的穿插', front: true, images: [PNG] }, { seq: 1, text: '普通', front: false }] };
  const rows = kernelEventRows(ev);
  const row = rows[0] as { t: string; items: Array<{ images?: string[] }> };
  assert.deepEqual(row.items[0]!.images, [PNG]);
  assert.equal(row.items[1]!.images, undefined);
  const restored = reduceSteerRows([{ t: 'steer', items: [{ seq: 0, text: '带图的穿插', front: true, images: [PNG, 'bad'] }, { seq: 1, text: '普通', front: false }] }]);
  assert.deepEqual(restored[0]!.images, [PNG]);
  assert.equal(restored[1]!.images, undefined);
});
