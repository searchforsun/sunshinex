import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { FILE_PATH_LINE, IMAGE_PLACEMENT_LINE, stableSegmentOf } from './shared';

test('稳定段含图片位置行（紧随文件引用行，末行）：正文图片统一置于回复末尾', () => {
  const lines = stableSegmentOf({ contextRoot: '/x' }).split('\n');
  assert.equal(lines.indexOf(IMAGE_PLACEMENT_LINE), lines.indexOf(FILE_PATH_LINE) + 1);
  assert.equal(lines.at(-1), IMAGE_PLACEMENT_LINE);
  assert.match(IMAGE_PLACEMENT_LINE, /at the end of the reply/);
});
