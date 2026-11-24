import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelsKey, bindingKey } from './model';

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

// 密钥内联（2026-11-22 用户裁定：推翻 D6 env 分组口径——密钥进条目 secret 字段、可回显；
// env 槽 SUNSHINEX_CHANNEL_SECRET_<ID> 退役）
test('parseChannelsKey: secret 合法收口（trim 落字段；空串=缺席零告警）', () => {
  const r = parseChannelsKey([
    { id: 'tg1', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', secret: '  tok-abc  ', allow: { kind: 'first-user' } },
    { id: 'tg2', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', secret: '   ', allow: { kind: 'first-user' } },
    { id: 'tg3', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', allow: { kind: 'first-user' } },
  ]);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.value[0]!.secret, 'tok-abc');
  assert.equal(r.value[1]!.secret, undefined, '空串=缺席');
  assert.equal(r.value[2]!.secret, undefined);
});

test('parseChannelsKey: secret 非串/超 2000 字 → warning 跳过该字段不致命', () => {
  const r = parseChannelsKey([
    { id: 'tg1', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', secret: 'x'.repeat(2001), allow: { kind: 'first-user' } },
    { id: 'tg2', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', secret: 42, allow: { kind: 'first-user' } },
  ]);
  assert.equal(r.value.length, 2, '条目本身不受 secret 坏值牵连');
  assert.equal(r.warnings.length, 2);
  assert.equal(r.value[0]!.secret, undefined);
  assert.equal(r.value[1]!.secret, undefined);
});

test('parseChannelsKey: secret 长密钥（2000 上限内）原样收口', () => {
  const long = 'k'.repeat(2000);
  const r = parseChannelsKey([{ id: 'tg1', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', secret: long, allow: { kind: 'first-user' } }]);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.value[0]!.secret, long);
});

test('bindingKey: 通道:聊天惯例键', () => {
  assert.equal(bindingKey('feishu-main', 'oc_yyy'), 'feishu-main:oc_yyy');
});

test('parseChannelsKey: commands 开放命令解析（2026-11-22 用户裁定命令配置化）——子集收口/未知跳过/坏形态整字段忽略/缺席=全开放', () => {
  // 子集收口（去重保序）
  const ok = parseChannelsKey([{ id: 'tg1', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', commands: ['/stop', '/bogus', '/stop', '/new'], allow: { kind: 'all' } }]);
  assert.deepEqual(ok.value[0]!.commands, ['/stop', '/new'], '未知命令跳过+去重');
  assert.equal(ok.warnings.filter((w) => w.includes('/bogus')).length, 1);
  // 非字符串元素/非数组 → 整字段忽略
  const bad = parseChannelsKey([{ id: 'tg1', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', commands: ['/stop', 42], allow: { kind: 'all' } }]);
  assert.equal(bad.value[0]!.commands, undefined);
  assert.equal(bad.warnings.filter((w) => w.includes('commands')).length, 1);
  // 显式空数组=全不开放（仅自由聊天）
  const none = parseChannelsKey([{ id: 'tg1', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', commands: [], allow: { kind: 'all' } }]);
  assert.deepEqual(none.value[0]!.commands, []);
  // 缺席=全开放（键省略）
  const absent = parseChannelsKey([{ id: 'tg1', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', allow: { kind: 'all' } }]);
  assert.equal(absent.value[0]!.commands, undefined);
});

test('parseChannelsKey: sessionKind/charter 解析（2026-11-24 用户裁定「普通会话还是 Sunx」）——sunx 收口/非法跳字段/charter 逐字/空串=缺席', () => {
  // sunx 收口 + charter 逐字保存（不 trim）
  const ok = parseChannelsKey([{ id: 'tg1', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', sessionKind: 'sunx', charter: '  品性原文带首尾空白  ', allow: { kind: 'all' } }]);
  assert.equal(ok.warnings.length, 0);
  assert.equal(ok.value[0]!.sessionKind, 'sunx');
  assert.equal(ok.value[0]!.charter, '  品性原文带首尾空白  ');
  // 缺席=普通会话;空串 charter=缺席
  const absent = parseChannelsKey([{ id: 'tg2', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', charter: '', allow: { kind: 'all' } }]);
  assert.equal(absent.value[0]!.sessionKind, undefined);
  assert.equal(absent.value[0]!.charter, undefined);
  assert.equal(absent.warnings.length, 0);
  // 非法 sessionKind（非 sunx 非空串）→ warning 跳字段回退普通;charter 非串 → warning 跳字段
  const bad = parseChannelsKey([
    { id: 'tg3', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', sessionKind: 'oracle', charter: '品性', allow: { kind: 'all' } },
    { id: 'tg4', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', sessionKind: 'sunx', charter: 42, allow: { kind: 'all' } },
  ]);
  assert.equal(bad.value[0]!.sessionKind, undefined);
  assert.equal(bad.value[0]!.charter, '品性', 'sessionKind 跳字段不影响 charter');
  assert.equal(bad.value[1]!.charter, undefined);
  assert.equal(bad.warnings.length, 2);
  // 超 20000 字 → warning 跳字段
  const long = 'x'.repeat(20001);
  const over = parseChannelsKey([{ id: 'tg5', platform: 'telegram', enabled: true, root: 'D:/w', mode: 'read-only', charter: long, allow: { kind: 'all' } }]);
  assert.equal(over.value[0]!.charter, undefined);
  assert.equal(over.warnings.length, 1);
});
