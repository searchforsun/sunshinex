import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { ProcessSandbox } from '../security/sandbox';
import { SafetyChain } from '../security/chain';
import { DryRun } from '../security/dryrun';
import { builtinTools } from './builtin';

/** 工具路径基准稳定性：所有文件类工具与 exec 均以 root 为基准，与进程 cwd 无关 */
function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-stab-'));
}

function registryWith(root: string): { registry: ToolRegistry; safety: SafetyChain } {
  const safety = new SafetyChain(new SecurityGuard(undefined, 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  // dontAsk：最大权限，验证工具执行链本身而非权限拦截
  return { registry, safety };
}

test('read 以 root 为基准读取（不受进程 cwd 影响）', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.txt'), 'root-content');
  const { registry, safety } = registryWith(root);

  const r = await registry.execute('read', { path: 'a.txt' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.stdout, 'root-content');
});

test('write 以 root 为基准写入（不落到进程 cwd）', async () => {
  const root = tmpdir();
  const { registry, safety } = registryWith(root);

  const r = await registry.execute('write', { path: 'sub/out.txt', content: 'hi' }, safety);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'out.txt'), 'utf8'), 'hi');
});

test('exec 的 shell 工作目录为 root', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'marker.txt'), 'm');
  const { registry, safety } = registryWith(root);

  const r = await registry.execute('exec', { command: 'ls marker.txt' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.stdout, /marker\.txt/);
});

test('glob 以 root 为基准并返回相对路径', async () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'x', 'b.ts'), '');
  fs.writeFileSync(path.join(root, 'a.ts'), '');
  const { registry, safety } = registryWith(root);

  const r = await registry.execute('glob', { pattern: '**/*.ts' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) {
    const files = r.value.stdout.split('\n').filter(Boolean);
    assert.ok(files.includes('a.ts'), `应含 a.ts，实际 ${files.join(',')}`);
    assert.ok(files.includes(path.join('x', 'b.ts')));
  }
});

test('多步连续工具调用（读→写→读→exec）链路稳定', async () => {
  const root = tmpdir();
  const { registry, safety } = registryWith(root);

  const w = await registry.execute('write', { path: 'n.txt', content: '42' }, safety);
  assert.equal(w.ok, true);
  const r1 = await registry.execute('read', { path: 'n.txt' }, safety);
  assert.equal(r1.ok, true);
  if (r1.ok) assert.equal(r1.value.stdout, '42');
  const e = await registry.execute('exec', { command: 'cat n.txt' }, safety);
  assert.equal(e.ok, true);
  if (e.ok) assert.match(e.value.stdout, /42/);
});

test('read 落点跟随安全链 root（safePath 消费自 evaluate）', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-roota-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-rootb-'));
  fs.writeFileSync(path.join(dirA, 'in-a.txt'), 'A-content');
  const safety = new SafetyChain(new SecurityGuard(undefined, 'dontAsk'), new ProcessSandbox(), new DryRun(), dirA);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, dirB)) registry.register(t);
  const r = await registry.execute('read', { path: 'in-a.txt' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.stdout, 'A-content');
});

test('read 越界路径经 execute 被拦截（COMMAND_DENIED）', async () => {
  const root = tmpdir();
  const { registry, safety } = registryWith(root);
  const r = await registry.execute('read', { path: '../outside.txt' }, safety);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'COMMAND_DENIED');
    assert.match(r.error.message, /越出项目 root/);
  }
});
