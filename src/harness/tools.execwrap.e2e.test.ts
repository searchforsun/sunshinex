// Task 6（spec 5.4 台账 parked 承接）+ D19-a：exec 经 registry 注入的 gateView 取链侧安全语义——
// 后台分支经 gateView.execWrap 取 landlock 包装（端到端接线：builtin exec 工具 → runtimeSafety 视图 →
// SafetyChain.execWrap → 后台分支 ExecOpts.wrap）；前台分支经 gateView.run 取链侧判界+包装单点（D19-a：
// 隔离子链 withRoot 克隆的写围栏锚专属树、不含主根——旧形态走闭包装配链恒锚主根）。
// 真实后台进程对 wrap 的消费（launcher 前缀接管进程位）由 sandbox.wrap.test.ts 覆盖；本文件用 spy 后端
// 断言「包装确实到达 exec 分支」，landlock 走 fake loader（禁真实内核探针，进程级缓存先行复位）。
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
import { TaskRegistry } from './tasks';
import { configureLandlockLoader, resetLandlockProbe } from './security/landlock';
import { ok } from '../result';
import type { RuntimeSafetyGate, ToolBackend } from '../types';

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
    const safety = new SafetyChain(new SecurityGuard(), spyBackend, tmp);
    const tasks = new TaskRegistry(path.join(tmp, 'data'));
    const tools = new ToolRegistry();
    const execTool = builtinTools(safety, tmp, { tasks }).find((t) => t.name === 'exec');
    assert.ok(execTool, 'builtin exec 工具已注册');
    tools.register(execTool!);

    const r = await tools.execute('exec', { command: 'echo wrapped', background: true }, safety);
    assert.ok(r.ok, `exec 提交成功：${r.ok ? '' : r.error.message}`);
    assert.match(r.ok ? r.value.stdout : '', /task \S+ started/, '后台任务登记回执（动态任务 id，业务-时间-随机方言）');

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

test('前台 exec（D19-a）：经 gateView.run 执行——fake 链视图记录 run 调用，闭包装配链不被触及', async () => {
  const closureExec: string[] = [];
  const real = new ProcessSandbox();
  const spyBackend: ToolBackend = {
    name: 'spy-process',
    readFile: (absPath) => real.readFile(absPath),
    writeFile: (absPath, content) => real.writeFile(absPath, content),
    listFiles: (rootDir, pattern) => real.listFiles(rootDir, pattern),
    exec: async (cmd) => {
      closureExec.push(cmd);
      return ok({ exitCode: 0, stdout: 'via-closure', stderr: '', timedOut: false });
    },
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-execgate-'));
  try {
    const safety = new SafetyChain(new SecurityGuard(), spyBackend, tmp);
    const execTool = builtinTools(safety, tmp).find((t) => t.name === 'exec');
    assert.ok(execTool, 'builtin exec 工具已注册');
    const tree = path.join(tmp, 'tree');
    fs.mkdirSync(tree);
    const runCalls: Array<{ cmd: string; cwd?: string }> = [];
    const gate: RuntimeSafetyGate = {
      execCwd: () => tree,
      execCommandAllowed: () => ({ allowed: true }),
      run: (cmd, opts) => {
        runCalls.push({ cmd, cwd: opts?.cwd });
        return Promise.resolve(ok({ exitCode: 0, stdout: `via-gate:${cmd}`, stderr: '', timedOut: false }));
      },
    };
    // 前台分支：视图在场时执行面必须走 gateView.run（cwd 也取视图值），不得触及闭包链
    const r = await execTool.executor({ command: 'echo hi' }, gate);
    assert.equal(r.stdout, 'via-gate:echo hi', '前台 exec 应经视图 run 执行');
    assert.deepEqual(runCalls, [{ cmd: 'echo hi', cwd: tree }], 'run 恰好一次、cmd 与 cwd 均来自视图');
    assert.equal(closureExec.length, 0, '闭包装配链不得被执行（旧病根：landlock 可写根恒锚主根）');
    // 视图缺省回落装配链：无注入时逐字节旧行为（闭包 safety.run）
    const fallback = await execTool.executor({ command: 'echo hi' });
    assert.equal(fallback.stdout, 'via-closure', '无视图注入时回落闭包链（旧行为不变）');
    assert.deepEqual(closureExec, ['echo hi'], '回落路径恰好执行一次闭包链');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('前台 exec（D19-a）：隔离子链经 gateView.run 取链侧 landlock 围栏——可写根锚专属树、不含主根', async () => {
  const seen: Array<{ cwd?: string; wrap?: { file: string; args: string[] } }> = [];
  const real = new ProcessSandbox();
  const spyBackend: ToolBackend = {
    name: 'spy-process',
    readFile: (absPath) => real.readFile(absPath),
    writeFile: (absPath, content) => real.writeFile(absPath, content),
    listFiles: (rootDir, pattern) => real.listFiles(rootDir, pattern),
    exec: async (_cmd, opts = {}) => {
      seen.push(opts);
      return ok({ exitCode: 0, stdout: 'spy', stderr: '', timedOut: false });
    },
  };
  configureLandlockLoader(async () => ({
    launcherPath: () => process.execPath,
    probe: () => 'ok',
    grantArgs: (g: { readOnly: string[]; readWrite: string[] }) => ['--rw', ...g.readWrite, '--ro', ...g.readOnly],
  }));
  resetLandlockProbe();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-execgate-iso-'));
  try {
    const tree = path.join(tmp, 'subagent-tree');
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(tree, 't.txt'), 'x\n');
    // 闭包链锚主根（builtinTools 装配形态），fork 子链 withRoot 换根克隆（隔离子代理同款）
    const safety = new SafetyChain(new SecurityGuard(), spyBackend, tmp);
    const execTool = builtinTools(safety, tmp).find((t) => t.name === 'exec');
    assert.ok(execTool, 'builtin exec 工具已注册');
    const tools = new ToolRegistry();
    tools.register(execTool);
    const fork = safety.withRoot(tree);

    // registry.execute 以执行期链（fork）注入视图——前台 run 的 landlock 围栏须随 fork 链求值
    const r = await tools.execute('exec', { command: 'echo iso' }, fork);
    assert.ok(r.ok, `exec 应成功：${r.ok ? '' : r.error.message}`);
    assert.equal(seen.length, 1, '前台分支恰好一次执行');
    assert.equal(seen[0]!.cwd, tree, 'cwd 锚专属树（既有 execCwd 缝）');
    const wrap = seen[0]!.wrap;
    assert.ok(wrap, '前台分支 ExecOpts.wrap 已注入（经视图 run 在链内取）');
    assert.ok(wrap!.args.includes(tree), `可写根须含专属树：${wrap!.args.join(' ')}`);
    assert.ok(!wrap!.args.includes(tmp), `可写根不得含主根（隔离承诺）：${wrap!.args.join(' ')}`);
  } finally {
    configureLandlockLoader(null);
    resetLandlockProbe();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
