import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunLedger } from './ledger';
import { Reactor } from './reactor';
import { Harness } from './index';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter } from '../model/adapter';

function makeReactor(tmp: string, adapter: ModelAdapter): Reactor {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: adapter, ledger: new RunLedger(store) });
}

function scripted(replies: string[]): ModelAdapter {
  let call = 0;
  return { provider: 'scripted', complete: async () => replies[Math.min(call++, replies.length - 1)] };
}

test('record：聚合条目落 runs/<id>，id/createdAt 自动补齐', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ledger1-'));
  try {
    const store = new FileStore(path.join(tmp, '.data'));
    const ledger = new RunLedger(store);
    const id = ledger.record({ goal: '对账', done: true, steps: 2, tokensUsed: 120, route: { tier: 'small', reason: 'complexity:low' }, durationMs: 45 });
    const entry = store.read<{ id: string; goal: string; tokensUsed: number; createdAt: string }>(`runs/${id}`, null as never);
    assert.equal(entry.id, id);
    assert.equal(entry.goal, '对账');
    assert.equal(entry.tokensUsed, 120);
    assert.ok(entry.createdAt, 'createdAt 应自动补齐');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('summary：聚合条数与 token 合计；空账本零值不抛', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ledger2-'));
  try {
    const store = new FileStore(path.join(tmp, '.data'));
    const ledger = new RunLedger(store);
    assert.deepEqual(ledger.summary(), { runs: 0, tokens: 0 }, '空账本应返回零值');
    ledger.record({ goal: 'a', done: true, steps: 1, tokensUsed: 30, durationMs: 5 });
    ledger.record({ goal: 'b', done: false, steps: 3, tokensUsed: 70, durationMs: 9 });
    assert.deepEqual(ledger.summary(), { runs: 2, tokens: 100 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Reactor 集成：run 收尾自动落账（tokens/route/duration 随 run 聚合）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ledger3-'));
  try {
    const reactor = makeReactor(tmp, scripted(['{"done":true,"reply":"ok"}']));
    const r = await reactor.run({ goal: '记账验收' }, { maxSteps: 2 });
    assert.equal(r.done, true);
    const store = new FileStore(path.join(tmp, '.data'));
    const ledger = new RunLedger(store);
    const s = ledger.summary();
    assert.equal(s.runs, 1, '一次 run 应落一条账');
    assert.ok(s.tokens >= 0);
    const index = store.read<string[]>('runs/_index', []);
    const entry = store.read<{ goal: string; done: boolean; steps: number; route?: { tier: string; reason: string }; durationMs: number }>(`runs/${index[0]}`, null as never);
    assert.equal(entry.goal, '记账验收');
    assert.equal(entry.done, true);
    assert.equal(entry.steps, 0, '首轮即完成、无工具步，steps 为 0');
    assert.equal(entry.route?.tier, 'small', '复杂度路由决策应随账落盘');
    assert.ok(entry.durationMs >= 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Harness 装配：缺省注入账本，run 后 summary 可见', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ledger4-'));
  try {
    const h = new Harness({ root: tmp, model: scripted(['{"done":true,"reply":"ok"}']) });
    await h.reactor.run({ goal: '装配验收' }, { maxSteps: 2 });
    assert.equal(h.ledger.summary().runs, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('selfcheck 输出 usage 汇总行（空账本显示 0 runs 不崩溃）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ledger5-'));
  try {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const p = spawnSync(process.execPath, [path.join(repoRoot, 'dist', 'cli', 'index.js'), 'selfcheck'], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(p.status, 0, `selfcheck 退出码 ${p.status}：${p.stderr}`);
    assert.match(p.stdout, /usage\s*:\s*\d+ runs\s*\/\s*\d+ tokens/, '应含 usage 汇总行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
