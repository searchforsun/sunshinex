import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCacheClear, handleCacheStatus, type CacheHandlerIo } from './cache-handlers';

/** tmp 桩 io:send 落 lastResponse;readJson 按脚本应答 */
function stubIo(script: Array<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>): { io: CacheHandlerIo; sent: Array<{ status: number; body: object }> } {
  const sent: Array<{ status: number; body: object }> = [];
  let step = 0;
  const io: CacheHandlerIo = {
    send: (_res, status, body) => sent.push({ status, body }),
    readJson: async () => script[step++] ?? { ok: true, body: {} },
    status: () => ({ total: 7, categories: [{ id: 'pty-replay', safe: true, size: 7, files: 1 }] }),
    retentionInfo: () => ({ days: 30, lastRunAt: 1_000, lastPurged: 2, lastFailed: 0 }),
    clear: (ids) => ({ cleared: [{ id: ids?.[0] ?? 'pty-replay', freed: 7 }], failed: [] }),
  };
  return { io, sent };
}

const fakeRes = {} as never;
const fakeReq = {} as never;

test('handleCacheStatus:200 = status + retention 归并', async () => {
  const { io, sent } = stubIo([]);
  handleCacheStatus(io, fakeRes);
  assert.equal(sent[0]!.status, 200);
  assert.deepEqual(sent[0]!.body, {
    total: 7,
    categories: [{ id: 'pty-replay', safe: true, size: 7, files: 1 }],
    retention: { days: 30, lastRunAt: 1_000, lastPurged: 2, lastFailed: 0 },
  });
});

test('handleCacheClear:categories 缺省透传 undefined(safe 全档);非法形状 400', async () => {
  {
    const { io, sent } = stubIo([{ ok: true, body: {} }]);
    await handleCacheClear(io, fakeReq, fakeRes);
    assert.equal(sent[0]!.status, 200);
    assert.deepEqual(sent[0]!.body, { cleared: [{ id: 'pty-replay', freed: 7 }], failed: [] });
  }
  {
    const { io, sent } = stubIo([{ ok: true, body: { categories: ['images-cache', 3] } }]);
    await handleCacheClear(io, fakeReq, fakeRes);
    assert.equal(sent[0]!.status, 400);
    assert.deepEqual(sent[0]!.body, { error: 'categories must be an array of strings' });
  }
  {
    const { io, sent } = stubIo([{ ok: false, status: 400, error: 'bad json' }]);
    await handleCacheClear(io, fakeReq, fakeRes);
    assert.equal(sent[0]!.status, 400);
    assert.deepEqual(sent[0]!.body, { error: 'bad json' });
  }
});

test('handleCacheClear:显式 categories 透传给 clear', async () => {
  const { io, sent } = stubIo([{ ok: true, body: { categories: ['images-cache'] } }]);
  await handleCacheClear(io, fakeReq, fakeRes);
  assert.deepEqual(sent[0]!.body, { cleared: [{ id: 'images-cache', freed: 7 }], failed: [] });
});
