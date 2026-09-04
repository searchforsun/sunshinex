import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';

test('dangerous rm 被拦截并附原因', () => {
  const p = new PolicyEngine();
  p.add('deny', 'Bash(rm *)');
  const g = new SecurityGuard(p, 'manual');
  const r = g.preToolUse('Bash', { command: 'rm -rf /' });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.ok(r.reason.includes('deny'));
});

test('只读白名单命令默认放行', () => {
  const g = new SecurityGuard(new PolicyEngine(), 'manual');
  const r = g.preToolUse('Bash', { command: 'ls -la' });
  assert.equal(r.allowed, true);
});

test('plan 模式下写工具被拒', () => {
  const g = new SecurityGuard(new PolicyEngine(), 'plan');
  const r = g.preToolUse('Write', { path: 'x', content: 'y' });
  assert.equal(r.allowed, false);
});
