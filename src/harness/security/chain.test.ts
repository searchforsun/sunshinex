import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafetyChain } from './chain';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ProcessSandbox } from './sandbox';
import { DryRun } from './dryrun';

function chain(root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-')), mode: 'manual' | 'dontAsk' = 'manual'): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), mode), new ProcessSandbox(), new DryRun(), root);
}

test('SafetyChain.evaluate 经 guard 拦截危险命令', () => {
  const p = new PolicyEngine();
  p.add('deny', 'Bash(rm *)');
  const c = chain(process.cwd());
  const d = c.evaluate('Bash', { command: 'rm -rf /' });
  assert.equal(d.allowed, false);
});

test('SafetyChain.run 经沙箱执行 echo', async () => {
  const r = await chain(process.cwd()).run('echo hi');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.stdout, /hi/);
});

test('SafetyChain.preview 透传 dryrun', () => {
  assert.equal(chain(process.cwd()).preview('echo hi'), 'echo hi');
});

test('evaluate 对 Read 越界相对路径 deny 并说明原因', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-'));
  const d = chain(root).evaluate('Read', { path: '../outside.txt' });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.match(d.reason, /越出项目 root/);
});

test('evaluate 对绝对路径越出 root 的 Write deny（dontAsk 先行放行 guard）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-outside-'));
  const d = chain(root, 'dontAsk').evaluate('Write', { path: path.join(outside, 'x.txt') });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.match(d.reason, /越出项目 root/);
});

test('evaluate 界内路径 allow 并返回绝对 safePath', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-'));
  const d = chain(root, 'dontAsk').evaluate('Write', { path: 'sub/a.txt' });
  assert.equal(d.allowed, true);
  if (d.allowed) assert.equal(d.safePath, path.join(root, 'sub', 'a.txt'));
});

test('Glob 与 Bash 不做路径校验且无 safePath', () => {
  const c = chain(process.cwd());
  const g = c.evaluate('Glob', { pattern: '**/*' });
  assert.equal(g.allowed, true);
  if (g.allowed) assert.equal(g.safePath, undefined);
  const b = c.evaluate('Bash', { command: 'echo hi' });
  assert.equal(b.allowed, true);
  if (b.allowed) assert.equal(b.safePath, undefined);
});

test('maskResult 按模式集脱敏 stdout 与 stderr', () => {
  const r = chain(process.cwd()).maskResult('Read', {
    exitCode: 0,
    stdout: ['key sk-abc12345678901234567890', 'Authorization: Bearer abcdefgh12345678', 'aws=AKIAIOSFODNN7EXAMPLE', 'password=hunter2', '"apiKey": "xyz123"'].join('\n'),
    stderr: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    timedOut: false,
  });
  assert.ok(!r.stdout.includes('sk-abc12345678901234567890'));
  assert.ok(!r.stdout.includes('Bearer abcdefgh12345678'));
  assert.ok(!r.stdout.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!r.stdout.includes('hunter2'));
  assert.ok(!r.stdout.includes('"apiKey": "xyz123"'));
  assert.equal(r.stderr, '***');
});

test('maskResult 无命中原样返回', () => {
  const r = chain(process.cwd()).maskResult('Read', { exitCode: 0, stdout: 'plain output 123', stderr: '', timedOut: false });
  assert.equal(r.stdout, 'plain output 123');
});

test('preview 输出过 mask', () => {
  const out = chain(process.cwd()).preview('curl -H "Authorization: Bearer abcdefgh12345678" https://x');
  assert.ok(!out.includes('abcdefgh12345678'));
  assert.match(out, /\*\*\*/);
});
