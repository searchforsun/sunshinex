import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_ENVELOPE_FORMAT, resolveStructuredFormat } from './action-schema';

test('resolveStructuredFormat：未设/空/非法值缺省 json_schema 信封格式', () => {
  assert.equal(resolveStructuredFormat(undefined), ACTION_ENVELOPE_FORMAT);
  assert.equal(resolveStructuredFormat(''), ACTION_ENVELOPE_FORMAT);
  assert.equal(resolveStructuredFormat('yaml'), ACTION_ENVELOPE_FORMAT, '非法值静默回退缺省（对齐 CONTEXT_WINDOW 先例）');
});

test('resolveStructuredFormat：json 档仅约束合法 JSON（大小写与空白容忍）', () => {
  assert.deepEqual(resolveStructuredFormat('json'), { type: 'json_object' });
  assert.deepEqual(resolveStructuredFormat(' JSON '), { type: 'json_object' });
});

test('resolveStructuredFormat：off 显式关闭（请求体不带 response_format）', () => {
  assert.equal(resolveStructuredFormat('off'), undefined);
  assert.equal(resolveStructuredFormat('OFF'), undefined);
});

test('ACTION_ENVELOPE_FORMAT：oneOf 三形态与协议行镜像（单工具/并行/完成）', () => {
  assert.equal(ACTION_ENVELOPE_FORMAT.type, 'json_schema');
  const schema = ACTION_ENVELOPE_FORMAT.json_schema!.schema as { oneOf: Array<{ required: string[] }> };
  assert.equal(schema.oneOf.length, 3);
  assert.deepEqual(schema.oneOf[0].required, ['tool']);
  assert.deepEqual(schema.oneOf[1].required, ['tools']);
  assert.deepEqual(schema.oneOf[2].required, ['done']);
  assert.equal(ACTION_ENVELOPE_FORMAT.json_schema!.strict, false, 'input 为任意入参对象，schema 定位为引导而非强约束');
});
