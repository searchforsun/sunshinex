import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessSandbox } from './sandbox';
import { DryRun } from './dryrun';

test('ProcessSandbox 执行 echo 返回输出', async () => {
  const s = new ProcessSandbox();
  const r = await s.run('echo hello');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.stdout, /hello/);
});

test('ProcessSandbox 执行不存在命令返回失败', async () => {
  const s = new ProcessSandbox();
  const r = await s.run('nonexistent_cmd_xyz');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'EXEC_FAILED');
});

test('DryRun 预览返回原命令', () => {
  const d = new DryRun();
  assert.equal(d.preview('rm -rf /'), 'rm -rf /');
});
