import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionMode } from './modes';
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

test('resolveModeAlias 返回类型无 plan 死成员（终审修复：serve 的 plan 流程标记不经本函数——mode 端点/attach 分路自处理）', () => {
  const inputs = ['read-only', 'acceptEdits', 'full-access', 'manual', 'dontAsk', 'plan', '', 'typo'] as const;
  // 类型层判别锚：若返回类型仍含死成员 'plan'，下行的显式宽化赋值编译即红（死 union 成员回归闸）
  const mapped: Array<PermissionMode | undefined> = inputs.map((m) => resolveModeAlias(m));
  assert.ok(mapped.every((m) => m === undefined || m === 'read-only' || m === 'acceptEdits' || m === 'full-access'), '值域恒三档或 undefined');
});
