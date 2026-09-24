// src/harness/security/guard.boundary.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import type { ApprovalRequest } from '../../types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-guard-b-'));
}

test('manual 档 Write 下放安全链：guard 不再逐次 ask（spec 5.1 写分支）', () => {
  const g = new SecurityGuard(new PolicyEngine(), 'manual');
  const d = g.preToolUse('Write', { path: path.join(tmpDir(), 'a.txt') });
  assert.equal(d.allowed, true);
});

test('plan 闸门先于 allow 短路：allow 规则不放宽 plan 只读', () => {
  const policy = new PolicyEngine();
  policy.add('allow', 'Write');
  const g = new SecurityGuard(policy, 'plan');
  const d = g.preToolUse('Write', { path: 'a.txt' });
  assert.equal(d.allowed, false);
  assert.ok(!d.allowed && d.reason.includes('plan mode allows read-only operations only'));
});

test('allow 规则在非 plan 档免批', () => {
  const policy = new PolicyEngine();
  policy.add('allow', 'Bash(npm*)');
  const g = new SecurityGuard(policy, 'manual');
  assert.equal(g.preToolUse('Bash', 'npm test').allowed, true);
});

test('会话目录登记与判定（含自身；clear 同步清理）', () => {
  const g = new SecurityGuard(new PolicyEngine(), 'manual');
  const dir = tmpDir();
  g.allowSessionDir(dir);
  assert.equal(g.sessionDirAllowed(dir), true);
  assert.equal(g.sessionDirAllowed(path.join(dir, 'sub', 'f.txt')), true);
  assert.equal(g.sessionDirAllowed(path.join(path.dirname(dir), 'elsewhere.txt')), false);
  assert.deepEqual(g.sessionDirList(), [dir]);
  g.clearSessionAllows();
  assert.equal(g.sessionDirAllowed(dir), false);
});

test('resolveAsk：无 asker 返回 null（宁停不误）；有 asker 原样回传决策', async () => {
  const g = new SecurityGuard(new PolicyEngine(), 'manual');
  const req: ApprovalRequest = { id: g.nextApprovalId(), kind: 'write', subject: '/tmp/x/a.txt', reason: 'r' };
  assert.equal(await g.resolveAsk(req), null);
  g.setAsker(async () => 'allow');
  assert.equal(await g.resolveAsk(req), 'allow');
  assert.ok(g.nextApprovalId().startsWith('ap-'));
});
