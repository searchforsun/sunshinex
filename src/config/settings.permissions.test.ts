import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSettingsFile, SEMANTIC_KEYS, flattenSettings } from './settings';

test('parseSettingsFile 保留 permissions 结构化原值，flattenSettings 零警告', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settings-perm-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    permissions: { deny: ['Bash(rm*)'], additionalDirs: ['../lib'] },
  }));
  const doc = parseSettingsFile(file);
  assert.notEqual(doc, null);
  assert.deepEqual(doc!.permissions, { deny: ['Bash(rm*)'], additionalDirs: ['../lib'] });
  const flat = flattenSettings(doc!);
  assert.equal(flat.warnings.some((w: string) => w.includes('permissions')), false, 'permissions 不得产生未知键警告');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SEMANTIC_KEYS 登记三个边界语义键', () => {
  assert.equal(SEMANTIC_KEYS.readFence, 'SUNSHINEX_READ_FENCE');
  assert.equal(SEMANTIC_KEYS.sandbox, 'SUNSHINEX_SANDBOX');
  assert.equal(SEMANTIC_KEYS.isolation, 'SUNSHINEX_ISOLATION');
});
