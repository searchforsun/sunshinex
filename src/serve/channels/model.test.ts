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

test('parseChannelsKey: name 合法收口（trim 落字段；空串=缺席零告警）', () => {
  const r = parseChannelsKey([
    { id: 'tg1', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', name: '  我的TG  ', allow: { kind: 'first-user' } },
    { id: 'tg2', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', name: '   ', allow: { kind: 'first-user' } },
    { id: 'tg3', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', allow: { kind: 'first-user' } },
  ]);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.value[0]!.name, '我的TG');
  assert.equal(r.value[1]!.name, undefined);
  assert.equal(r.value[2]!.name, undefined);
});

test('parseChannelsKey: name 非串/超 80 字 → warning 跳过该字段不致命', () => {
  const r = parseChannelsKey([
    { id: 'tg1', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', name: 'x'.repeat(81), allow: { kind: 'first-user' } },
    { id: 'tg2', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', name: 42, allow: { kind: 'first-user' } },
  ]);
  assert.equal(r.value.length, 2, '条目本身不受 name 坏值牵连');
  assert.equal(r.warnings.length, 2);
  assert.equal(r.value[0]!.name, undefined);
  assert.equal(r.value[1]!.name, undefined);
});

test('channelSecretEnv: 非字母数字折叠单下划线', () => {
  assert.equal(channelSecretEnv('feishu-main'), 'SUNSHINEX_CHANNEL_SECRET_FEISHU_MAIN');
  assert.equal(bindingKey('feishu-main', 'oc_yyy'), 'feishu-main:oc_yyy');
});
