import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { confirmApprovals, runPipelineAssembly, teardownCliRun } from './run-pipeline';
import { buildDeps } from '../../runtime';
import { ScriptedAdapter } from '../../model/adapter';
import { TaskRegistry } from '../../harness/tasks';
import type { MemoryPipeline } from '../../harness/memory/pipeline';

test('confirmApprovals：y 批准 / n 拒绝 / 多 gate 逐个询问', async () => {
  const answers = ['y', 'n'];
  const fake = { question: async () => answers.shift() ?? 'n' };
  const r = await confirmApprovals(['delivery-gate', 'release-gate'], fake);
  assert.deepEqual(r, { 'delivery-gate': true, 'release-gate': false });
});

test('confirmApprovals：Yes/YES 大小写不敏感', async () => {
  const fake = { question: async () => 'YES' };
  const r = await confirmApprovals(['g'], fake);
  assert.deepEqual(r, { g: true });
});

test('pipeline：ScriptedAdapter 离线端到端——五节点链 paused 于 delivery-gate，resume 后 done', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-pipeline-'));
  fs.writeFileSync(path.join(tmp, 'math.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(tmp, 'math.test.js'), 'const assert = require("node:assert");\nconst { add } = require("./math");\nassert.equal(add(1, 2), 4);\n');
  const deps = buildDeps(tmp, {});
  (deps as { model: unknown }).model = new ScriptedAdapter([
    '{"done":true,"reply":"规划：修正测试断言为 3"}',
    '{"tool":"write","input":{"path":"math.test.js","content":"const assert = require(\\"node:assert\\");\\nconst { add } = require(\\"./math\\");\\nassert.equal(add(1, 2), 3);\\n"},"done":false}',
    '{"done":true,"reply":"开发完成：断言已修正"}',
    '{"done":true,"reply":"测试验证完成：断言符合 c1"}',
    '{"done":true,"reply":"审查通过，无阻塞问题"}',
  ]);
  const tpl = runPipelineAssembly(deps, {
    goal: '实现 add 函数并保证测试正确（验收标准：c1=math.test.js 断言 add(1,2)===3）',
    ruleCheckers: {
      c1: async () => fs.readFileSync(path.join(tmp, 'math.test.js'), 'utf8').includes('assert.equal(add(1, 2), 3)'),
    },
  });
  const r1 = await tpl.engine.run('实现 add 函数并保证测试正确');
  assert.equal(r1.status, 'paused');
  assert.deepEqual(r1.pendingGates, ['delivery-gate']);
  const r2 = await tpl.engine.resume({ 'delivery-gate': true });
  assert.equal(r2.status, 'done');
  assert.deepEqual(r2.failedNodes, []);
});

test('teardownCliRun：收尾链停全部 running 后台任务并落 [stopped: process exit] 终态行（D24）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-teardown-'));
  const reg = new TaskRegistry(dir);
  const running = reg.submit({ kind: 'exec', label: 'dev-server' });
  const finished = reg.submit({ kind: 'exec', label: 'quick' });
  reg.finish(finished.id, 'done', { exitCode: 0 });
  const calls: string[] = [];
  await teardownCliRun(
    {
      pipeline: { drain: async () => { calls.push('drain'); } } as unknown as MemoryPipeline,
      mcpWarnings: () => [],
      mcpClose: async () => { calls.push('mcpClose'); },
      stopAllTasks: () => { calls.push('stopAllTasks'); reg.stopAll(); },
    },
    'done',
  );
  // 判别力：不接线（teardown 不调 stopAllTasks）则 running 日志停在半截、calls 缺位，两断言俱红
  assert.ok(
    fs.readFileSync(running.outputFilePath, 'utf8').endsWith('[stopped: process exit]\n'),
    'running 任务日志尾部应有进程收口终态行（不接线必红：日志永久半截）',
  );
  assert.equal(reg.get(running.id)?.status, 'stopped');
  assert.equal(reg.get(finished.id)?.status, 'done', '已终态任务不被翻写（finish 幂等）');
  assert.deepEqual(calls, ['drain', 'stopAllTasks', 'mcpClose'], '任务收口在 drain 后、MCP 关闭前（执行体先停、通道后关）');
});

test('buildDeps→teardownCliRun：真后台任务经命令收尾停机并落进程收口终态行（D24 端到端）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-stopall-'));
  // 命令对 shell 中立（§14 测试命令形态）：node 脚本先输出后长驻，sh/PowerShell 两面同语义
  const script = path.join(tmp, 'hold.js');
  fs.writeFileSync(script, "console.log('warm'); setTimeout(() => {}, 30000);\n");
  const deps = buildDeps(tmp, {});
  try {
    const r = await deps.registry.execute('exec', { command: `node "${script.replace(/\\/g, '/')}"`, background: true }, deps.safety);
    assert.ok(r.ok, `后台 exec 应成功，实际 ${r.ok ? '' : r.error.code}`);
    const logPath = r.value.stdout.match(/output: (.+?)\)/)![1]!;
    // warm 进日志后再收口：证明任务真在跑（不是起即死），且 warm 行先于终态行
    for (let i = 0; i < 200 && !fs.readFileSync(logPath, 'utf8').includes('warm'); i++) await new Promise((res) => setTimeout(res, 50));
    await teardownCliRun(deps, 'done');
    const log = fs.readFileSync(logPath, 'utf8');
    assert.ok(log.includes('warm'), '任务输出已落日志（收口前在跑）');
    assert.ok(log.includes('[stopped: process exit]'), `收尾后任务日志应含进程收口终态行，实际：${log}`);
  } finally {
    // 收尾链已触发 stop 句柄（kill 收割）；目录删除按 win32 句柄释放延迟重试
    for (let i = 0; i < 50; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((res) => setTimeout(res, 100));
      }
    }
  }
});
