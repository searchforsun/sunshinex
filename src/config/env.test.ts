import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadEnv, parseDotenv } from './env';

test('parseDotenv：KEY=VALUE / 引号 / 注释 / 非法行', () => {
  const kv = parseDotenv([
    '# 注释行',
    '',
    'A=1',
    'B="quoted value"',
    "C='single'",
    'D=a=b',
    'no_equal_sign',
    '1bad=x',
    '  E = spaced  ',
  ].join('\n'));
  assert.deepEqual(kv, { A: '1', B: 'quoted value', C: 'single', D: 'a=b', E: 'spaced' });
});

test('loadEnv：装载缺失键且不覆盖已导出环境变量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  fs.writeFileSync(path.join(dir, '.env'), 'DOTENV_T1=from-file\nDOTENV_T2=also-file\n');
  process.env.DOTENV_T1 = 'already-set';
  try {
    const n = loadEnv(dir);
    assert.equal(process.env.DOTENV_T1, 'already-set');
    assert.equal(process.env.DOTENV_T2, 'also-file');
    assert.ok(n >= 1);
  } finally {
    delete process.env.DOTENV_T1;
    delete process.env.DOTENV_T2;
  }
});

test('loadEnv：.env 缺失时返回 0 且不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-empty-'));
  assert.equal(loadEnv(dir), 0);
});
