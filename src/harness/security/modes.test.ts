import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModeAlias } from './modes';

test('resolveModeAlias：现值原样透传、旧档映射、plan→acceptEdits 安全落点、未知 undefined', () => {
  assert.equal(resolveModeAlias('read-only'), 'read-only');
  assert.equal(resolveModeAlias('acceptEdits'), 'acceptEdits');
  assert.equal(resolveModeAlias('full-access'), 'full-access');
  assert.equal(resolveModeAlias('manual'), 'acceptEdits');
  assert.equal(resolveModeAlias('dontAsk'), 'full-access');
  assert.equal(resolveModeAlias('plan'), 'acceptEdits', '旧 GUI plan 档真身 dontAsk,回放落全自动危险,统一落工作区编辑(spec §3.3)');
  assert.equal(resolveModeAlias(''), undefined);
  assert.equal(resolveModeAlias('typo'), undefined);
});
