import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, flagList } from './index';

test('parseArgs：--add-dir 可重复收集为数组，其余 flag 语义不变', () => {
  const args = parseArgs(['run', '.', '--add-dir=/a', '--add-dir=/b', '--mode=manual', '--yes']);
  assert.deepEqual(flagList(args.flags, 'add-dir'), ['/a', '/b']);
  assert.equal(args.flags.mode, 'manual');
  assert.equal(args.flags.yes, true);
});

test('flagList：单值/数组/缺省三态归一', () => {
  assert.deepEqual(flagList({ 'add-dir': '/x' }, 'add-dir'), ['/x']);
  assert.deepEqual(flagList({ 'add-dir': ['/x', '/y'] }, 'add-dir'), ['/x', '/y']);
  assert.deepEqual(flagList({}, 'add-dir'), []);
  assert.deepEqual(flagList({ 'add-dir': '' }, 'add-dir'), []);
});
