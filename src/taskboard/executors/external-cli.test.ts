import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionEvent } from '../../types';
import type { ProcessSandbox } from '../../harness/security/sandbox';
import type { TaskRegistry } from '../../harness/tasks';
import type { SubagentRunner } from '../../harness/subagent';
import { TaskBoard } from '../board';
import { TeamStore } from '../store';
import { ExternalCliExecutor } from './external-cli';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** fake sandbox(stub 对象注入构造):execBackground 捕获命令与回调返回 pid 123,
 *  onData/onExit 由测试手动驱动(分片喂预录行,含撕裂行);killBackground 记录被杀 pid */
class FakeSandbox {
  readonly name = 'process';
  cmds: string[] = [];
  killed: number[] = [];
  throwOnSpawn: Error | undefined;
  onData: (chunk: string) => void = () => {};
  onExit: (code: number) => void = () => {};
  async execBackground(cmd: string, opts?: { onData?: (chunk: string) => void; onExit?: (code: number) => void }): Promise<{ ok: true; value: { pid: number } }> {
    this.cmds.push(cmd);
    if (this.throwOnSpawn !== undefined) throw this.throwOnSpawn;
    this.onData = opts?.onData ?? (() => {});
    this.onExit = opts?.onExit ?? (() => {});
    return { ok: true, value: { pid: 123 } };
  }
  killBackground(pid: number): void {
    this.killed.push(pid);
  }
}

interface FakeHarness {
  sandbox: FakeSandbox;
  events: SessionEvent[];
  finishes: unknown[][];
  submits: { kind: string; label: string }[];
}

function makeExecutor(): { exec: ExternalCliExecutor; h: FakeHarness } {
  const h: FakeHarness = { sandbox: new FakeSandbox(), events: [], finishes: [], submits: [] };
  const registry = {
    submit: (input: { kind: 'exec' | 'subagent'; label: string }) => {
      h.submits.push({ kind: input.kind, label: input.label });
      return { id: 'ex1', kind: input.kind, label: input.label, status: 'running' as const };
    },
    finish: (...args: unknown[]) => { h.finishes.push(args); },
  } as unknown as TaskRegistry;
  const exec = new ExternalCliExecutor({
    sandbox: h.sandbox as unknown as ProcessSandbox,
    registry,
    onEvent: (e) => h.events.push(e),
  });
  return { exec, h };
}

test('stream-json 翻译:撕裂行缓冲、token/tool-call/tool-result 事件序、结论与 tokens、台账 done marker', async () => {
  const { exec, h } = makeExecutor();
  const p = exec.run({ id: 't1', title: 'A', spec: "do 'the' thing" }, { deadlineAt: Date.now() + 10_000 });
  // 预录行跨 chunk 撕裂:系统行(忽略)+ 文本段 + tool_use,前半/后半分两次喂
  const prefix = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file: 'x' } }] } }),
  ].join('\n') + '\n';
  const mid = Math.floor(prefix.length / 2);
  h.sandbox.onData(prefix.slice(0, mid));
  h.sandbox.onData(prefix.slice(mid));
  h.sandbox.onData(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }) + '\n');
  h.sandbox.onData('this line is not json\n'); // 解析失败行忽略(黑盒韧性)
  h.sandbox.onData(JSON.stringify({ type: 'result', result: 'all done', usage: { input_tokens: 30, output_tokens: 12 } }) + '\n');
  h.sandbox.onExit(0);
  const r = await p;
  assert.deepEqual(r, { ok: true, reply: 'all done', tokens: 42 }, 'exit 0 + 结论在场 = ok,tokens=input+output');
  assert.equal(h.sandbox.cmds[0], `claude -p 'do '\\''the'\\'' thing' --output-format stream-json`, 'spec POSIX 单引号转义,缺省命令 claude');
  assert.deepEqual(h.submits, [{ kind: 'exec', label: 'external-t1' }], '登账 external-<taskId>');
  assert.deepEqual(h.finishes, [['ex1', 'done', { marker: '[conclusion] all done\n' }]], '台账 finish done 带 conclusion marker');
  const translated = h.events.map((e) => `${e.type}:${e.text}`);
  assert.deepEqual(translated, [
    'token:hello ',
    'tool-call:Read',
    'tool-result:[{"type":"tool_result","content":"ok"}]',
  ], '翻译事件序:文本段→tool_use→tool_result(系统行/坏行零产出)');
  assert.equal(h.events[0]!.payload!.subagent, 'external-t1', 'token 事件带 subagent 标');
  assert.deepEqual(h.events[1]!.payload, { input: { file: 'x' }, callId: 'ext-1', subagent: 'external-t1' }, 'tool-call 载荷:input+自增 callId+subagent');
  assert.deepEqual(h.events[2]!.payload, { ok: true, callId: 'ext-1', subagent: 'external-t1' }, 'tool-result 与 tool_use 按发序 FIFO 配对 callId');
});

test('exit 非 0:结论在场仍 failed,台账 failed', async () => {
  const { exec, h } = makeExecutor();
  const p = exec.run({ id: 't5', title: 'B', spec: 'b' }, { deadlineAt: Date.now() + 10_000 });
  h.sandbox.onData(JSON.stringify({ type: 'result', result: 'partial', usage: { output_tokens: 3, input_tokens: 4 } }) + '\n');
  h.sandbox.onExit(1);
  const r = await p;
  assert.deepEqual(r, { ok: false, reply: 'partial', tokens: 7 }, '结论在场但 exit 1 = failed');
  assert.deepEqual(h.finishes, [['ex1', 'failed']], '台账 finish failed(无 marker)');
});

test('超时路径:deadline 已过 → killBackground 被调 + failed + 已累计 tokens', async () => {
  const { exec, h } = makeExecutor();
  const p = exec.run({ id: 't9', title: 'C', spec: 'c' }, { deadlineAt: Date.now() - 1 });
  h.sandbox.onData(JSON.stringify({ type: 'result', result: 'late', usage: { output_tokens: 5, input_tokens: 6 } }) + '\n');
  const r = await p; // 不驱动 onExit:exit 永不至,0ms 定时器让出事件循环后超时胜出
  assert.deepEqual(r, { ok: false, reply: 'external executor timed out', tokens: 11 }, '超时 failed,tokens 取已累计');
  assert.deepEqual(h.sandbox.killed, [123], 'killBackground(pid) 已调');
  assert.deepEqual(h.finishes, [['ex1', 'failed']], '台账 finish failed');
});

test('CLI 缺失:execBackground throw → unavailable 降级,tokens 0,台账 failed', async () => {
  const { exec, h } = makeExecutor();
  h.sandbox.throwOnSpawn = new Error('spawn claude ENOENT');
  const r = await exec.run({ id: 't2', title: 'D', spec: 'd' }, { deadlineAt: Date.now() + 5_000 });
  assert.deepEqual(r, { ok: false, reply: 'external executor unavailable: spawn claude ENOENT', tokens: 0 });
  assert.deepEqual(h.finishes, [['ex1', 'failed']]);
});

test('board 路由:executorHint external-cli 任务走注入执行体(delegation 对 kind external-cli + 强制回写)', async () => {
  const tmp = tmpdir('sunshinex-tb-ext-board-');
  try {
    const events: SessionEvent[] = [];
    const internalCalls: string[] = [];
    const externals: { task: { id: string; title: string; spec: string }; deadlineAt: number }[] = [];
    const externalExecutor = {
      run: async (task: { id: string; title: string; spec: string }, budget: { deadlineAt: number }) => {
        externals.push({ task, deadlineAt: budget.deadlineAt });
        if (task.id === 't2') return { ok: false, reply: 'boom', tokens: 0 };
        return { ok: true, reply: 'external reply', tokens: 7 };
      },
    };
    const runner = {
      runSubagent: async (_i: unknown, o?: { taskLine?: string }) => {
        internalCalls.push(o?.taskLine ?? '');
        return { ok: true as const, value: { reply: 'r', tokens: 1 } };
      },
    } as unknown as SubagentRunner;
    const registry = { submit: () => ({ id: 'b1', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry;
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner,
      registry,
      externalExecutor,
      onEvent: (e) => events.push(e),
    });
    board.init();
    assert.ok(board.create({ title: 'A', spec: 'a', executor: 'external-cli' }).ok);
    await drain();
    await drain();
    const s = board.snapshot();
    assert.equal(s.tasks['t1']!.status, 'in-review', '强制回写 claimed→in-review');
    assert.equal(s.tasks['t1']!.artifact?.conclusion, 'external reply');
    assert.equal(s.tasks['t1']!.artifact?.tokens, 7);
    assert.deepEqual(internalCalls, [], 'internal runner 零调用(external 路由接管)');
    assert.deepEqual(externals[0]!.task, { id: 't1', title: 'A', spec: 'a' }, '执行体收到自包含 task');
    assert.ok(externals[0]!.deadlineAt > Date.now(), '预算 deadline 未来(板超时换算)');
    const started = events.find((e) => e.type === 'delegation-started');
    assert.ok(started, 'delegation-started 已发');
    assert.deepEqual(started!.payload, { delegationId: 'task-t1', kind: 'external-cli', label: 'task-t1' });
    const ended = events.find((e) => e.type === 'delegation-ended');
    assert.ok(ended, 'delegation-ended 已发');
    assert.deepEqual(ended!.payload, { delegationId: 'task-t1', kind: 'external-cli', status: 'done', tokens: 7 });
    // 黑盒降级:stub 无翻译产出时 UI 仅见起止(无 token/tool-call 透传)
    assert.ok(!events.some((e) => e.type === 'token' || e.type === 'tool-call'), '公共面仅见起止');
    // 失败路径:EXTERNAL code 回写 + delegation-ended failed
    assert.ok(board.create({ title: 'B', spec: 'b', executor: 'external-cli' }).ok);
    await drain();
    await drain();
    assert.equal(board.snapshot().tasks['t2']!.status, 'failed');
    const note = events.find((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.status === 'failed');
    assert.ok(note, 'failed 状态事件已发');
    assert.ok(String((note!.payload as Record<string, unknown>).note).includes('execution failed: EXTERNAL: boom'), `note 带 EXTERNAL:boom,实际:${JSON.stringify(note!.payload)}`);
    const ended2 = events.filter((e) => e.type === 'delegation-ended');
    assert.ok(ended2.some((e) => (e.payload as Record<string, unknown>)?.status === 'failed' && (e.payload as Record<string, unknown>)?.delegationId === 'task-t2'), 't2 delegation-ended failed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const drain = (): Promise<void> => new Promise((r) => setImmediate(r));
