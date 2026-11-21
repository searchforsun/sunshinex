import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelsKey, channelSecretEnv, bindingKey } from './model';

test('parseChannelsKey: 合法条目收口、非法条目 warning 跳过', () => {
  const r = parseChannelsKey([
    { id: 'feishu-main', platform: 'feishu', enabled: true, root: 'D:/w', mode: 'read-only', allow: { kind: 'first-user' } },
    { id: 't1', platform: 'telegram', enabled: false, root: 'D:/w', mode: 'acceptEdits', model: 'x/y', allow: { kind: 'list', userIds: ['u1'] } },
    { id: '', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', allow: { kind: 'all' } }, // id 空 → warning
    { platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', allow: { kind: 'all' } },        // 缺 id → warning
    { id: 'bad', platform: 'qq', enabled: true, root: 'D:/w', mode: 'read-only', allow: { kind: 'all' } },   // 平台未知 → warning
  ]);
  assert.equal(r.value.length, 2);
  assert.equal(r.warnings.length, 3);
  assert.equal(r.value[1]!.model, 'x/y');
});

test('parseChannelsKey: 非 root 非 object → 空值 + 单条 warning', () => {
  const r = parseChannelsKey('nope');
  assert.deepEqual(r.value, []);
  assert.equal(r.warnings.length, 1);
});

test('channelSecretEnv: 非字母数字折叠单下划线', () => {
  assert.equal(channelSecretEnv('feishu-main'), 'SUNSHINEX_CHANNEL_SECRET_FEISHU_MAIN');
  assert.equal(bindingKey('feishu-main', 'oc_yyy'), 'feishu-main:oc_yyy');
});
