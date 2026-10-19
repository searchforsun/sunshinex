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

test('TaskRegistry：submit 生成「业务-时间-随机」id 并创建日志文件（跨会话唯一，b1 进程计数器退役）', () => {
  const { reg, dir } = makeReg();
  const a = reg.submit({ kind: 'exec', label: 'npm run dev' });
  const b = reg.submit({ kind: 'subagent', label: '服务与数据层分析' });
  // 业务段：ASCII label slug 化；CJK 等非拉丁标签回退 kind（业务全称由 /tasks label 列承载）
  assert.match(a.id, /^npm-run-dev-\d{8}T\d{6}Z-[a-z0-9]{4}$/, 'exec id = label slug + UTC 紧凑时间戳 + 4 位随机尾（newSessionId 同方言）');
  assert.match(b.id, /^subagent-\d{8}T\d{6}Z-[a-z0-9]{4}$/, 'CJK 标签业务段回退 kind');
  assert.notEqual(a.id, b.id);
  assert.equal(a.status, 'running');
  assert.equal(a.kind, 'exec');
  assert.ok(a.outputFilePath.startsWith(path.join(dir, 'tasks')));
  assert.ok(a.outputFilePath.endsWith(`${a.id}.log`), '日志文件名随 id（同 id 建档即截断覆盖，唯一性=旧日志不丢）');
  assert.ok(fs.existsSync(a.outputFilePath));
  // 唯一性：同秒连发（随机段+撞 id 再生成兜底）
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) ids.add(reg.submit({ kind: 'exec', label: 'x' }).id);
  assert.equal(ids.size, 50, '同秒连发 50 次全唯一');
  // 跨会话（新注册表=进程重启）：不再复用 id——旧 b1 每会话从 1 重来，跨会话同 id 截断旧任务日志
  const reg2 = new TaskRegistry(dir);
  const c = reg2.submit({ kind: 'exec', label: 'npm run dev' });
  assert.notEqual(a.id, c.id, '跨会话同 label 不撞 id');
  assert.ok(fs.existsSync(c.outputFilePath), '新会话建档独立日志文件');
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

test('TaskRegistry.resolveId：板 id 归一单点——直接命中优先,旧 tN/新方言按前缀命中派发条目,多命中取最近', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-registry-resolve-'));
  try {
    const reg = new TaskRegistry(path.join(root, 'data'));
    // 旧恢复档派发形态:label 'task-t5'(dispatchTag 对 tN 补前缀)→ 台账 id task-t5-<ts>-<rand>
    const legacy = reg.submit({ kind: 'subagent', label: 'task-t5' });
    assert.match(legacy.id, /^task-t5-/);
    // 新方言派发形态:label=板 id 'task-build-parser-k3f2' → 台账 id 再带时间戳随机尾
    const modern = reg.submit({ kind: 'subagent', label: 'task-build-parser-k3f2' });
    assert.match(modern.id, /^task-build-parse-/, '台账业务段截 16(slug 方言)');
    // 直接命中优先
    assert.equal(reg.resolveId(modern.id), modern.id);
    // 旧 tN 板 id 与 delegationId 形态 → 前缀命中旧条目
    assert.equal(reg.resolveId('t5'), legacy.id);
    assert.equal(reg.resolveId('task-t5'), legacy.id);
    // 新方言板 id → 前缀命中新条目(台账 id 带 ts/rand 尾)
    assert.equal(reg.resolveId('task-build-parser-k3f2'), modern.id);
    // 多命中取最近提交:同板 id 重派发后旧条目让位新条目
    const legacy2 = reg.submit({ kind: 'subagent', label: 'task-t5' });
    assert.equal(reg.resolveId('t5'), legacy2.id);
    assert.ok(legacy2.startedAt >= legacy.startedAt);
    // 真未知 id 原样透传(调用面报 INVALID_ARG)
    assert.equal(reg.resolveId('t99'), 't99');
    assert.equal(reg.resolveId('exec-20261003T064522Z-a7f3'), 'exec-20261003T064522Z-a7f3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
