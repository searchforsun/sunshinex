import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeliverablePath } from './types';

/** 轮次产物面(2026-11-12 spec):白名单单点 + sanitize + 落档/重放往返(Task 2 追加) */

test('isDeliverablePath:白名单命中(大小写不敏感/反斜杠/嵌套目录),代码与点开头顶格不认', () => {
  assert.equal(isDeliverablePath('docs/TECH-DEBT-LOG.md'), true);
  assert.equal(isDeliverablePath('报告.MD'), true);
  assert.equal(isDeliverablePath('mocks\\ui\\logo.svg'), true);
  assert.equal(isDeliverablePath('docs/data.Export.JSON'), true);
  assert.equal(isDeliverablePath('src/index.ts'), false);
  assert.equal(isDeliverablePath('src/app.py'), false);
  assert.equal(isDeliverablePath('README'), false);
  assert.equal(isDeliverablePath('dir/.hidden'), false);
});
