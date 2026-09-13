import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBannerInfo, FALLBACK_VERSION } from './banner-info';

test('buildBannerInfo：显式入参全量采用', () => {
  const info = buildBannerInfo({ version: '9.9.9', model: 'm1', root: '/tmp/x' });
  assert.deepEqual(info, { version: '9.9.9', model: 'm1', root: '/tmp/x' });
});

test('buildBannerInfo：version 空回退 FALLBACK_VERSION', () => {
  assert.equal(buildBannerInfo({ version: '' }).version, FALLBACK_VERSION);
  assert.equal(buildBannerInfo().version, FALLBACK_VERSION);
});

test('buildBannerInfo：model 缺省读 SUNSHINEX_MODEL，缺失显示 not set', () => {
  const prev = process.env.SUNSHINEX_MODEL;
  delete process.env.SUNSHINEX_MODEL;
  try {
    assert.equal(buildBannerInfo({ version: '1.0.0' }).model, 'not set');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_MODEL;
    else process.env.SUNSHINEX_MODEL = prev;
  }
});

test('buildBannerInfo：root 缺省取 process.cwd()', () => {
  assert.equal(buildBannerInfo({ version: '1.0.0', model: 'm' }).root, process.cwd());
});
