import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadChannels, resolveChannelSecret } from './channels';

function writeGlobal(channels: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-cfg-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, channels }), 'utf8');
  return file;
}

test('loadChannels: 读全局档 channels 键 + 警告聚合', () => {
  const file = writeGlobal([
    { id: 'm1', platform: 'mock', enabled: false, root: '/w', mode: 'read-only', allow: { kind: 'all' } },
    { id: 'b1', platform: 'carrier-pigeon' }, // 畸形条目:platform 非法 → warning 聚合跳过,不致命
  ]);
  const r = loadChannels(file);
  assert.equal(r.value.length, 1); // 合法条目仍收进 value
  assert.equal(r.value[0].id, 'm1');
  assert.ok(r.warnings.length > 0); // 非法条目走 warning 聚合而非整键致命
  assert.match(r.warnings[0], /b1/);
  assert.deepEqual(loadChannels(path.join(path.dirname(file), 'missing.json')).value, []); // 缺档=空
});

test('resolveChannelSecret: env 槽名解析', () => {
  process.env.SUNSHINEX_CHANNEL_SECRET_T1 = 'sec';
  try {
    assert.equal(resolveChannelSecret('t1'), 'sec');
  } finally {
    delete process.env.SUNSHINEX_CHANNEL_SECRET_T1; // 断言失败也不泄漏 env 改动
  }
});
