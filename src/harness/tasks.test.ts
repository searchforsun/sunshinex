import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskRegistry } from './tasks';

function makeReg(): { reg: TaskRegistry; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tasks-'));
  return { reg: new TaskRegistry(dir), dir };
}

test('TaskRegistry：submit 递增确定性 ID 并创建日志文件', () => {
  const { reg, dir } = makeReg();
  const a = reg.submit({ kind: 'exec', label: 'npm run dev' });
  const b = reg.submit({ kind: 'subagent', label: 'reviewer' });
  assert.equal(a.id, 'b1');
  assert.equal(b.id, 'b2');
  assert.equal(a.status, 'running');
  assert.equal(a.kind, 'exec');
  assert.ok(a.outputFilePath.startsWith(path.join(dir, 'tasks')));
  assert.ok(fs.existsSync(a.outputFilePath));
});

test('TaskRegistry：append 与 finish 终态行、幂等与 marker 形态', () => {
  const { reg } = makeReg();
  const t = reg.submit({ kind: 'exec', label: 'tail -f x.log' });
  reg.append(t.id, 'line-1\n');
  reg.finish(t.id, 'done', { exitCode: 0 });
  assert.equal(fs.readFileSync(t.outputFilePath, 'utf8'), 'line-1\n[exit 0]\n');
  // 幂等：已终态再 finish 不翻转状态、不重写行
  reg.finish(t.id, 'stopped', { marker: '[stopped]' });
  assert.equal(reg.get(t.id)?.status, 'done');
  assert.equal(fs.readFileSync(t.outputFilePath, 'utf8'), 'line-1\n[exit 0]\n');
  const s = reg.submit({ kind: 'subagent', label: 'w' });
  reg.finish(s.id, 'failed', { marker: '[w] did not finish (failed)' });
  assert.ok(fs.readFileSync(s.outputFilePath, 'utf8').endsWith('[w] did not finish (failed)\n'));
});

test('TaskRegistry：reap 只收割指定 owner 名下 running 任务并触发 stop 句柄', () => {
  const { reg } = makeReg();
  let killed = false;
  reg.submit({ kind: 'exec', label: 'main-task' });
  const owned = reg.submit({ kind: 'subagent', label: 'child-bg', ownerRun: 'fork-1' });
  owned.stop = () => { killed = true; };
  const reaped = reg.reap('fork-1');
  assert.deepEqual(reaped.map((r) => r.id), [owned.id]);
  assert.equal(killed, true);
  assert.equal(reg.get(owned.id)?.status, 'stopped');
  assert.ok(fs.readFileSync(owned.outputFilePath, 'utf8').includes('[stopped: owner finished]'));
  assert.equal(reg.list().find((r) => r.label === 'main-task')?.status, 'running');
});

test('TaskRegistry：stopAll 终结全部 running（进程收口兜底，规格 D9）', () => {
  const { reg } = makeReg();
  reg.submit({ kind: 'exec', label: 'a' });
  reg.submit({ kind: 'subagent', label: 'b' });
  const done = reg.submit({ kind: 'exec', label: 'c' });
  reg.finish(done.id, 'done', { exitCode: 0 });
  assert.equal(reg.stopAll().length, 2);
  assert.equal(reg.list().filter((r) => r.status === 'running').length, 0);
});

test('TaskRegistry：owner 作用域（AsyncLocalStorage）内 submit 缺省归属', async () => {
  const { reg } = makeReg();
  const inside = await reg.runInOwnerScope('fork-1', async () => reg.submit({ kind: 'exec', label: 'scoped' }).ownerRun);
  assert.equal(inside, 'fork-1');
  assert.equal(reg.currentOwner(), 'main');
  assert.equal(reg.submit({ kind: 'exec', label: 'outside' }).ownerRun, 'main');
});

test('TaskRegistry：list 全量快照、get 未命中返回 undefined', () => {
  const { reg } = makeReg();
  reg.submit({ kind: 'exec', label: 'a', ownerRun: 'main' });
  reg.submit({ kind: 'subagent', label: 'b', ownerRun: 'reviewer#2' });
  assert.equal(reg.list().length, 2);
  assert.equal(reg.get('b9'), undefined);
  assert.equal(reg.list()[0].ownerRun, 'main');
});
