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
import { guardMemoryWrite, MemoryWriteRequest, MemoryWriteSeam } from '../memory/writer';
import { resolveDataDir } from '../../config/data-dir';

/**
 * `write` 执行器 × 记忆写入接缝（规格 §4.4）：
 * ①零新增工具：builtinTools 清单与第 7 可选参引入前逐字节一致（两态同断言）
 * ②注入接缝 → 记忆路径走接缝（委派 + 透传 root/absPath/content/scope；观察行含 Saved memory；落盘归接缝所有）
 * ③未注入接缝 → 旧行为逐字节不变（观察行 written、内容不规范化）
 * ④接缝拒绝 → 工具侧带码错误且零落盘
 * ⑤不含 memory 依赖的既有工具行为不变（write 非记忆路径 / read / grep）
 * ⑥scope 透传：子代理链（withMemoryScope）写入落自身 agents/<id>，主目录仍拒
 * 范式：tmpdir 作 root + SUNSHINEX_DATA_DIR 重定向 + finally 还原清理；断言一律走 resolveDataDir(root)。
 */

const BUILTIN_NAMES = ['exec', 'read', 'skill', 'write', 'grep', 'glob', 'webfetch', 'websearch', 'kb_search', 'todo_write', 'worktree'];

const RAW = ['---', 'type: project', 'description: repo uses pnpm', '---', 'use pnpm only', ''].join('\n');

/** 桩接缝落盘内容（与规范化形态刻意不同：用来区分「委派给接缝」与「builtin 自行落盘」） */
const STUB_BODY = 'stub seam wrote this\n';

async function withRegistry(
  fn: (ctx: { registry: ToolRegistry; safety: SafetyChain; root: string; dataDir: string }) => Promise<void>,
  memory?: MemoryWriteSeam,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-write-seam-'));
  const prevDataDir = process.env.SUNSHINEX_DATA_DIR;
  const prevAuto = process.env.SUNSHINEX_AUTO_MEMORY;
  process.env.SUNSHINEX_DATA_DIR = tmp;
  delete process.env.SUNSHINEX_AUTO_MEMORY; // 缺省=开（记忆写窄口不是本文件断言面）
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, memory)) registry.register(t);
    await fn({ registry, safety, root, dataDir: resolveDataDir(root) });
  } finally {
    if (prevDataDir === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevDataDir;
    if (prevAuto === undefined) delete process.env.SUNSHINEX_AUTO_MEMORY;
    else process.env.SUNSHINEX_AUTO_MEMORY = prevAuto;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('零新增工具：第 7 可选参两态下 builtinTools 清单逐字节一致（spawn 由 harness 装配追加，不在此）', async () => {
  await withRegistry(async ({ registry }) => {
    assert.deepEqual(registry.list().map((t) => t.name), BUILTIN_NAMES, '未注入接缝＝旧清单');
  });
  await withRegistry(async ({ registry }) => {
    assert.deepEqual(registry.list().map((t) => t.name), BUILTIN_NAMES, '注入接缝后清单不变');
    assert.equal(registry.list().find((t) => t.name === 'write')?.description, 'Write file content', '工具描述零变化');
  }, guardMemoryWrite);
});

test('注入接缝：write 记忆路径走接缝（委派 + 透传接缝入参，观察行含 Saved memory；落盘由接缝自负）', async () => {
  const seen: MemoryWriteRequest[] = [];
  const spy: MemoryWriteSeam = (r) => {
    seen.push(r);
    // 测试桩自行落盘：接缝不再收落盘回调（落盘唯一点在真接缝的 MemoryStore.put）
    fs.mkdirSync(path.dirname(r.absPath), { recursive: true });
    fs.writeFileSync(r.absPath, STUB_BODY);
    return { ok: true, value: { slug: 'prefers-pnpm', kind: 'main', observation: 'Saved memory: prefers-pnpm (spy)' } };
  };
  await withRegistry(async ({ registry, safety, root, dataDir }) => {
    const absPath = path.join(dataDir, 'memory', 'prefers-pnpm.md');
    const r = await registry.execute('write', { path: absPath, content: RAW }, safety);
    assert.equal(r.ok, true, `委派接缝后应成功：${r.ok ? '' : r.error.message}`);
    if (r.ok) assert.equal(r.value.stdout, 'Saved memory: prefers-pnpm (spy)', '观察行取接缝回执，不再回写 written');
    assert.equal(seen.length, 1, '记忆路径恰好委派一次');
    assert.equal(seen[0].root, root, '透传装配 root');
    assert.equal(seen[0].absPath, absPath, '透传安全链归一后的 absPath');
    assert.equal(seen[0].content, RAW, '透传原文（校验在接缝内做）');
    assert.equal(seen[0].scope, undefined, '主链无 scope（undefined 而非 main）');
    assert.equal('write' in seen[0], false, '接缝请求不携带落盘回调（单一实现，无兼容面）');
    // 落盘结果断言（原「回调落到后端 writeFile」断言的口径变更）：盘面即桩落盘产物，真接缝的规范化盘面在下一用例钉住
    assert.equal(fs.readFileSync(absPath, 'utf8'), STUB_BODY, '委派后盘面内容来自接缝自身落盘');
  }, spy);
});

test('注入真接缝：记忆路径经校验→规范化→索引重建，观察行含 Saved memory 与 slug', async () => {
  await withRegistry(async ({ registry, safety, dataDir }) => {
    const absPath = path.join(dataDir, 'memory', 'prefers-pnpm.md');
    const r = await registry.execute('write', { path: absPath, content: RAW }, safety);
    assert.equal(r.ok, true, `记忆写入应成功：${r.ok ? '' : r.error.message}`);
    if (r.ok) assert.match(r.value.stdout, /^Saved memory: prefers-pnpm \[project\] — \d+\/200 index lines/);
    const raw = fs.readFileSync(absPath, 'utf8');
    assert.match(raw, /^---\ntype: project\ncreated: \d{4}-\d{2}-\d{2}\nmodified: \d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.readFileSync(path.join(dataDir, 'memory', 'MEMORY.md'), 'utf8'), '- prefers-pnpm — repo uses pnpm [project]\n');
  }, guardMemoryWrite);
});

test('未注入接缝：记忆路径＝旧行为逐字节不变（观察行 written、内容原样落盘）', async () => {
  await withRegistry(async ({ registry, safety, dataDir }) => {
    const absPath = path.join(dataDir, 'memory', 'prefers-pnpm.md');
    const r = await registry.execute('write', { path: absPath, content: RAW }, safety);
    assert.equal(r.ok, true, `窄口放行的记忆路径仍可裸写：${r.ok ? '' : r.error.message}`);
    if (r.ok) assert.equal(r.value.stdout, 'written', '旧观察行不变');
    assert.equal(fs.readFileSync(absPath, 'utf8'), RAW, '不经接缝即不规范化（旧行为逐字节）');
    assert.equal(fs.existsSync(path.join(dataDir, 'memory', 'MEMORY.md')), false, '旧行为不重建索引');
  });
});

test('接缝拒绝 → 工具侧带码错误且零落盘（CodedToolError 转译接缝错误码）', async () => {
  await withRegistry(async ({ registry, safety, dataDir }) => {
    const absPath = path.join(dataDir, 'memory', 'Bad_Slug.md');
    const r = await registry.execute('write', { path: absPath, content: RAW }, safety);
    assert.equal(r.ok, false, '非法 slug 应被接缝拒绝');
    if (!r.ok) assert.equal(r.error.code, 'MEMORY_WRITE_SLUG');
    assert.equal(fs.existsSync(absPath), false, '零落盘');
  }, guardMemoryWrite);
});

test('注入接缝但不含 memory 依赖的既有工具行为不变（write 非记忆路径 / read / grep 回归）', async () => {
  await withRegistry(async ({ registry, safety, root, dataDir }) => {
    const w = await registry.execute('write', { path: 'notes/a.txt', content: 'hello memory seam\n' }, safety);
    assert.equal(w.ok, true);
    if (w.ok) assert.equal(w.value.stdout, 'written', '非记忆路径原样交回常规写入');
    assert.equal(fs.readFileSync(path.join(root, 'notes', 'a.txt'), 'utf8'), 'hello memory seam\n');
    assert.equal(fs.existsSync(path.join(dataDir, 'memory')), false, 'pass 路径零记忆副作用');

    const rd = await registry.execute('read', { path: 'notes/a.txt' }, safety);
    assert.equal(rd.ok, true);
    if (rd.ok) assert.equal(rd.value.stdout, 'hello memory seam\n');

    const g = await registry.execute('grep', { path: 'notes', pattern: 'memory seam' }, safety);
    assert.equal(g.ok, true);
    if (g.ok) assert.match(g.value.stdout, /a\.txt:1:hello memory seam/);
  }, guardMemoryWrite);
});

test('scope 透传：子代理链写自身 agents/<id> 走接缝（kind=agents/<id>），主目录仍被链拒', async () => {
  await withRegistry(async ({ registry, safety, dataDir }) => {
    const child = safety.withMemoryScope('agents/reviewer');
    const own = path.join(dataDir, 'memory', 'agents', 'reviewer', 'prefers-pnpm.md');
    const r = await registry.execute('write', { path: own, content: RAW }, child);
    assert.equal(r.ok, true, `子代理自身目录应可写：${r.ok ? '' : r.error.message}`);
    if (r.ok) assert.match(r.value.stdout, /^Saved memory: prefers-pnpm \[project\]/);
    assert.match(fs.readFileSync(own, 'utf8'), /^---\ntype: project\ncreated: /);
    assert.equal(
      fs.readFileSync(path.join(dataDir, 'memory', 'agents', 'reviewer', 'MEMORY.md'), 'utf8'),
      '- prefers-pnpm — repo uses pnpm [project]\n',
      '子代理子索引重建（scope 经 safety.memoryScope 透传到接缝）',
    );

    const main = await registry.execute('write', { path: path.join(dataDir, 'memory', 'other.md'), content: RAW }, child);
    assert.equal(main.ok, false, '收窄链不得写主记忆目录（链侧定论，接缝不重复复核）');
    if (!main.ok) {
      assert.equal(main.error.code, 'COMMAND_DENIED');
      assert.match(main.error.message, /agents\/reviewer/);
    }
    assert.equal(fs.existsSync(path.join(dataDir, 'memory', 'other.md')), false);
  }, guardMemoryWrite);
});
