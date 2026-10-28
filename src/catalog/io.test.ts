// src/catalog/io.test.ts
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { readJsoncDoc, writeJsonAtomic, CatalogWriteError } from './io';

test('readJsoncDoc: 缺文件 = exists false 空 doc 不算错', () => {
  const r = readJsoncDoc(join(mkdtempSync(join(tmpdir(), 'cat')), 'nope.json'));
  assert.equal(r.exists, false); assert.deepEqual(r.doc, {}); assert.equal(r.hasComments, false);
});
test('readJsoncDoc: JSONC 注释识别', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cat'));
  const f = join(dir, 'mcp.json'); writeFileSync(f, '{\n // 注释\n "a": 1 }\n');
  const r = readJsoncDoc(f); assert.equal(r.hasComments, true); assert.deepEqual(r.doc, { a: 1 });
});
test('writeJsonAtomic: 落盘原子且内容一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cat'));
  const f = join(dir, 'x.json'); writeJsonAtomic(f, '{"a":2}\n');
  assert.equal(readFileSync(f, 'utf8'), '{"a":2}\n');
});
test('CatalogWriteError 携带 code', () => {
  const e = new CatalogWriteError('COMMENTS', 'x'); assert.equal(e.code, 'COMMENTS');
});
