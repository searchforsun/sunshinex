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

/**
 * 数据目录白名单（规格 D6 + 对齐规格 §4.2）：Read/Grep 放行 dataDir 整子树；
 * Write 仅在 <dataDir>/memory/** 开窄口（记忆子树，另一文件 chain.memorywrite.test.ts 覆盖），数据目录其它子树仍拒；
 * 非 dataDir 外部路径行为不变。
 * 第三参 dataDir 为**真正的数据目录**（= SUNSHINEX_DATA_DIR = tmp），各用例自行拼出所需子路径。
 */

function withChain(fn: (chain: SafetyChain, root: string, dataDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-dd-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const chain = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
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

test('D6 Write 数据目录非记忆子树仍拒绝（记忆子树另有窄口）', () => {
  withChain((chain, _root, dataDir) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const targets = [path.join(dataDir, 'skills', 'x.md'), path.join(dataDir, 'runs', 'x.json')];
    for (const target of targets) {
      const d = chain.evaluate('Write', { path: target });
      assert.equal(d.allowed, false, `Write 不得借只读放行出 root：${target}`);
    }
  });
});

test('D6 非 dataDir 的外部路径维持拒绝（行为不变）', () => {
  withChain((chain, root, dataDir) => {
    const outsider = path.join(os.tmpdir(), `sunshinex-outsider-${Date.now()}-${process.pid}.md`);
    fs.writeFileSync(outsider, 'outside both boundaries');
    try {
      const d = chain.evaluate('Read', { path: outsider });
      assert.equal(d.allowed, false, '不在 root 也不在 dataDir → 拒绝');
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
