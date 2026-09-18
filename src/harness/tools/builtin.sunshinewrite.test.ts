import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';
import { SafetyChain } from '../security/chain';
import { DryRun } from '../security/dryrun';
import { builtinTools } from './builtin';

/**
 * `write` 命中项目根 SUNSHINE.md 时观察行补「快照过期」回执（规格 §9.3）：
 * ①写 <root>/SUNSHINE.md → 观察行含 written 且含快照过期句子；
 * ②子目录同名文件 sub/SUNSHINE.md → 观察行逐字节 'written'（不触发）；
 * ③回执不携带 SUNSHINE.md 正文片段（同轮不追加全文块，全文留待下一轮起点由 §9.2 漂移检测统一尾追）；
 * ④root 经符号链接传入（POSIX）→ 判据走 dataDirReal 归一仍触发（防符号链接漏报）；
 * ⑤普通文件 → 观察行逐字节 'written'（旧行为不变）。
 * 范式：tmpdir 作 root；断言只看观察行，数据目录不参与本面。
 */

const STALE_NOTICE = 'SUNSHINE.md rewritten — session snapshot is stale until the next refresh point';

/** 普通文本文件内容（③用：断言回执不携带正文片段） */
const FILE_BODY = ['line-one-unique-marker', 'line-two-unique-marker', ''].join('\n');

async function withRegistry(
  fn: (ctx: { registry: ToolRegistry; safety: SafetyChain; root: string }) => Promise<void>,
  rootOverride?: string,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-write-sunshine-'));
  try {
    const realRoot = path.join(tmp, 'real-root');
    fs.mkdirSync(realRoot, { recursive: true });
    const root = rootOverride ?? realRoot;
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, root)) registry.register(t);
    await fn({ registry, safety, root });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 执行 write 并解包 Result（非 ok 直接断言失败并带出错误信息） */
async function writeAndUnwrap(registry: ToolRegistry, safety: SafetyChain, input: { path: string; content: string }) {
  const r = await registry.execute('write', input, safety);
  assert.ok(r.ok, `write must succeed, got: ${r.ok ? '' : r.error.code + ': ' + r.error.message}`);
  return r.value;
}

test('§9.3①：写项目根 SUNSHINE.md → 观察行含 written 且含快照过期句（英文单语）', async () => {
  await withRegistry(async ({ registry, safety }) => {
    const out = await writeAndUnwrap(registry, safety, { path: 'SUNSHINE.md', content: FILE_BODY });
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /^written/);
    assert.ok(out.stdout.includes(STALE_NOTICE), `observation must carry stale notice, got: ${out.stdout}`);
  });
});

test('§9.3②：子目录同名 sub/SUNSHINE.md → 观察行逐字节 written（不触发）', async () => {
  await withRegistry(async ({ registry, safety, root }) => {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    const out = await writeAndUnwrap(registry, safety, { path: path.join(root, 'sub', 'SUNSHINE.md'), content: FILE_BODY });
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, 'written');
  });
});

test('§9.3③：回执不携带 SUNSHINE.md 正文片段（同轮不追加全文块）', async () => {
  await withRegistry(async ({ registry, safety }) => {
    const out = await writeAndUnwrap(registry, safety, { path: 'SUNSHINE.md', content: FILE_BODY });
    assert.equal(out.exitCode, 0);
    assert.ok(!out.stdout.includes('line-one-unique-marker'), 'observation must not inline the rewritten body');
    assert.ok(!out.stdout.includes('line-two-unique-marker'), 'observation must not inline the rewritten body');
  });
});

test('§9.3④：root 经符号链接传入（POSIX）→ 仍触发补句（dataDirReal 归一防漏报）', async () => {
  if (process.platform === 'win32') return; // symlink 需要特权，用例按既有惯例 POSIX-only
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-write-sunshine-link-'));
  try {
    const realRoot = path.join(tmp, 'real-root');
    fs.mkdirSync(realRoot, { recursive: true });
    const linkRoot = path.join(tmp, 'link-root');
    fs.symlinkSync(realRoot, linkRoot, 'dir');
    await withRegistry(async ({ registry, safety }) => {
      const out = await writeAndUnwrap(registry, safety, { path: 'SUNSHINE.md', content: FILE_BODY });
      assert.equal(out.exitCode, 0);
      assert.match(out.stdout, /^written/);
      assert.ok(out.stdout.includes(STALE_NOTICE), `symlinked root must still trigger stale notice, got: ${out.stdout}`);
    }, linkRoot);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('§9.3⑤：普通文件 → 观察行逐字节 written（旧行为不变）', async () => {
  await withRegistry(async ({ registry, safety, root }) => {
    const out = await writeAndUnwrap(registry, safety, { path: path.join(root, 'notes.md'), content: FILE_BODY });
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, 'written');
  });
});
