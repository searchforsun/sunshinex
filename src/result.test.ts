import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail } from './result';

test('ok() 返回 ok 结果并携带 value', () => {
  const r = ok(42);
  assert.equal(r.ok, true);
  assert.equal(r.value, 42);
});

test('fail() 返回 error 结果并携带 code/message', () => {
  const r = fail<number>('IO_ERROR', '磁盘写入失败');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'IO_ERROR');
    assert.equal(r.error.message, '磁盘写入失败');
  }
});
