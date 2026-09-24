// Task 6（spec 5.4 台账 parked 承接）：后台 exec 经 registry 注入的 gateView.execWrap 取链侧 landlock 包装——
// 端到端接线（builtin exec 工具 → runtimeSafety 视图 → SafetyChain.execWrap → 后台分支 ExecOpts.wrap）。
// 真实后台进程对 wrap 的消费（launcher 前缀接管进程位）由 sandbox.wrap.test.ts 覆盖；本文件用 spy 后端
// 断言「包装确实到达后台分支」，landlock 走 fake loader（禁真实内核探针，进程级缓存先行复位）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { ProcessSandbox } from './security/sandbox';
import { DryRun } from './security/dryrun';
import { TaskRegistry } from './tasks';
import { configureLandlockLoader, resetLandlockProbe } from './security/landlock';
import { ok } from '../result';
import type { ToolBackend } from '../types';

test('后台 exec：链侧 execWrap 经 gateView 透传进后台分支（fake loader，无真实内核探针）', async () => {
  const seen: Array<{ cwd?: string; wrap?: { file: string; args: string[] } }> = [];
  const real = new ProcessSandbox();
  const spyBackend: ToolBackend = {
    name: 'spy-process',
    readFile: (absPath) => real.readFile(absPath),
    writeFile: (absPath, content) => real.writeFile(absPath, content),
    listFiles: (rootDir, pattern) => real.listFiles(rootDir, pattern),
    exec: (cmd, opts) => real.exec(cmd, opts),
    execBackground: async (_cmd, opts = {}) => {
      seen.push(opts);
      return ok({ pid: 0 });
    },
  };
  configureLandlockLoader(async () => ({
    launcherPath: () => process.execPath,
    probe: () => 'ok',
    grantArgs: (g: { readOnly: string[]; readWrite: string[] }) => ['--rw', ...g.readWrite, '--ro', ...g.readOnly],
  }));
  resetLandlockProbe();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-execwrap-e2e-'));
  try {
    const safety = new SafetyChain(new SecurityGuard(), spyBackend, new DryRun(), tmp);
    const tasks = new TaskRegistry(path.join(tmp, 'data'));
    const tools = new ToolRegistry();
    const execTool = builtinTools(safety, tmp, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tasks).find((t) => t.name === 'exec');
    assert.ok(execTool, 'builtin exec 工具已注册');
    tools.register(execTool!);

    const r = await tools.execute('exec', { command: 'echo wrapped', background: true }, safety);
    assert.ok(r.ok, `exec 提交成功：${r.ok ? '' : r.error.message}`);
    assert.match(r.ok ? r.value.stdout : '', /task b1 started/, '后台任务登记回执');

    assert.equal(seen.length, 1, '后台分支恰好收到一次提交');
    const wrap = seen[0]!.wrap;
    assert.ok(wrap, 'ExecOpts.wrap 已注入（null=未包装）');
    assert.equal(wrap!.file, process.execPath, 'wrap.file 为 fake launcher 路径');
    assert.equal(wrap!.args[0], '--rw');
    assert.ok(wrap!.args.includes(tmp), '链侧可写根（装配根）进入 grant 列表');
    const task = tasks.list().find((t) => t.kind === 'exec');
    assert.ok(task, '任务账本已登记后台 exec');
  } finally {
    configureLandlockLoader(null);
    resetLandlockProbe();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
