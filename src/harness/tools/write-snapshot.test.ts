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
import { DryRun } from '../security/dryrun';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'write-snap-'));
}
function makeSafety(root: string): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
}
function registry(root: string, sink?: ReturnType<typeof makeWriteSnapshotSink>): { registry: ToolRegistry; safety: SafetyChain } {
  const safety = makeSafety(root);
  const r = new ToolRegistry();
  for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sink)) r.register(t);
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

test('builtin write 执行后 sink 收到 pre-image（dontAsk 免审批直写）', async () => {
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
