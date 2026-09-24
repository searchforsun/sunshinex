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
  // 命令形态方言无关（脚本文件承载）：断言的是工作目录落点，不该依赖宿主 shell 的引号/命令集语义
  fs.writeFileSync(path.join(root, 'cwd.js'), 'process.stdout.write(process.cwd())');
  const { registry, safety } = registryWith(root);

  const r = await registry.execute('exec', { command: 'node cwd.js' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(path.resolve(r.value.stdout.trim()), path.resolve(root), 'exec 须在 root 内执行');
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
    // glob 产物统一 / 分隔（跨平台一致，模型消费友好）
    assert.ok(files.includes('x/b.ts'), `应含 x/b.ts，实际 ${files.join(',')}`);
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
  // exec 侧以脚本文件读回（方言无关）：cat/ls 属 POSIX 命令集，Windows 无 Git Bash 时按 §14 不保证可用
  fs.writeFileSync(path.join(root, 'read-back.js'), "process.stdout.write(require('fs').readFileSync('n.txt', 'utf8'))");
  const e = await registry.execute('exec', { command: 'node read-back.js' }, safety);
  assert.equal(e.ok, true);
  if (e.ok) assert.match(e.value.stdout, /42/);
});

test('read 落点跟随安全链 root（safePath 消费自 evaluate）', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-roota-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-rootb-'));
  fs.writeFileSync(path.join(dirA, 'in-a.txt'), 'A-content');
  const safety = new SafetyChain(new SecurityGuard(undefined, 'manual'), new ProcessSandbox(), new DryRun(), dirA);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, dirB)) registry.register(t);
  const r = await registry.execute('read', { path: 'in-a.txt' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.stdout, 'A-content');
});

test('read 越界路径缺省放行（spec 5.1 读分支 D1：域外全放，fence 才收窄）', async () => {
  const root = tmpdir();
  const { registry, safety } = registryWith(root);
  const r = await registry.execute('read', { path: '../outside.txt' }, safety);
  assert.equal(r.ok, true);
});

test('read 支持 range 行段选择（L100-125 形态，1-based 闭区间，带行号回显）', async () => {
  const root = tmpdir();
  const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`);
  fs.writeFileSync(path.join(root, 'big.txt'), lines.join('\n'));
  const { registry, safety } = registryWith(root);

  const r = await registry.execute('read', { path: 'big.txt', range: 'L100-125' }, safety);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const out = r.value.stdout.split('\n');
  assert.equal(out.length, 26, '恰好 26 行（闭区间）');
  assert.equal(out[0], '100: line100', '首行带行号回显');
  assert.equal(out[25], '125: line125', '末行为区间止行');

  // L<n>≡L<n>-：从 n 行读到文件尾；L-<n>：读前 n 行
  const tail = await registry.execute('read', { path: 'big.txt', range: 'L198' }, safety);
  assert.ok(tail.ok && tail.value.stdout === '198: line198\n199: line199\n200: line200', 'L<n> 读到文件尾');
  const tailOpen = await registry.execute('read', { path: 'big.txt', range: 'L198-' }, safety);
  assert.ok(tailOpen.ok && tailOpen.value.stdout === '198: line198\n199: line199\n200: line200', 'L<n>- 与 L<n> 同义');
  const head = await registry.execute('read', { path: 'big.txt', range: 'L-2' }, safety);
  assert.ok(head.ok && head.value.stdout === '1: line1\n2: line2', 'L-<n> 读前 n 行');
});

test('read range 非法参数报 INVALID_ARG（非 L 形态 / 止行小于起行）', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\nb\nc');
  const { registry, safety } = registryWith(root);

  const bad = await registry.execute('read', { path: 'a.txt', range: '100-125' }, safety);
  assert.ok(!bad.ok && bad.error?.code === 'INVALID_ARG');
  const swapped = await registry.execute('read', { path: 'a.txt', range: 'L3-L1' }, safety);
  assert.ok(!swapped.ok && swapped.error?.code === 'INVALID_ARG');
});

test('read range 越界钳制（start 越界到 1、end 越界到文件尾），越界仍返回已有内容', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\nb\nc');
  const { registry, safety } = registryWith(root);

  const r = await registry.execute('read', { path: 'a.txt', range: 'L0-99' }, safety);
  assert.ok(r.ok && r.value.stdout === '1: a\n2: b\n3: c', '越界钳制到文件实际范围');
});

test('read range 完全越界（start 超文件行数）返回空内容但附 EOF 提示，不再静默空', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\nb\nc');
  const { registry, safety } = registryWith(root);

  const r = await registry.execute('read', { path: 'a.txt', range: 'L99999-100000' }, safety);
  assert.ok(r.ok, '完全越界不报错，钳制为空');
  assert.ok(r.value.stdout.includes('EOF'), `应附 EOF 提示而非静默空: ${JSON.stringify(r.value.stdout)}`);
});
