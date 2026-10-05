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
import { ExternalCliExecutor, MAX_EXTERNAL_CONCURRENT } from './external-cli';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** fake sandbox(stub 对象注入构造):execBackground 捕获命令与回调返回递增 pid(首只 123,与既有断言兼容),
 *  onData/onExit 由测试手动驱动(分片喂预录行,含撕裂行);并发场景经 per-pid 回调表 exitPid 定向驱动;
 *  killBackground 记录被杀 pid(spawnedCount/maxInFlight 为并发信号量断言计数器,终审 Item 1) */
class FakeSandbox {
  readonly name = 'process';
  cmds: string[] = [];
  killed: number[] = [];
  throwOnSpawn: Error | undefined;
  throwOnKill: Error | undefined;
  /** spawn 时同步预喂的行(超时竞速用):deadline 已过的 run 其 0ms 定时器与 flush 后补喂存在亚毫秒竞速——
   *  预喂在定时器创建前同步完成,tokens 累计断言确定性 */
  feedOnSpawn: string | undefined;
  /** execBackground 发起计数(任意时刻在飞断言:spawned - exited ≤ MAX_EXTERNAL_CONCURRENT) */
  spawnedCount = 0;
  maxInFlight = 0;
  private inFlight = 0;
  private nextPid = 123;
  private procs = new Map<number, { onExit: (code: number) => void }>();
  onData: (chunk: string) => void = () => {};
  onExit: (code: number) => void = () => {};
  async execBackground(cmd: string, opts?: { onData?: (chunk: string) => void; onExit?: (code: number) => void }): Promise<{ ok: true; value: { pid: number } }> {
    this.cmds.push(cmd);
    this.spawnedCount += 1;
    if (this.throwOnSpawn !== undefined) throw this.throwOnSpawn;
    const pid = this.nextPid++;
    this.onData = opts?.onData ?? (() => {});
    this.onExit = opts?.onExit ?? (() => {});
    this.procs.set(pid, { onExit: this.onExit });
    if (this.feedOnSpawn !== undefined) opts?.onData?.(this.feedOnSpawn);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return { ok: true, value: { pid } };
  }
  /** 定向驱动某 pid 的 onExit(并发场景多进程并存,共享 latest 字段会串线) */
  exitPid(pid: number, code: number): void {
    const proc = this.procs.get(pid);
    if (proc === undefined) return;
    this.procs.delete(pid);
    this.inFlight -= 1;
    proc.onExit(code);
  }
  killBackground(pid: number): void {
    if (this.throwOnKill !== undefined) throw this.throwOnKill;
    this.killed.push(pid);
  }
}

interface FakeHarness {
  sandbox: FakeSandbox;
  events: SessionEvent[];
  finishes: unknown[][];
  submits: { kind: string; label: string }[];
  /** registry.submit 返回的台账对象(捕获引用供 ledgerTask.stop 断言,终审 Item 1) */
  ledgers: Array<{ id: string; kind: string; label: string; status: string; stop?: () => void }>;
}

function makeExecutor(): { exec: ExternalCliExecutor; h: FakeHarness } {
  const h: FakeHarness = { sandbox: new FakeSandbox(), events: [], finishes: [], submits: [], ledgers: [] };
  const registry = {
    submit: (input: { kind: 'exec' | 'subagent'; label: string }) => {
      h.submits.push({ kind: input.kind, label: input.label });
      const ledger = { id: 'ex1', kind: input.kind, label: input.label, status: 'running' as const };
      h.ledgers.push(ledger);
      return ledger;
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

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

test('stream-json 翻译:撕裂行缓冲、token/tool-call/tool-result 事件序、结论与 tokens、台账 done marker', async () => {
  const { exec, h } = makeExecutor();
  const p = exec.run({ id: 't1', title: 'A', spec: "do 'the' thing" }, { deadlineAt: Date.now() + 10_000 });
  await flush(); // 信号量在拉起前引入 await(终审 Item 1)——微任务冲刷后 fake 回调已注册再驱动
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
  await flush(); // 同上:信号量 await 后 fake 回调已注册
  h.sandbox.onData(JSON.stringify({ type: 'result', result: 'partial', usage: { output_tokens: 3, input_tokens: 4 } }) + '\n');
  h.sandbox.onExit(1);
  const r = await p;
  assert.deepEqual(r, { ok: false, reply: 'partial', tokens: 7 }, '结论在场但 exit 1 = failed');
  assert.deepEqual(h.finishes, [['ex1', 'failed']], '台账 finish failed(无 marker)');
});

test('超时路径:deadline 已过 → killBackground 被调 + failed + 已累计 tokens', async () => {
  const { exec, h } = makeExecutor();
  // result 行经 spawn 同步预喂(deadline 已过 → 0ms 定时器与事后补喂有亚毫秒竞速,预喂消除之)
  h.sandbox.feedOnSpawn = JSON.stringify({ type: 'result', result: 'late', usage: { output_tokens: 5, input_tokens: 6 } }) + '\n';
  const p = exec.run({ id: 't9', title: 'C', spec: 'c' }, { deadlineAt: Date.now() - 1 });
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

test('并发信号量:同时 3 个 run 在飞 ≤ MAX_EXTERNAL_CONCURRENT=2,第三者在首个 exit 后才发起(终审 Item 1)', async () => {
  const { exec, h } = makeExecutor();
  assert.equal(MAX_EXTERNAL_CONCURRENT, 2, '外部进程并发上限常量 = 2');
  const results = [
    exec.run({ id: 'ta', title: 'A', spec: 'a' }, { deadlineAt: Date.now() + 60_000 }),
    exec.run({ id: 'tb', title: 'B', spec: 'b' }, { deadlineAt: Date.now() + 60_000 }),
    exec.run({ id: 'tc', title: 'C', spec: 'c' }, { deadlineAt: Date.now() + 60_000 }),
  ];
  await flush();
  assert.equal(h.sandbox.spawnedCount, 2, '前两任务持槽拉起,第三者排队未发起');
  assert.equal(h.sandbox.cmds.length, 2);
  // 第一个进程 exit 0:持槽者收口释放槽位 → 排队者获槽才拉起(发起时点在 exit 之后)
  h.sandbox.exitPid(123, 0);
  await flush();
  assert.equal(h.sandbox.spawnedCount, 3, '首个 exit 后第三者才发起');
  assert.ok(h.sandbox.cmds[2]!.includes("-p 'c'"), `第三发起的是排队任务 tc,实际:${h.sandbox.cmds[2]}`);
  // 收尾:其余两进程退出,全部 run 终值落地(failed——exit 0 无 result 行无结论,与既有口径一致)
  h.sandbox.exitPid(124, 0);
  h.sandbox.exitPid(125, 0);
  const rs = await Promise.all(results);
  assert.equal(rs.length, 3, '三任务全部终值');
  // 任意时刻在飞 ≤ 2:fake 计数器峰值断言(发起-退出的在飞差全程不超上限)
  assert.ok(h.sandbox.maxInFlight <= MAX_EXTERNAL_CONCURRENT, `在飞峰值 ${h.sandbox.maxInFlight} ≤ ${MAX_EXTERNAL_CONCURRENT}`);
  assert.equal(h.finishes.length, 3, '三台账全部收口');
});

test('stop 接线:run 进行中 ledgerTask.stop → killBackground(pid);kill 失败吞不炸(终审 Item 1)', async () => {
  const { exec, h } = makeExecutor();
  const p = exec.run({ id: 't7', title: 'S', spec: 's' }, { deadlineAt: Date.now() + 60_000 });
  await flush();
  assert.equal(h.ledgers.length, 1, '登账恰一笔');
  assert.equal(typeof h.ledgers[0]!.stop, 'function', '台账 stop 句柄已挂(execBackground 返回 pid 后)');
  h.ledgers[0]!.stop!();
  assert.deepEqual(h.sandbox.killed, [123], 'stop 触发 killBackground(pid)');
  // kill 失败吞(进程已死 ESRCH 等):stop 不向上炸,可重复调
  h.sandbox.throwOnKill = new Error('kill ESRCH');
  assert.doesNotThrow(() => h.ledgers[0]!.stop!());
  assert.deepEqual(h.sandbox.killed, [123], 'kill 失败不再入账(task_stop 单点已兜底 finish)');
  // 收尾:exit 驱动 run 自然终值(迟到 exit 经 exit promise 收口)
  h.sandbox.exitPid(123, 0);
  const r = await p;
  assert.equal(r.ok, false, 'exit 0 无结论 = failed(口径不变)');
  assert.equal(h.finishes.length, 1);
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
