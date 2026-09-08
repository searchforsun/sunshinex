import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSunshinex, loadSunshinex } from './config';

test('parseSunshinex：#/##/### 标题分区，正文按行原样收集（含列表前缀，符号剥离属 loadSunshinex 规则提炼），跳过空行', () => {
  const doc = parseSunshinex([
    '# 项目名称',
    'sunshinex',
    '',
    '## 编码规范',
    '- strict 开启',
    '* 禁止 any',
    '### 架构原则',
    '单一主链',
  ].join('\n'));
  assert.deepEqual(doc.sections['项目名称'], ['sunshinex']);
  assert.deepEqual(doc.sections['编码规范'], ['- strict 开启', '* 禁止 any']);
  assert.deepEqual(doc.sections['架构原则'], ['单一主链']);
});

test('parseSunshinex：文件头正文归入 (preamble)，CRLF 容忍', () => {
  const doc = parseSunshinex('导语行\r\n\r\n## 规则\r\n- A');
  assert.deepEqual(doc.sections['(preamble)'], ['导语行']);
  assert.deepEqual(doc.sections['规则'], ['- A']);
});

test('loadSunshinex：缺失返回 null；规则/名称/架构原则提炼', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sun-'));
  try {
    assert.equal(loadSunshinex(dir), null);
    fs.writeFileSync(path.join(dir, 'SUNSHINE.md'), [
      '# 项目名称', 'demo-app', '',
      '## 编码规范', '- 严格模式', '',
      '## 架构原则', '- 单一数据流',
    ].join('\n'));
    const ctx = loadSunshinex(dir);
    assert.ok(ctx);
    assert.equal(ctx.name, 'demo-app');
    assert.deepEqual(ctx.rules, ['严格模式']);
    assert.deepEqual(ctx.architecture, ['- 单一数据流']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
