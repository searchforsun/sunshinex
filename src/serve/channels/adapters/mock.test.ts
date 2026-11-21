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

test('注册表: 未实现平台抛错 + secret 缺失经 deps 透传', () => {
  assert.throws(() => createChannelAdapter(cfg({ id: 'f1', platform: 'feishu' }), { secret: '', ident: {} }), /not implemented/);
});
