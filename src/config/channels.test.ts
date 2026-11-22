import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadChannels, channelChatDomainDir, channelChatWorkspaceRoot } from './channels';
import { channelsContainerDir, resolveDataDir } from './data-dir';

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

test('loadChannels: 条目 secret 字段随装载带出（密钥内联可回显，2026-11-22 用户裁定）', () => {
  const file = writeGlobal([
    { id: 'tg1', platform: 'telegram', enabled: true, root: '/w', mode: 'read-only', secret: 'tok-inline', allow: { kind: 'first-user' } },
  ]);
  const r = loadChannels(file);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.value[0]!.secret, 'tok-inline', 'GET /settings/channels 回显面的数据基座：装载零剥离');
});

test('聊天专属域: workspace/data 平级 + resolveDataDir 分支', () => {
  // 钉环境:容器指临时区(domain 落临时区、不写真实 HOME);SUNSHINEX_DATA_DIR 显式覆盖会短路
  // channels 分支(其优先级最高),必须确保未设——存/删 + try/finally 还原,不污染其他用例
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-dom-'));
  const prevChannels = process.env.SUNSHINEX_CHANNELS_DIR;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  delete process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_CHANNELS_DIR = tmp;
  try {
    assert.equal(channelsContainerDir(), path.resolve(tmp)); // 覆盖生效(容器落临时区)
    const domain = channelChatDomainDir('feishu-main', 'oc_yyy');
    const ws = channelChatWorkspaceRoot('feishu-main', 'oc_yyy');
    assert.equal(ws, path.join(domain, 'workspace')); // 平级:ws 与 data 同为域下两目录
    assert.equal(resolveDataDir(ws), path.join(domain, 'data')); // 容器内 root → 域/data
    assert.ok(!resolveDataDir(ws).startsWith(ws + path.sep), 'data 不得嵌在工作区内');
    assert.ok(fs.existsSync(ws)); // 首调即铸造
    assert.ok(fs.existsSync(domain)); // domain 目录本体亦铸造(mkdir 幂等)
  } finally {
    if (prevChannels === undefined) delete process.env.SUNSHINEX_CHANNELS_DIR;else process.env.SUNSHINEX_CHANNELS_DIR = prevChannels;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
