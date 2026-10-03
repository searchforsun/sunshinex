import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BatchRunner } from './batch-runner';
import type { BatchEventEmit, BatchLedger } from './batch-runner';
import { ToolRegistry } from './tools';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import type { ToolCallSpec } from '../types';

// 测试卫生：数据目录钉文件私有目录（SafetyChain 装配读全局区，reactor 系测试同款先例）
process.env.SUNSHINEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-batch-data-'));
process.env.SUNSHINEX_USER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-batch-uskills-'));

/**
 * BatchRunner 单元钉（chatRound 抽件，普查 H5）：签名去重命中 / 串行条件 / 并发上限——
 * 三钉锚批次执行面自身语义（不经 Reactor 装配即可判别实现回归）；消息面与出牌消费回归由 reactor 系既有锚点覆盖。
 */

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

interface Fixture {
  runner: BatchRunner;
  ledger: BatchLedger;
  rows: string[];
  files: string[];
  events: { type: 'tool-call' | 'tool-result'; text: string; payload: Record<string, unknown> }[];
}

/** 装配桩：真实 registry/safety + 记账/事件收集口（emit 为旁路函数注入——抽出件不捕 Reactor 的可测性证明） */
function makeFixture(registry: ToolRegistry): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-batch-'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), tmp);
  const rows: string[] = [];
  const files: string[] = [];
  const events: { type: 'tool-call' | 'tool-result'; text: string; payload: Record<string, unknown> }[] = [];
  const emit: BatchEventEmit = (type, text, payload) => events.push({ type, text, payload });
  return {
    runner: new BatchRunner({ registry, safety, emit }),
    ledger: { resultRow: (o) => rows.push(o), trackFile: (p) => files.push(p) },
    rows,
    files,
    events,
  };
}

const call = (name: string, args: Record<string, unknown>): ToolCallSpec => ({ id: `c-${name}-${JSON.stringify(args)}`, name, argsJson: JSON.stringify(args) });

const parseArgs = (calls: ToolCallSpec[]): (Record<string, unknown> | null)[] =>
  calls.map((c) => JSON.parse(c.argsJson) as Record<string, unknown>);

/** 类别可控的执行探针（不发真实副作用；body 推迟到执行期运行） */
function probe(name: string, category: 'read' | 'bash', body: () => Promise<string>) {
  return { name, description: `test-only ${category} probe`, category, executor: async () => ({ exitCode: 0, stdout: await body(), stderr: '', timedOut: false }) };
}

test('签名去重命中：集合口径签名（与出牌顺序无关）第 3 次整批拒绝且跳过执行，换参即新签名照常执行', async () => {
  let execA = 0;
  let execB = 0;
  const registry = new ToolRegistry();
  registry.register(probe('probe_a', 'read', async () => `a-${++execA}`));
  registry.register(probe('probe_b', 'read', async () => `b-${++execB}`));
  const f = makeFixture(registry);
  const ab = [call('probe_a', { x: 1 }), call('probe_b', { y: 2 })];
  const ba = [ab[1], ab[0]]; // 同集合、出牌顺序翻转 → 集合口径下同签名
  await f.runner.runBatch({ calls: ab, argsOf: parseArgs(ab), step: 1, ledger: f.ledger });
  await f.runner.runBatch({ calls: ba, argsOf: parseArgs(ba), step: 2, ledger: f.ledger });
  await f.runner.runBatch({ calls: ab, argsOf: parseArgs(ab), step: 3, ledger: f.ledger });
  assert.equal(execA, 2, '首次 + 原样重试一次真实执行');
  assert.equal(execB, 2);
  assert.ok(
    f.rows.slice(4).every((o) => /Repeated identical batch rejected: this exact set of calls already ran 2 times and was skipped this round \(not executed\)/.test(o)),
    '第 3 次整批拒绝：现象观察行逐字节契约',
  );
  // 换参 = 集合不同 = 新签名：计数独立、照常执行（参数性复用不受牵连）
  const other = [call('probe_a', { x: 999 })];
  await f.runner.runBatch({ calls: other, argsOf: parseArgs(other), step: 4, ledger: f.ledger });
  assert.equal(execA, 3, '换参调用不受旧签名计数牵连');
  assert.equal(f.rows[6], 'a-3');
});

test('串行条件：批内含独占类（bash）即整批按出牌顺序串行；纯并行批（全 read 类）执行期重叠', async () => {
  // 场景一：bash 独占类混批 → 严格串行（前者完成后后者才开跑）
  const log1: string[] = [];
  const r1 = new ToolRegistry();
  r1.register(probe('state_tool', 'bash', async () => {
    log1.push('state:start');
    await sleep(40);
    log1.push('state:end');
    return 'state-ok';
  }));
  r1.register(probe('plain_tool', 'read', async () => {
    log1.push('plain:start');
    return 'plain-ok';
  }));
  const f1 = makeFixture(r1);
  const mixed = [call('state_tool', {}), call('plain_tool', {})];
  await f1.runner.runBatch({ calls: mixed, argsOf: parseArgs(mixed), step: 1, ledger: f1.ledger });
  assert.deepEqual(log1, ['state:start', 'state:end', 'plain:start'], '独占类在场：前者完成后后者才开跑（出牌顺序）');
  assert.deepEqual(f1.rows, ['state-ok', 'plain-ok'], '观察行按出牌顺序回发（role:tool 按位配对前提）');

  // 场景二：无独占类 → 整批并发（短调用在长调用执行期内开跑——误串行即本断言红）
  const log2: string[] = [];
  const r2 = new ToolRegistry();
  r2.register(probe('slow_p', 'read', async () => {
    log2.push('slow:start');
    await sleep(40);
    log2.push('slow:end');
    return 'slow-ok';
  }));
  r2.register(probe('fast_p', 'read', async () => {
    log2.push('fast:start');
    return 'fast-ok';
  }));
  const f2 = makeFixture(r2);
  const par = [call('slow_p', {}), call('fast_p', {})];
  await f2.runner.runBatch({ calls: par, argsOf: parseArgs(par), step: 1, ledger: f2.ledger });
  assert.ok(log2.indexOf('fast:start') < log2.indexOf('slow:end'), '纯并行批：fast 在 slow 执行期内开跑（整批并发）');
});

test('并发上限：批规模超 PARALLEL_TOOLS_LIMIT(16) 整批拒绝零执行，边界 16 照常放行', async () => {
  let exec = 0;
  const registry = new ToolRegistry();
  registry.register(probe('cap_probe', 'read', async () => `cap-${++exec}`));
  const f = makeFixture(registry);
  const over = Array.from({ length: 17 }, (_, i) => call('cap_probe', { i }));
  await f.runner.runBatch({ calls: over, argsOf: parseArgs(over), step: 1, ledger: f.ledger });
  assert.equal(exec, 0, '超上限整批跳过实际执行');
  assert.equal(f.rows.length, 17, '逐调用回写拒绝观察行');
  assert.ok(
    f.rows.every((o) => o.includes('Parallel batch rejected: exceeds the limit of 16 tools; use fewer calls per round')),
    '拒绝行逐字节契约（上限常量同源拼装）',
  );
  assert.equal(f.events.filter((e) => e.type === 'tool-call').length, 17, '拒绝路径同样先发 tool-call 挂起预告（TUI 实时性契约）');

  const boundary = Array.from({ length: 16 }, (_, i) => call('cap_probe', { i }));
  await f.runner.runBatch({ calls: boundary, argsOf: parseArgs(boundary), step: 2, ledger: f.ledger });
  assert.equal(exec, 16, '边界规模（=上限）照常执行');
});
