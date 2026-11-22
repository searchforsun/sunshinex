import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannelAdapter } from './types';
import type { ChannelConfig } from '../model';

function cfg(over: Partial<ChannelConfig> = {}): ChannelConfig {
  return { id: 'm1', platform: 'mock', enabled: true, root: '/w', mode: 'read-only', allow: { kind: 'all' }, ...over };
}

test('mock 适配器: emit→sink 直达 + send 日志 + health', async () => {
  const ad = createChannelAdapter(cfg(), { secret: '', ident: {} });
  const got: unknown[] = [];
  await ad.start((m) => got.push(m));
  ad.emit!({ channel: 'm1', chatId: 'c1', chatKind: 'direct', userId: 'u1', msgId: 'n1' });
  assert.equal(got.length, 1);
  assert.deepEqual(await ad.send({ channelId: 'm1', chatId: 'c1' }, { text: 'hi' }), undefined);
  assert.equal(ad.health().connected, true);
  await ad.stop();
});

test('注册表: 未实现平台抛错(dingtalk/wecom);feishu 已落地(Task 15 追加)构造成功', () => {
  assert.throws(() => createChannelAdapter(cfg({ id: 'd1', platform: 'dingtalk' }), { secret: '', ident: {} }), /not implemented/);
  assert.throws(() => createChannelAdapter(cfg({ id: 'w1', platform: 'wecom' }), { secret: '', ident: {} }), /not implemented/);
  const fs1 = createChannelAdapter(cfg({ id: 'f1', platform: 'feishu' }), { secret: 's', ident: {} });
  assert.equal(fs1.id, 'f1');
});
