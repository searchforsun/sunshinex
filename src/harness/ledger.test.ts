import { textReplyToChatFace } from '../model/chat-stub';
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
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter } from '../model/adapter';

function makeReactor(tmp: string, adapter: ModelAdapter): Reactor {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: adapter, ledger: new RunLedger(store) });
}

function scripted(replies: string[]): ModelAdapter {
  let call = 0;
  return { provider: 'scripted', chat: textReplyToChatFace(async () => replies[Math.min(call++, replies.length - 1)] )};
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
    assert.equal(entry.route?.tier, 'medium', '路由决策应随账落盘（无 hint 缺省 medium，路由已摘自动换档）');
    assert.ok(entry.durationMs >= 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Harness 装配：缺省注入账本，run 后 summary 可见', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ledger4-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
  try {
    const h = new Harness({ root: tmp, model: scripted(['{"done":true,"reply":"ok"}']) });
    await h.reactor.run({ goal: '装配验收' }, { maxSteps: 2 });
    assert.equal(h.ledger.summary().runs, 1);
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
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
      env: { ...process.env, SUNSHINEX_DATA_DIR: path.join(tmp, '.data') },
    });
    assert.equal(p.status, 0, `selfcheck 退出码 ${p.status}：${p.stderr}`);
    assert.match(p.stdout, /usage\s*:\s*\d+ runs\s*\/\s*\d+ tokens/, '应含 usage 汇总行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- O5：summary 增量化（缓存档 _summary；逐 id 全量重读 O(n) 随账本终身线性劣化收口） ----------

/** 读计数代理：run 条目文件读取次数即 O(n)/O(1) 的判据面（换回旧逐 id 实现即红） */
class CountingStore {
  runFileReads = 0;
  constructor(private inner: { read<T>(key: string, fallback: T): T; write<T>(key: string, value: T): void }) {}
  read<T>(key: string, fallback: T): T {
    if (key.startsWith('runs/run-')) this.runFileReads += 1;
    return this.inner.read(key, fallback);
  }
  write<T>(key: string, value: T): void {
    this.inner.write(key, value);
  }
}

test('O5：缓存在座时 summary 零 run 文件读取（O(1) 判别力锚——换回逐 id 全量重读即红）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ledger6-'));
  try {
    const counting = new CountingStore(new FileStore(path.join(tmp, '.data')));
    const ledger = new RunLedger(counting);
    ledger.record({ goal: 'a', done: true, steps: 1, tokensUsed: 30, durationMs: 5 });
    ledger.record({ goal: 'b', done: true, steps: 2, tokensUsed: 70, durationMs: 5 });
    counting.runFileReads = 0; // record 面读取不计,只量 summary
    assert.deepEqual(ledger.summary(), { runs: 2, tokens: 100 });
    assert.equal(counting.runFileReads, 0, '缓存命中:不逐 id 重读条目文件');
    // 再 record 一条走增量维护,summary 仍零读取且合计正确
    ledger.record({ goal: 'c', done: true, steps: 1, tokensUsed: 50, durationMs: 1 });
    counting.runFileReads = 0;
    assert.deepEqual(ledger.summary(), { runs: 3, tokens: 150 });
    assert.equal(counting.runFileReads, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('O5：旧档迁移（无 _summary）与半写自愈（缓存档 runs 不符）各一次性重算回填', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ledger7-'));
  try {
    const store = new FileStore(path.join(tmp, '.data'));
    // 旧档形态:index + 条目在座、无 _summary 缓存档
    store.write('runs/_index', ['run-old1', 'run-old2']);
    store.write('runs/run-old1', { tokensUsed: 40 });
    store.write('runs/run-old2', { tokensUsed: 60 });
    const ledger = new RunLedger(store);
    assert.deepEqual(ledger.summary(), { runs: 2, tokens: 100 }, '迁移:O(n) 重算出正确合计');
    assert.deepEqual(store.read<{ runs: number; tokens: number }>('runs/_summary', null as never), { runs: 2, tokens: 100 }, '回填缓存档');
    // 半写自愈:缓存档 runs 与索引长度不符 → 重算并修复
    store.write('runs/_summary', { runs: 99, tokens: 1 });
    assert.deepEqual(ledger.summary(), { runs: 2, tokens: 100 }, '校验面(索引长度)不符即重算自愈');
    assert.deepEqual(store.read<{ runs: number; tokens: number }>('runs/_summary', null as never), { runs: 2, tokens: 100 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
