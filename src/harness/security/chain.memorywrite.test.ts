import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafetyChain } from './chain';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ProcessSandbox } from './sandbox';
import { DryRun } from './dryrun';
import { resolveDataDir } from '../../config/data-dir';

/**
 * 记忆写窄口（规格 §4.2）：Write 只在 <dataDir>/memory/** 放行（总开关 resolveMemoryConfig().autoMemory 联动），
 * Read/Grep 的 D6 只读放行不受开关影响；withMemoryScope 派生链把写面收窄到子代理自身 agents/<id>/。
 * 范式对齐 chain.datadir.test.ts：tmpdir 作 root、SUNSHINEX_DATA_DIR 重定向、finally 还原 + 清理。
 * 本文件只做判界（不落盘），路径构造一律 path.join（win32 兼容）。
 */

function withChain(
  fn: (chain: SafetyChain, root: string, dataDir: string) => void,
  autoMemory?: 'on' | 'off',
): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-mw-'));
  const prevDataDir = process.env.SUNSHINEX_DATA_DIR;
  const prevAutoMemory = process.env.SUNSHINEX_AUTO_MEMORY;
  process.env.SUNSHINEX_DATA_DIR = tmp;
  if (autoMemory === undefined) delete process.env.SUNSHINEX_AUTO_MEMORY;
  else process.env.SUNSHINEX_AUTO_MEMORY = autoMemory;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const chain = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
    fn(chain, root, tmp);
  } finally {
    if (prevDataDir === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevDataDir;
    if (prevAutoMemory === undefined) delete process.env.SUNSHINEX_AUTO_MEMORY;
    else process.env.SUNSHINEX_AUTO_MEMORY = prevAutoMemory;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('write 落在 <dataDir>/memory/** → 放行（总开关开，主链可写整子树）', () => {
  withChain((chain, _root, dataDir) => {
    fs.mkdirSync(path.join(dataDir, 'memory', 'agents', 'reviewer'), { recursive: true });
    const main = path.join(dataDir, 'memory', 'alpha.md');
    const d = chain.evaluate('Write', { path: main });
    assert.equal(d.allowed, true, `主记忆记录应放行：${d.allowed ? '' : d.reason}`);
    if (d.allowed) assert.equal(d.safePath, main, 'safePath 注入 realpath 归一后的真实路径');

    const agentFile = path.join(dataDir, 'memory', 'agents', 'reviewer', 'a.md');
    const d2 = chain.evaluate('Write', { path: agentFile });
    assert.equal(d2.allowed, true, `主链可写记忆整子树（含子代理目录）：${d2.allowed ? '' : d2.reason}`);
  });
});

test('write 落在数据目录其它子树 / 同前缀不同目录 / 记忆目录本身 → 仍拒', () => {
  withChain((chain, _root, dataDir) => {
    fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
    const denied = [
      path.join(dataDir, 'skills', 'a.md'),
      path.join(dataDir, 'memoryx', 'a.md'),
      path.join(dataDir, 'memory'),
      path.join(dataDir, 'memory', 'agents'),
      path.join(dataDir, 'ledger.json'),
    ];
    for (const p of denied) {
      const d = chain.evaluate('Write', { path: p });
      assert.equal(d.allowed, false, `不应放行：${p}`);
      if (!d.allowed) assert.ok(d.reason.includes('COMMAND_DENIED'), `沿既有中文拒绝文案：${d.reason}`);
    }
  });
});

test('总开关 off → 记忆路径 write 被拒', () => {
  withChain(
    (chain, _root, dataDir) => {
      const d = chain.evaluate('Write', { path: path.join(dataDir, 'memory', 'a.md') });
      assert.equal(d.allowed, false, 'auto_memory=off 时写面先被总开关拦下');
      if (!d.allowed) assert.ok(d.reason.includes('COMMAND_DENIED'), `拒绝文案格式不变：${d.reason}`);
      // 总开关只收写窄口，不改判界其它分支
      const outside = chain.evaluate('Write', { path: '/tmp/sunshinex-mw-outside.md' });
      assert.equal(outside.allowed, false, '外部路径维持拒绝');
    },
    'off',
  );
});

test('总开关 off → read 记忆路径仍放行（只读与开关无关）', () => {
  withChain(
    (chain, _root, dataDir) => {
      fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
      const file = path.join(dataDir, 'memory', 'a.md');
      fs.writeFileSync(file, '- alpha — demo [project]\n');
      const r = chain.evaluate('Read', { path: file });
      assert.equal(r.allowed, true, `只读召回不受总开关影响：${r.allowed ? '' : r.reason}`);
      if (r.allowed) assert.equal(r.safePath, file);
      const g = chain.evaluate('Grep', { path: path.join(dataDir, 'memory') });
      assert.equal(g.allowed, true, `Grep 记忆目录只读放行：${g.allowed ? '' : g.reason}`);
    },
    'off',
  );
});

test('withMemoryScope 收窄：子代理链只放行自身 agents/<id>，原实例零突变', () => {
  withChain((chain, _root, dataDir) => {
    const own = path.join(dataDir, 'memory', 'agents', 'reviewer', 'a.md');
    const nestedOwn = path.join(dataDir, 'memory', 'agents', 'reviewer', 'nested', 'b.md');
    const other = path.join(dataDir, 'memory', 'agents', 'other', 'a.md');
    const mainFile = path.join(dataDir, 'memory', 'a.md');

    const child = chain.withMemoryScope('agents/reviewer');
    assert.notEqual(child, chain, 'withMemoryScope 返回派生克隆');
    assert.equal(child.memoryScope, 'agents/reviewer');
    assert.equal(chain.memoryScope, undefined, '原实例 scope 零突变');
    assert.equal(child.backend, chain.backend, '其余依赖引用共享');

    assert.equal(child.evaluate('Write', { path: own }).allowed, true, '子代理可写自身目录');
    assert.equal(child.evaluate('Write', { path: nestedOwn }).allowed, true, '自身子树内嵌套同样放行');
    assert.equal(child.evaluate('Write', { path: mainFile }).allowed, false, '子代理不得写主记忆目录');
    assert.equal(child.evaluate('Write', { path: other }).allowed, false, '子代理不得写其它子代理目录');
    assert.equal(child.evaluate('Read', { path: mainFile }).allowed, true, '收窄只针对写面，只读放行不变');

    // 原链未受影响：主链全量放行记忆整子树
    assert.equal(chain.evaluate('Write', { path: mainFile }).allowed, true);
    assert.equal(chain.evaluate('Write', { path: other }).allowed, true);
  });
});

test('memory 内符号链接指向外部 → 写被拒（realpath 判界，链接不可逃逸）', () => {
  withChain((chain, _root, dataDir) => {
    fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-mw-out-'));
    try {
      const link = path.join(dataDir, 'memory', 'esc');
      fs.symlinkSync(outside, link);
      const d = chain.evaluate('Write', { path: path.join(link, 'evil.md') });
      assert.equal(d.allowed, false, '真实路径落在 memory 之外 → 拒');
      if (!d.allowed) assert.ok(d.reason.includes('COMMAND_DENIED'));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('dataDir 自身经符号链接传入 → 记忆写窄口按真实路径判定，不误拒合法写入（POSIX）', { skip: process.platform === 'win32' ? 'win32 无符号链接目录语义（需特权），跳过' : false }, () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-mw-real-'));
  const linkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-mw-link-'));
  const prevDataDir = process.env.SUNSHINEX_DATA_DIR;
  const prevAutoMemory = process.env.SUNSHINEX_AUTO_MEMORY;
  try {
    // 数据目录字面路径含符号链接段（对齐 macOS /tmp→/private/tmp、HOME 经链接的部署形态）
    const link = path.join(linkHome, 'data-link');
    fs.symlinkSync(real, link, 'dir');
    process.env.SUNSHINEX_DATA_DIR = link;
    delete process.env.SUNSHINEX_AUTO_MEMORY;

    const root = path.join(real, 'root');
    fs.mkdirSync(root, { recursive: true });
    const chain = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);

    const target = path.join(link, 'memory', 'a.md'); // 经链接路径写记忆子树
    const d = chain.evaluate('Write', { path: target });
    assert.equal(d.allowed, true, `数据目录经符号链接时不得误拒合法记忆写入：${d.allowed ? '' : d.reason}`);
    if (d.allowed) assert.equal(d.safePath, path.join(fs.realpathSync(real), 'memory', 'a.md'), 'safePath 为 realpath 归一后的真实路径');

    // 归一化不放松写面：同链接下的非记忆子树仍拒
    const other = chain.evaluate('Write', { path: path.join(link, 'skills', 'x.md') });
    assert.equal(other.allowed, false, '归一后仍只放行 memory 子树');
    if (!other.allowed) assert.ok(other.reason.includes('COMMAND_DENIED'));
  } finally {
    if (prevDataDir === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevDataDir;
    if (prevAutoMemory === undefined) delete process.env.SUNSHINEX_AUTO_MEMORY;
    else process.env.SUNSHINEX_AUTO_MEMORY = prevAutoMemory;
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(linkHome, { recursive: true, force: true });
  }
});

test('数据目录回退 <root>/.data（HOME 不可写）→ 记忆写仍受总开关约束，root 内非记忆路径语义不变', () => {
  // 夹具范式对齐 src/config/data-dir.test.ts「HOME 不可写回退项目内 .data」：HOME/USERPROFILE 指向不可写路径（文件）+ 删除 SUNSHINEX_DATA_DIR。
  // 动机（2026-09-18 审查重要项）：该布局下记忆目录落在项目 root 内，若写窄口被 root 内「一律放行」分支先短路，总开关对写面即失效。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-mw-fb-'));
  const blk = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-mw-blk-'));
  const blocked = path.join(blk, 'file');
  fs.writeFileSync(blocked, 'x');
  const prevDataDir = process.env.SUNSHINEX_DATA_DIR;
  const prevAutoMemory = process.env.SUNSHINEX_AUTO_MEMORY;
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  try {
    delete process.env.SUNSHINEX_DATA_DIR;
    delete process.env.SUNSHINEX_AUTO_MEMORY;
    process.env.HOME = blocked;
    process.env.USERPROFILE = blocked;

    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    assert.equal(resolveDataDir(root), path.join(root, '.data'), '前提：HOME 不可写 → 数据目录回退项目内 .data');
    const chain = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
    const memoryFile = path.join(root, '.data', 'memory', 'a.md');
    const plain = path.join(root, 'plain.txt');

    const on = chain.evaluate('Write', { path: memoryFile });
    assert.equal(on.allowed, true, `总开关开：回退布局下记忆写应放行：${on.allowed ? '' : on.reason}`);
    assert.equal(chain.evaluate('Write', { path: plain }).allowed, true, 'root 内非记忆路径全放行（语义不变）');

    process.env.SUNSHINEX_AUTO_MEMORY = 'off';
    const off = chain.evaluate('Write', { path: memoryFile });
    assert.equal(off.allowed, false, '总开关 off：写窄口必须先在 root 内全放行分支之前定论');
    if (!off.allowed) {
      assert.ok(off.reason.includes('COMMAND_DENIED'), `拒绝文案沿既有前缀：${off.reason}`);
      assert.ok(
        !off.reason.includes('path escapes project root'),
        `拒绝原因须为记忆侧可辨识文案，不得复用 root 越界文案：${off.reason}`,
      );
    }
    assert.equal(chain.evaluate('Write', { path: plain }).allowed, true, '总开关 off 只收记忆写窄口，root 内非记忆写不受影响');
    assert.equal(chain.evaluate('Read', { path: memoryFile }).allowed, true, '只读放行与总开关无关（回退布局下同样成立）');
  } finally {
    if (prevDataDir === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevDataDir;
    if (prevAutoMemory === undefined) delete process.env.SUNSHINEX_AUTO_MEMORY;
    else process.env.SUNSHINEX_AUTO_MEMORY = prevAutoMemory;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(blk, { recursive: true, force: true });
  }
});
