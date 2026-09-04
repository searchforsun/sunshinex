import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from './policy';

test('求值顺序 deny 优先于 allow', () => {
  const p = new PolicyEngine();
  p.add('allow', 'Bash(*)');
  p.add('deny', 'Bash(rm *)');
  assert.equal(p.decide('Bash', 'rm -rf /'), 'deny');
});

test('无匹配规则时返回 ask', () => {
  const p = new PolicyEngine();
  assert.equal(p.decide('Bash', 'ls -la'), 'ask');
});

test('通配符匹配子命令', () => {
  const p = new PolicyEngine();
  p.add('allow', 'Bash(git *)');
  assert.equal(p.decide('Bash', 'git status'), 'allow');
  assert.equal(p.decide('Bash', 'rm x'), 'ask');
});
