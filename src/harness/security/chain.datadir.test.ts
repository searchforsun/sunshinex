import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafetyChain } from './chain';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ProcessSandbox } from './sandbox';
import { resolveDataDir } from '../../config/data-dir';

/**
 * 数据目录白名单（规格 D6 + 对齐规格 §4.2）：Read/Grep 放行 dataDir 整子树；
 * Write 在 <dataDir>/memory/** 与 <dataDir>/skills/** 开窄口（记忆子树 chain.memorywrite.test.ts 覆盖，
 * 技能窄口 chain.test.ts 围栏⑧覆盖——2026-11-21 channels §5.3），数据目录其它子树仍拒；
 * 非 dataDir 外部路径行为不变。
 * 第三参 dataDir 为**真正的数据目录**（= SUNSHINEX_DATA_DIR = tmp），各用例自行拼出所需子路径。
 */

function withChain(fn: (chain: SafetyChain, root: string, dataDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-dd-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const chain = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
    fn(chain, root, tmp);
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('D6 Read 数据目录内文件放行（safePath 注入真实路径）', () => {
  withChain((chain, _root, dataDir) => {
    const file = path.join(dataDir, 'memory', 'alpha.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '- alpha — demo [project]\n');
    const d = chain.evaluate('Read', { path: file });
    assert.equal(d.allowed, true, `应放行：${d.allowed ? '' : d.reason}`);
    if (d.allowed) assert.equal(d.safePath, file);

    // 数据目录根下文件同在放行子树内（覆盖不缩水：memory/ 文件与数据目录根文件各一）
    const rootFile = path.join(dataDir, 'ledger.json');
    fs.writeFileSync(rootFile, '{}\n');
    const dRoot = chain.evaluate('Read', { path: rootFile });
    assert.equal(dRoot.allowed, true, `数据目录根文件应放行：${dRoot.allowed ? '' : dRoot.reason}`);
  });
});

test('D6 Grep 数据目录内路径放行（只读类）', () => {
  withChain((chain, _root, dataDir) => {
    const dir = path.join(dataDir, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    const d = chain.evaluate('Grep', { path: dir });
    assert.equal(d.allowed, true, `应放行：${d.allowed ? '' : d.reason}`);
  });
});

test('D6 Write 数据目录窄口外子树仍拒绝（memory/skills 两窄口外）', () => {
  withChain((chain, _root, dataDir) => {
    fs.mkdirSync(dataDir, { recursive: true });
    // skills/** 已随 2026-11-21 channels §5.3 技能窄口放行（chain.test.ts 围栏⑧），移出拒清单
    const targets = [path.join(dataDir, 'runs', 'x.json')];
    for (const target of targets) {
      const d = chain.evaluate('Write', { path: target });
      assert.equal(d.allowed, false, `Write 不得借只读放行出 root：${target}`);
    }
  });
});

test('D6 非 dataDir 的外部路径缺省放行（spec 5.1 读分支 D1：域外全放，fence 才收窄）', () => {
  withChain((chain, root, dataDir) => {
    const outsider = path.join(os.tmpdir(), `sunshinex-outsider-${Date.now()}-${process.pid}.md`);
    fs.writeFileSync(outsider, 'outside both boundaries');
    try {
      const d = chain.evaluate('Read', { path: outsider });
      assert.equal(d.allowed, true, '读分支域外缺省全放');
      assert.ok(!outsider.startsWith(dataDir) && !outsider.startsWith(root), '前提：路径确在两界之外');
    } finally {
      fs.rmSync(outsider, { force: true });
    }
  });
});

test('D6 数据目录内不存在的文件判界不抛、字面放行（存在性交给执行层）', () => {
  withChain((chain, _root, dataDir) => {
    const d = chain.evaluate('Read', { path: path.join(dataDir, 'ghost.md') });
    assert.equal(d.allowed, true, '判界只管边界不管存在性');
  });
});

// ═══════════ 域绑定注入缝（2026-11-15 终审 Fix 2：记忆判界随域，纵深防御恢复）═══════════
// sunx 会话经 HarnessOptions.dataDir 注入持久化域（~/.sunshinex/sunx/<jid>/data）——链记忆判界
// 若仍按 resolveDataDir(root) 推导 projects 区：链窄口对旧区记忆写放行 → 域缝 guardMemoryWrite
// 判不中 → 裸写共享记忆区（跨域写通道）。注入后判界随域：域内 memory/ 放行（走记忆闸），
// 旧 projects 推导区 memory/** 越界写恒拒（域绑定链不落共享区），缺席=既有推导字节不变。

function withInjectedChain(fn: (chain: SafetyChain, root: string, domain: string, legacyDataDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-ddinj-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects'); // 旧推导区钉 tmp 下（域外共享区可断言）
  delete process.env.SUNSHINEX_DATA_DIR;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const domain = path.join(tmp, 'sunx-domain');
    fs.mkdirSync(domain, { recursive: true });
    const chain = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root, undefined, domain);
    fn(chain, root, domain, resolveDataDir(root)); // legacyDataDir=旧 projects 推导区（判界基准原值）
  } finally {
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('Fix 2 注入域：域内 memory/ 写走记忆窄口放行；缺席注入=resolveDataDir 既有推导字节不变', () => {
  withInjectedChain((chain, root, domain) => {
    const inDomain = path.join(domain, 'memory', 'alpha.md');
    const d = chain.evaluate('Write', { path: inDomain });
    assert.equal(d.allowed, true, `域内记忆写应放行（记忆窄口随域）：${d.allowed ? '' : d.reason}`);
    // 域内非记忆子树照旧不受记忆窄口管辖（域目录写按既有信任域/档位判定——注入只收记忆判界）
    const dNonMem = chain.evaluate('Write', { path: path.join(domain, 'tasks', 'ledger-x.jsonl') });
    assert.equal(dNonMem.allowed, true, `域内非记忆写不受记忆窄口拦截：${dNonMem.allowed ? '' : dNonMem.reason}`);
    // 缺席注入基线锚：同 root 无注入链对旧推导区 memory/ 窄口照旧命中放行（standard 字节不变）
    const bare = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
    const dBare = bare.evaluate('Write', { path: path.join(resolveDataDir(root), 'memory', 'base.md') });
    assert.equal(dBare.allowed, true, `缺席注入基线：旧窄口照旧放行（字节不变）：${dBare.allowed ? '' : dBare.reason}`);
  });
});

test('Fix 2 注入域：旧 projects 推导区 memory/** 越界写被判界拦下（deny——裸写共享记忆区通道封死）', () => {
  withInjectedChain((chain, root, _domain, legacyDataDir) => {
    const legacyMem = path.join(legacyDataDir, 'memory', 'cross.md');
    const d = chain.evaluate('Write', { path: legacyMem });
    assert.ok(!d.allowed, `旧推导区记忆写应被拦下（域绑定防漏）：${d.allowed ? 'unexpected allow' : d.reason}`);
    assert.match(d.allowed ? '' : d.reason, /memory/, '拒绝文案指向记忆判界（可读成因）');
    // 非 memory 形态路径不误伤（域绑定只收记忆判界——工作区根内写走既有信任域放行）
    const dPlain = chain.evaluate('Write', { path: path.join(root, 'notes.md') });
    assert.equal(dPlain.allowed, true, `工作区根内写不误伤：${dPlain.allowed ? '' : dPlain.reason}`);
  });
});

test('Fix 2 withDataDir 链式等价注入；克隆（withMemoryScope/withRoot）携带域绑定', () => {
  withInjectedChain((chain, root, domain, legacyDataDir) => {
    const chained = chain.withDataDir(domain);
    const dChained = chained.evaluate('Write', { path: path.join(domain, 'memory', 'b.md') });
    assert.equal(dChained.allowed, true, 'withDataDir 链式注入同构造等价');
    const dCross = chained.evaluate('Write', { path: path.join(legacyDataDir, 'memory', 'c.md') });
    assert.equal(dCross.allowed, false, '链式注入同样封死旧推导区记忆写');
    // 克隆携带：scope 收窄克隆域内 scope 外写拒（窄口随域生效）；换根克隆域绑定不丢
    const scoped = chain.withMemoryScope('agents/a1');
    const dScoped = scoped.evaluate('Write', { path: path.join(domain, 'memory', 'main.md') });
    assert.ok(!dScoped.allowed, '克隆窄口随域生效（scope 外拒）');
    assert.match(dScoped.allowed ? '' : dScoped.reason, /scope/, '拒绝成因=scope 收窄（域内判界在走）');
    const tree = path.join(root, 'tree');
    fs.mkdirSync(tree, { recursive: true });
    const rooted = chain.withRoot(tree);
    const dRooted = rooted.evaluate('Write', { path: path.join(legacyDataDir, 'memory', 'd.md') });
    assert.ok(!dRooted.allowed, '换根克隆旧区记忆写仍拒（域绑定携带不丢）');
    assert.match(dRooted.allowed ? '' : dRooted.reason, /memory/, '拒绝成因=域绑定记忆判界（非隔离根兜底文案——携带实证）');
  });
});
