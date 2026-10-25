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
  // 非 user 行不挂图片（tool 条 images 字段即使误落行也被忽略）
  const tool = reduceSegRows([{ t: 'seg', kind: 'tool', md: '', ts: 1, seq: 2, name: 'exec', images: [PNG] }]);
  assert.equal(tool[0]!.images, undefined);
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
