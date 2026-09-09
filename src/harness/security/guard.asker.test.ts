import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ApprovalDecision, ApprovalRequest } from '../../types';

function manualGuard(policy?: PolicyEngine): SecurityGuard {
  return new SecurityGuard(policy ?? new PolicyEngine(), 'manual', [], []);
}

test('asker：manual 非白名单操作走交互裁决（allow/deny/always 三态 + 会话级登记）', async () => {
  const script: ApprovalDecision[] = ['allow', 'deny', 'always'];
  const seen: ApprovalRequest[] = [];
  const g = manualGuard();
  g.setAsker(async (req) => {
    seen.push(req);
    return script[seen.length - 1];
  });
  const input = { command: 'touch tui-probe.txt' };

  const d1 = await g.preToolUseAsync('Bash', input);
  assert.equal(d1.allowed, true, 'allow 放行一次');
  const d2 = await g.preToolUseAsync('Bash', input);
  assert.equal(d2.allowed, false, 'deny 拒绝');
  if (!d2.allowed) assert.match(d2.reason, /用户拒绝/);
  const d3 = await g.preToolUseAsync('Bash', input);
  assert.equal(d3.allowed, true, 'always 放行并登记');
  const d4 = await g.preToolUseAsync('Bash', input);
  assert.equal(d4.allowed, true, 'always 后同 subject 会话内直通');
  assert.equal(seen.length, 3, '第 4 次不应再询问');
  assert.equal(seen[0].kind, 'command');
  assert.equal(seen[0].subject, 'touch tui-probe.txt');

  g.clearSessionAllows();
  await g.preToolUseAsync('Bash', input);
  assert.equal(seen.length, 4, 'clear 后恢复询问');
});

test('asker：只读白名单不询问；无 asker 维持阶段一拒绝；asker 异常按拒绝收束', async () => {
  const g = manualGuard();
  const d0 = await g.preToolUseAsync('Bash', { command: 'ls -la' });
  assert.equal(d0.allowed, true, '只读白名单直通不询问');

  const g2 = manualGuard();
  const d1 = await g2.preToolUseAsync('Bash', { command: 'touch x.txt' });
  assert.equal(d1.allowed, false, '无 asker 维持阶段一拒绝');
  if (!d1.allowed) assert.match(d1.reason, /manual 模式需交互确认/);

  const g3 = manualGuard();
  g3.setAsker(async () => {
    throw new Error('asker 炸了');
  });
  const d2 = await g3.preToolUseAsync('Bash', { command: 'touch y.txt' });
  assert.equal(d2.allowed, false, 'asker 异常按拒绝收束（宁停不误）');
  if (!d2.allowed) assert.match(d2.reason, /asker 异常/);
});

test('asker：deny 规则与破坏性命令不因交互放行（硬底线先行）', async () => {
  const policy = new PolicyEngine();
  policy.add('deny', 'Bash(touch *)');
  const g = manualGuard(policy);
  g.setAsker(async () => 'allow');
  const d1 = await g.preToolUseAsync('Bash', { command: 'touch z.txt' });
  assert.equal(d1.allowed, false, 'deny 规则不被 asker 豁免');
  if (!d1.allowed) assert.match(d1.reason, /deny 规则匹配/);
  const d2 = await g.preToolUseAsync('Bash', { command: 'rm -rf stuff' });
  assert.equal(d2.allowed, false, '破坏性命令不被 asker 豁免');
  if (!d2.allowed) assert.match(d2.reason, /破坏性命令/);
});

test('asker：write 类工具审批 kind=write 且 subject 取路径', async () => {
  const g = manualGuard();
  const seen: ApprovalRequest[] = [];
  g.setAsker(async (req) => {
    seen.push(req);
    return 'deny';
  });
  await g.preToolUseAsync('Write', { path: 'a.txt' });
  assert.equal(seen[0].kind, 'write');
  assert.equal(seen[0].subject, 'a.txt');
});
