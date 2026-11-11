import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WriteSnapshotCollector, makeWriteSnapshotSink } from './write-snapshot';
import { builtinTools } from './builtin';
import { ToolRegistry } from '../tools';
import { SafetyChain } from '../security/chain';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'write-snap-'));
}
function makeSafety(root: string): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
}
function registry(root: string, sink?: ReturnType<typeof makeWriteSnapshotSink>): { registry: ToolRegistry; safety: SafetyChain } {
  const safety = makeSafety(root);
  const r = new ToolRegistry();
  for (const t of builtinTools(safety, root, { writeSnapshot: sink })) r.register(t);
  return { registry: r, safety };
}

test('captureRooted: 存在文件 → hash 条目 + blob 内容寻址落盘', () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    const blobs = path.join(root, 'blobs');
    const c = new WriteSnapshotCollector(blobs);
    c.captureRooted(path.join(root, 'a.txt'), 'a.txt');
    const entries = c.drain();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'a.txt');
    assert.equal(entries[0].deleted, undefined);
    assert.equal(fs.readFileSync(path.join(blobs, entries[0].hash)).toString(), 'hello');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureRooted: 不存在文件 → deleted 条目且无 blob', () => {
  const root = tmp();
  try {
    const blobs = path.join(root, 'blobs');
    const c = new WriteSnapshotCollector(blobs);
    c.captureRooted(path.join(root, 'nope.txt'), 'nope.txt');
    assert.deepEqual(c.drain(), [{ path: 'nope.txt', hash: '', deleted: true }]);
    assert.equal(fs.existsSync(blobs), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureRooted: 同文件两次捕获 → 两条目 + blob 各自单份', () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'v1');
    const blobs = path.join(root, 'blobs');
    const c = new WriteSnapshotCollector(blobs);
    c.captureRooted(path.join(root, 'a.txt'), 'a.txt');
    fs.writeFileSync(path.join(root, 'a.txt'), 'v2');
    c.captureRooted(path.join(root, 'a.txt'), 'a.txt');
    assert.equal(c.drain().length, 2);
    assert.equal(fs.readdirSync(blobs).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('makeWriteSnapshotSink: 相对路径按 root 解析、root 外跳过', () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'b.txt'), 'old');
    const sink = makeWriteSnapshotSink(path.join(root, 'data'), root);
    sink.capture('b.txt');
    assert.equal(sink.drain().length, 1);
    sink.capture('/etc/hostname');
    assert.equal(sink.drain().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('builtin write 执行后 sink 收到 pre-image（full-access 免审批直写）', async () => {
  const root = tmp();
  try {
    const sink = makeWriteSnapshotSink(path.join(root, 'data'), root);
    const { registry: reg, safety } = registry(root, sink);
    fs.writeFileSync(path.join(root, 'b.txt'), 'old');
    await reg.execute('write', { path: 'b.txt', content: 'new' }, safety);
    const entries = sink.drain();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'b.txt');
    assert.equal(fs.readFileSync(path.join(root, 'data', 'sessions', '_blobs', entries[0].hash)).toString(), 'old');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 每次改动的后像快照（2026-11-11 用户裁定「不兼容旧会话，就是读快照」）：write/edit 落盘后
 *  captureAfter 把新内容落库挂 afterHash——/diff 查询面读冻结前后像，不再读现盘 */
test('captureAfter: 同路径末尾条目挂 afterHash + blob 落库;多次写各挂各刀', () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'v1');
    const blobs = path.join(root, 'blobs');
    const c = new WriteSnapshotCollector(blobs);
    c.captureRooted(path.join(root, 'a.txt'), 'a.txt');
    c.attachAfterRooted('a.txt', 'v2');
    c.captureRooted(path.join(root, 'a.txt'), 'a.txt');
    c.attachAfterRooted('a.txt', 'v3');
    const entries = c.drain();
    assert.equal(entries.length, 2);
    assert.equal(fs.readFileSync(path.join(blobs, entries[0].hash)).toString(), 'v1');
    assert.equal(entries[0].afterHash !== undefined && fs.readFileSync(path.join(blobs, entries[0].afterHash)).toString(), 'v2');
    assert.equal(entries[1].afterHash !== undefined && fs.readFileSync(path.join(blobs, entries[1].afterHash)).toString(), 'v3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureAfter: 无匹配条目（root 外 capture 被跳过）静默不挂', () => {
  const root = tmp();
  try {
    const blobs = path.join(root, 'blobs');
    const c = new WriteSnapshotCollector(blobs);
    c.attachAfterRooted('ghost.txt', 'x');
    assert.deepEqual(c.drain(), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('builtin write 执行后 captureAfter 落后像（sink 端到端:hash=old/afterHash=new）', async () => {
  const root = tmp();
  try {
    const sink = makeWriteSnapshotSink(path.join(root, 'data'), root);
    const { registry: reg, safety } = registry(root, sink);
    fs.writeFileSync(path.join(root, 'b.txt'), 'old');
    await reg.execute('write', { path: 'b.txt', content: 'new' }, safety);
    const entries = sink.drain();
    const blobs = path.join(root, 'data', 'sessions', '_blobs');
    assert.equal(fs.readFileSync(path.join(blobs, entries[0].hash)).toString(), 'old');
    assert.ok(entries[0].afterHash !== undefined && entries[0].afterHash.length > 0, 'afterHash 在场');
    assert.equal(fs.readFileSync(path.join(blobs, entries[0].afterHash!)).toString(), 'new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tagCall/byCall: 每刀快照按 callId 回标直取(2026-11-11);失败调用不夺标', () => {
  const root = tmp();
  try {
    const sink = makeWriteSnapshotSink(path.join(root, 'data'), root);
    fs.writeFileSync(path.join(root, 'c.txt'), 'v0');
    // 第一刀(生产序:捕获→回执回标后才可能有同路径第二刀——批次面同路径链队串行)
    sink.capture('c.txt');
    sink.captureAfter('c.txt', 'v1');
    sink.tagCall('c.txt', 'step:1-idx:0');
    // 第二刀(同文件再改;先模拟第一刀落盘——captureAfter 只落 blob 不写盘)
    fs.writeFileSync(path.join(root, 'c.txt'), 'v1');
    sink.capture('c.txt');
    sink.captureAfter('c.txt', 'v2');
    assert.equal(sink.byCall('step:1-idx:0')?.afterHash !== undefined, true);
    const first = sink.byCall('step:1-idx:0')!;
    assert.equal(sink.readBlob(first.hash)?.toString(), 'v0', '第一刀前像=v0');
    assert.equal(sink.readBlob(first.afterHash!)?.toString(), 'v1', '第一刀后像=v1(互不漂移)');
    // 第二刀成功回标
    sink.tagCall('c.txt', 'step:2-idx:0');
    const second = sink.byCall('step:2-idx:0')!;
    assert.notEqual(second.hash, first.hash, '两刀前像互异');
    assert.equal(sink.readBlob(second.hash)?.toString(), 'v1', '第二刀前像=第一刀后像');
    assert.equal(sink.readBlob(second.afterHash!)?.toString(), 'v2');
    // 失败调用(edit 未命中,无捕获)不夺标:末尾条目已标即返回
    sink.tagCall('c.txt', 'step:3-idx:0');
    assert.equal(sink.byCall('step:3-idx:0'), undefined);
    assert.equal(sink.byCall('step:2-idx:0')?.callId, 'step:2-idx:0', '已标条目不被复标');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
