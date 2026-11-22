// 追加消息（2026-11-22 用户裁定「spawn 追加消息」）：resume 指向会话内已终态子智能体（label 或后台
// 任务 id）——新任务行尾追其累计步作种子续跑（复用上下文），不再 fork 新实例。
// 四面锁定：①前台续跑端到端（子代第二轮 prompt 含首轮任务+结论，边界行恰一次，主链两行结论行）；
// ②在飞拒绝（后台任务 running 期间 resume，label 与任务 id 双键）+ 终态后同键放行；
// ③未知名拒绝带可续跑清单；④dispatch_task resume 透传 + 后台两段式同步预检内联 fail-fast。
// 错误通道口径：后台 spawnBackground 预检失败=CodedToolError 抛出（提交前内联，模型当轮可换键重试）；
// 前台 runSubagent 失败=工具回执 exitCode 1（CONCURRENCY_LIMIT 同缝，直调 executor 无预算源故测后台路径）。
import { textReplyToChatFace } from '../model/chat-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { CodedToolError } from './tools';
import { makeDispatchTool, normalizeSpawnInput, SubagentRunner } from './subagent';
import type { ModelAdapter } from '../model/adapter';
import type { SubagentSpawnInput } from '../types';
import type { TaskRegistry } from './tasks';

/** 取 Harness 内部账本（装配贯通后恒存在） */
function ledgerOf(h: Harness): TaskRegistry {
  return (h as unknown as { tasks: TaskRegistry }).tasks;
}

/** 轮询判据（后台任务终态等待，确定性替代固定 sleep） */
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  for (let i = 0; i < ms / 10 && !cond(); i++) await new Promise((res) => setTimeout(res, 10));
  assert.ok(cond(), '条件超时未满足');
}

test('spawn 追加续跑端到端：resume 复用首轮累计步（首轮任务行+结论行进第二轮子代 prompt，边界行恰一次）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-resume-'));
  try {
    const prompts: string[] = [];
    let calls = 0;
    const model: ModelAdapter = {
      provider: 'probe',
      chat: textReplyToChatFace((prompt) => {
        prompts.push(prompt);
        calls++;
        if (calls === 1) return JSON.stringify({ done: true, reply: 'warmup done' }); // 预热轮：主链落行（非空），首派种子才含边界声明行
        if (calls === 2) return JSON.stringify({ tool: 'spawn', input: { prompt: 'round one: analyze foo module', label: 'w' } });
        if (calls === 3) return JSON.stringify({ done: true, reply: 'round one conclusion alpha' });
        if (calls === 4) return JSON.stringify({ tool: 'spawn', input: { prompt: 'round two: extend your previous conclusion', label: 'w', resume: 'w' } });
        if (calls === 5) return JSON.stringify({ done: true, reply: 'round two conclusion beta' });
        return JSON.stringify({ done: true, reply: 'main done' });
      }),
    };
    const h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false });
    const r1 = await h.reactor.run({ goal: 'warmup turn' }, { maxSteps: 4 });
    assert.equal(r1.done, true);
    const r = await h.reactor.run({ goal: 'main task' }, { maxSteps: 8 });
    assert.equal(r.done, true);
    // 第二轮子代 prompt（calls=5）= 首轮累计步 + 新任务行：首轮任务行、首轮结论闭合行、新任务行三者在场；
    // 边界声明行恰一次（首轮种子随累计步保留，追加轮不重注）
    const secondChild = prompts[4] ?? '';
    assert.ok(secondChild.includes('round one: analyze foo module'), '追加轮子代应见首轮任务行');
    assert.ok(secondChild.includes('round one conclusion alpha'), '追加轮子代应见首轮结论闭合行');
    assert.ok(secondChild.includes('round two: extend your previous conclusion'), '追加轮子代应见新任务行');
    assert.equal(
      (secondChild.match(/The session history above is background/g) ?? []).length,
      1,
      '边界声明行随首轮种子保留、追加轮不重复注入',
    );
    // 主链两行终态结论行（同一 label 两轮各一行）
    const chain = h.context.chainView();
    assert.ok(chain.some((s) => s.action === 'node' && s.observation.startsWith('[w] ') && s.observation.includes('round one conclusion alpha')), '首轮结论行入主链');
    assert.ok(chain.some((s) => s.action === 'node' && s.observation.startsWith('[w] ') && s.observation.includes('round two conclusion beta')), '追加轮结论行入主链');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('spawn 追加消息在飞拒绝：后台任务 running 期间 resume 回执 exitCode 1（label 与任务 id 双键），终态后同键放行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-resume-inflight-'));
  try {
    let gateResolve!: () => void;
    const gate = new Promise<void>((res) => {
      gateResolve = res;
    });
    let childCalls = 0;
    const model: ModelAdapter = {
      provider: 'probe',
      chat: textReplyToChatFace((prompt) => {
        if (prompt.includes('bg work')) {
          childCalls++;
          return gate.then(() => JSON.stringify({ done: true, reply: 'background child finished' }));
        }
        return Promise.resolve(JSON.stringify({ done: true, reply: 'unused' }));
      }),
    };
    const h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false });
    const spawn = h.tools.get('spawn');
    assert.ok(spawn, 'spawn 应已注册');
    // 直调 executor 无 reactor run 起止挂载——手动挂预算源（attachParent 同缝）：后台子智能体起跑必需
    // （缺预算源时后台任务登记后异步 fail-fast 'Subagent budget source not attached'，任务秒转 failed）
    h.runner.attachParent(() => ({ maxSteps: 64 }));
    const bg = (await spawn!.executor({ prompt: 'bg work', label: 'w', background: true })) as { exitCode: number; stdout: string };
    assert.equal(bg.exitCode, 0, '首派后台提交成功');
    const taskId = /^(\S+) started in background/.exec(bg.stdout)?.[1];
    assert.ok(taskId, '回执应携带动态任务 id');
    // 在飞期间按任务 id 追加 → 后台两段式同步预检拒绝（提交前内联 CodedToolError，台账零登记）
    await assert.rejects(
      spawn!.executor({ prompt: 'follow-up', resume: taskId!, label: 'w-follow', background: true }),
      (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_STATE' && e.message.includes('still running'),
    );
    assert.equal(ledgerOf(h).list().filter((t) => t.kind === 'subagent').length, 1, '预检拒绝不产生任务登记');
    // 按 label 追加同拒绝（双键在飞判据）
    await assert.rejects(
      spawn!.executor({ prompt: 'follow-up', resume: 'w', background: true }),
      (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_STATE',
    );
    gateResolve();
    await waitFor(() => ledgerOf(h).get(taskId!)?.status === 'done');
    assert.equal(childCalls, 1, '后台子智能体首派恰跑一轮');
    // 终态后同键（label）追加放行：两段式追加轮，任务日志带 [resume:w] 标记与结论行
    const append = (await spawn!.executor({ prompt: 'follow-up now that you finished', resume: 'w', label: 'w', background: true })) as { exitCode: number; stdout: string };
    assert.equal(append.exitCode, 0, `终态后追加应放行：${append.stdout}`);
    const appendTask = ledgerOf(h).list().find((t) => t.id !== taskId && t.kind === 'subagent');
    assert.ok(appendTask, '追加轮应登记新后台任务');
    await waitFor(() => ledgerOf(h).get(appendTask!.id)?.status === 'done');
    const appendLog = fs.readFileSync(appendTask!.outputFilePath, 'utf8');
    assert.ok(appendLog.includes('[spawn background] [resume:w]'), '追加轮任务日志应带 [resume:<键>] 标记');
    assert.ok(appendLog.includes('[conclusion] background child finished'), '追加轮结论落任务日志');
    assert.equal(childCalls, 2, '追加轮应实际续跑子代（非只登记）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('spawn 追加消息未知名：回执 exitCode 1 且提示可续跑清单（含首轮 label）；空会话提示 nothing has finished', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-resume-unknown-'));
  try {
    let calls = 0;
    const model: ModelAdapter = {
      provider: 'probe',
      chat: textReplyToChatFace(() => {
        calls++;
        if (calls === 1) return JSON.stringify({ tool: 'spawn', input: { prompt: 'first round', label: 'alpha' } });
        if (calls === 2) return JSON.stringify({ done: true, reply: 'first round conclusion' });
        return JSON.stringify({ done: true, reply: 'main done' });
      }),
    };
    const h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false });
    const spawn = h.tools.get('spawn');
    assert.ok(spawn, 'spawn 应已注册');
    // 空会话未知名：清单为空提示（后台两段式同步预检，提交前内联拒绝）
    await assert.rejects(
      spawn!.executor({ prompt: 'x', resume: 'ghost', background: true }),
      (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG' && e.message.includes('nothing has finished'),
    );
    // 跑完一轮后：未知名提示应列出可续跑键（首轮 label）
    await h.reactor.run({ goal: 'main task' }, { maxSteps: 6 });
    await assert.rejects(
      spawn!.executor({ prompt: 'x', resume: 'ghost', background: true }),
      (e: unknown) => {
        assert.ok(e instanceof CodedToolError && e.code === 'INVALID_ARG');
        assert.ok(e.message.includes('resumable: alpha'), `错误应带可续跑清单：${(e as Error).message}`);
        return true;
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('dispatch_task resume：透传 forkDispatch（specInput.resume）；null 归一缺席；非字符串 INVALID_ARG；后台预检内联拒绝零登记', async () => {
  const calls: Array<{ input: SubagentSpawnInput }> = [];
  const stub = {
    validateSpawnInput: (raw: SubagentSpawnInput): void => {
      const i = normalizeSpawnInput(raw);
      if (!i.agent_id && !i.prompt) throw new CodedToolError('INVALID_ARG', 'agent_id and prompt are both missing');
    },
    spawnBackground: (input: SubagentSpawnInput) => {
      calls.push({ input });
      return { taskId: 'task-x-ts01-ab12', outputFilePath: path.join('tmp', 'x.log') };
    },
  } as unknown as SubagentRunner;
  const tool = makeDispatchTool(stub);
  const props = (tool.parameters?.properties ?? {}) as Record<string, unknown>;
  assert.ok(props.resume, 'dispatch_task schema 应有 resume 参数');
  const r = await tool.executor({ spec: 'next round spec', agent_id: null, label: 'w', resume: 'task-prev-01' });
  assert.equal(calls[0]!.input.resume, 'task-prev-01', 'resume 透传 spawnBackground（复用该执行体累计步续跑）');
  assert.match(r.stdout, /^task-x-ts01-ab12 started in background/);
  await tool.executor({ spec: 'fresh', resume: null });
  assert.equal(calls[1]!.input.resume, undefined, 'resume=null 归一缺席（新建一次性 worker）');
  await assert.rejects(
    tool.executor({ spec: 'x', resume: 42 }),
    (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG' && e.message.includes('resume must be a string'),
  );
  // 真装配后台两段式同步预检：未知名在提交任务前内联拒绝（台账零登记，模型当轮可换键重试）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-resume-precheck-'));
  try {
    const h = new Harness({ root: tmp, mode: 'full-access', model: { provider: 'probe', chat: textReplyToChatFace(() => JSON.stringify({ done: true, reply: 'idle' })) }, learnSkills: false });
    const spawn = h.tools.get('spawn');
    await assert.rejects(
      spawn!.executor({ prompt: 'x', background: true, resume: 'ghost' }),
      (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG' && e.message.includes('no finished subagent matched'),
    );
    assert.equal(ledgerOf(h).list().length, 0, '预检拒绝不产生任务登记');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
