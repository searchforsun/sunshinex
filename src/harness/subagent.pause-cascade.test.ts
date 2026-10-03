import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRegistry, SubagentRunner } from './subagent';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { TaskRegistry } from './tasks';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 挂起适配器：模型调用永挂直至外部 signal 中止——子代理执行中的「长任务」替身 */
class HangingAdapter implements ModelAdapter {
  readonly provider = 'hanging';
  lastSignal?: AbortSignal;
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.lastSignal = req.signal;
    const signal = req.signal;
    return new Promise((_, reject) => {
      if (signal?.aborted) return reject(new Error('interrupted'));
      signal?.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
    });
  }
}

function makeRunner(model: ModelAdapter, tmp: string, opts?: { tasks?: TaskRegistry }): SubagentRunner {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(path.join(tmp, '.data')));
  const reg = new AgentRegistry();
  reg.registerBuiltins();
  return new SubagentRunner({ registry, safety, context, model, ...(opts?.tasks ? { tasks: opts.tasks } : {}) }, reg);
}

test('子代理级联：父中断信号接入前台 spawn——父 abort 即刻中止子代理（2026-10-02 两次 Ctrl+C 暂停语义）', async () => {
  const tmp = tmpdir('sunshinex-cascade1-');
  try {
    const childModel = new HangingAdapter();
    const runner = makeRunner(childModel, tmp);
    const parent = new AbortController();
    runner.attachParent(() => ({ maxSteps: 50 }), parent.signal);
    const r = runner.runSubagent({ prompt: 'long child task' });
    await waitFor(() => childModel.lastSignal !== undefined, 3000); // 子代理模型调用已发起
    assert.equal(childModel.lastSignal!.aborted, false, '父未中断时子代理正常运行');
    parent.abort(); // 主任务暂停（interrupt() 的 abort）
    const result = await r;
    assert.equal(result.ok, false, '子代理随父中断停下（不跑完不悬挂）');
    assert.ok(childModel.lastSignal!.aborted, '子代理在途模型调用已贯通 abort');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('子代理级联：显式 opts.signal 优先于父信号（后台两段式路径语义不变）', async () => {
  const tmp = tmpdir('sunshinex-cascade2-');
  try {
    const childModel = new HangingAdapter();
    const runner = makeRunner(childModel, tmp);
    runner.attachParent(() => ({ maxSteps: 50 })); // 不带父 signal
    const local = new AbortController(); // 显式信号（后台两段式形态）
    const r = runner.runSubagent({ prompt: 'long child task' }, { signal: local.signal });
    await waitFor(() => childModel.lastSignal !== undefined, 3000);
    assert.equal(childModel.lastSignal!.aborted, false, '未中止时子代理正常运行');
    local.abort();
    const result = await r;
    assert.equal(result.ok, false, '显式信号中止子代理（优先通道不回归）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('子代理级联：父中断信号接入后台 spawn——主任务暂停连带后台子代理 failed', async () => {
  const tmp = tmpdir('sunshinex-cascade3-');
  try {
    const tasksDir = path.join(tmp, 'tasks');
    const tasks = new TaskRegistry(tasksDir);
    const childModel = new HangingAdapter();
    const runner = makeRunner(childModel, tmp, { tasks });
    const parent = new AbortController();
    runner.attachParent(() => ({ maxSteps: 50 }), parent.signal);
    const started = runner.spawnBackground({ prompt: 'background child task' });
    await waitFor(() => tasks.get(started.taskId)?.status !== undefined, 3000);
    await waitFor(() => childModel.lastSignal !== undefined, 3000); // 后台子代理已开跑
    parent.abort(); // 主任务暂停 → 后台任务连带 stop
    await waitFor(() => tasks.get(started.taskId)?.status === 'failed', 5000);
    assert.equal(tasks.get(started.taskId)!.status, 'failed', '后台子代理随父暂停进入失败终态（不遗留孤儿在跑）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('后台 spawn 账本 label 业务化：input.label 优先（/tasks 业务列与 id 业务段的语义源，2026-10-03 用户实据「两行同显 subagent」）', async () => {
  const tmp = tmpdir('sunshinex-bglbl-');
  try {
    const tasks = new TaskRegistry(path.join(tmp, 'data'));
    const runner = makeRunner(new HangingAdapter(), tmp, { tasks });
    const r = runner.spawnBackground({ label: 'Web层服务与数据访问分析', prompt: '分析' });
    const task = tasks.get(r.taskId);
    assert.ok(task, '账本登记在案');
    assert.equal(task!.label, 'Web层服务与数据访问分析', 'input.label 优先（旧口径 agent_id ?? subagent 忽略 label）');
    // 混合脚标签保留 ASCII 段做业务助记（'Web层服务…' → 'web'）；纯 CJK（无任何字母数字）才回退 kind
    assert.match(task!.id, /^web-\d{8}T\d{6}Z-[a-z0-9]{4}$/, 'id 业务段=ASCII 段 slug + UTC 时间段 + 随机段');
    task!.stop?.();
    await waitFor(() => tasks.get(r.taskId)?.status !== 'running', 5000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
