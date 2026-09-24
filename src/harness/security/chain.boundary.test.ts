// src/harness/security/chain.boundary.test.ts
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

interface Fixture { chain: SafetyChain; guard: SecurityGuard; root: string; home: string; restore: () => void }

function withChain(mode: 'manual' | 'dontAsk' | 'plan', fn: (f: Fixture) => void | Promise<void>): Promise<void> | void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-root-'));
  const prevHome = process.env.HOME;
  const prevFence = process.env.SUNSHINEX_READ_FENCE;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.HOME = home;
  process.env.SUNSHINEX_DATA_DIR = path.join(home, '.sunshinex', 'projects', 'p', 'data');
  fs.mkdirSync(process.env.SUNSHINEX_DATA_DIR, { recursive: true });
  const guard = new SecurityGuard(new PolicyEngine(), mode);
  const chain = new SafetyChain(guard, new ProcessSandbox(), new DryRun(), root);
  const restore = (): void => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevFence === undefined) delete process.env.SUNSHINEX_READ_FENCE; else process.env.SUNSHINEX_READ_FENCE = prevFence;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  };
  const r = fn({ chain, guard, root, home, restore });
  if (r instanceof Promise) return r.then(restore);
  restore();
}

test('D1：root 外读缺省全放（manual 档亦放）', async () => {
  withChain('manual', ({ chain, root }) => {
    const outside = path.join(path.dirname(root), 'outside.txt');
    fs.writeFileSync(outside, 'x');
    const d = chain.evaluate('Read', { path: outside });
    assert.equal(d.allowed, true);
  });
});

test('D1：fence 开启时 root 外读 manual=ask，askDir 记目录；dontAsk=拒', async () => {
  withChain('manual', async ({ chain, root }) => {
    process.env.SUNSHINEX_READ_FENCE = 'on';
    const outside = path.join(path.dirname(root), 'secret.txt');
    const d = await chain.evaluateAsync('Read', { path: outside });
    assert.equal(d.allowed, false);
    assert.ok(!d.allowed && d.ask === true && d.askDir === path.dirname(outside));
  });
  withChain('dontAsk', ({ chain, root }) => {
    process.env.SUNSHINEX_READ_FENCE = 'on';
    const outside = path.join(path.dirname(root), 'secret.txt');
    const d = chain.evaluate('Read', { path: outside });
    assert.equal(d.allowed, false);
    assert.ok(!d.allowed && d.reason.includes('read fence'));
  });
});

test('D2：root 外写 manual=ask（askDir=目录）；\'always\' 经 evaluateAsync 登记目录后同目录免批', async () => {
  withChain('manual', async ({ chain, guard, root }) => {
    const dir = path.join(path.dirname(root), 'granted');
    fs.mkdirSync(dir, { recursive: true });
    const d1 = await chain.evaluateAsync('Write', { path: path.join(dir, 'a.txt') });
    assert.ok(!d1.allowed && d1.ask === true && d1.askDir === dir);
    guard.setAsker(async () => 'always');
    const d2 = await chain.evaluateAsync('Write', { path: path.join(dir, 'a.txt') });
    assert.equal(d2.allowed, true);
    assert.equal(guard.sessionDirAllowed(path.join(dir, 'b.txt')), true);
    guard.setAsker(undefined); // 撤走 asker：同目录后续写仍放行（会话目录登记生效）
    const d3 = await chain.evaluateAsync('Write', { path: path.join(dir, 'b.txt') });
    assert.equal(d3.allowed, true);
    const elsewhere = path.join(path.dirname(root), 'elsewhere', 'c.txt');
    const d4 = await chain.evaluateAsync('Write', { path: elsewhere });
    assert.equal(d4.allowed, false); // asker 已撤，新目录 ask 无通道 → 维持拒
  });
});

test('D2：root 外写 dontAsk=放行；信任域内 manual 亦直放', () => {
  withChain('dontAsk', ({ chain, root }) => {
    const outside = path.join(path.dirname(root), 'w.txt');
    assert.equal(chain.evaluate('Write', { path: outside }).allowed, true);
  });
  withChain('manual', ({ chain, root }) => {
    assert.equal(chain.evaluate('Write', { path: path.join(root, 'in.txt') }).allowed, true);
  });
});

test('D6：.git 任一段写拒（仓库 .git 目录与指针文件同护）', () => {
  withChain('dontAsk', ({ chain, root }) => {
    assert.ok(!chain.evaluate('Write', { path: path.join(root, '.git', 'config') }).allowed);
    assert.ok(!chain.evaluate('Write', { path: path.join(root, 'sub', '.git', 'HEAD') }).allowed);
    assert.ok(chain.evaluate('Write', { path: path.join(root, 'github-like', 'a.txt') }).allowed);
  });
});

test('D6：.git 硬底线先于用户 allow 规则（规则不可放宽）', () => {
  withChain('dontAsk', ({ chain, root }) => {
    chain.setPermissions({ deny: [], allow: ['Write(**/.git/**)'], additionalDirs: [] });
    const d = chain.evaluate('Write', { path: path.join(root, '.git', 'config') });
    assert.equal(d.allowed, false);
  });
});

test('D5：用户 deny 命中即拒、allow 信任域外免批', () => {
  withChain('manual', ({ chain, root }) => {
    chain.setPermissions({ deny: ['Write(**/.env)'], allow: ['Write(**/allow.txt)'], additionalDirs: [] });
    assert.ok(!chain.evaluate('Write', { path: path.join(root, 'sub', '.env') }).allowed);
    const outside = path.join(path.dirname(root), 'allow.txt');
    assert.equal(chain.evaluate('Write', { path: outside }).allowed, true);
    const other = path.join(path.dirname(root), 'other.txt');
    assert.ok(!chain.evaluate('Write', { path: other }).allowed);
  });
});

test('D3：信任目录读写放行（setAdditionalDirs 归一 + addAdditionalDir 追加）', () => {
  withChain('manual', ({ chain, root }) => {
    const trust = path.join(path.dirname(root), 'trusted');
    fs.mkdirSync(trust, { recursive: true });
    const link = path.join(root, '..', path.basename(trust)); // 相对形态注入
    chain.setAdditionalDirs([link]);
    assert.equal(chain.evaluate('Write', { path: path.join(trust, 'a.txt') }).allowed, true);
    chain.addAdditionalDir(path.join(trust, 'nested'));
    assert.equal(chain.evaluate('Write', { path: path.join(trust, 'nested', 'b.txt') }).allowed, true);
  });
});

test('withRoot 克隆共享 permissions/additionalDirs；隔离链根外写恒拒', () => {
  withChain('dontAsk', ({ chain, root }) => {
    const tree = path.join(path.dirname(root), 'wt-tree');
    fs.mkdirSync(tree, { recursive: true });
    const trust = path.join(path.dirname(root), 'shared-dir');
    fs.mkdirSync(trust, { recursive: true });
    chain.setAdditionalDirs([trust]);
    chain.setPermissions({ deny: ['Read(**/secret)'], allow: [], additionalDirs: [] });
    const child = chain.withRoot(tree);
    assert.equal(child.evaluate('Write', { path: path.join(trust, 'a.txt') }).allowed, true);
    assert.ok(!child.evaluate('Read', { path: path.join(tree, 'secret') }).allowed);
    const outside = path.join(path.dirname(root), 'out.txt');
    assert.ok(!child.evaluate('Write', { path: outside }).allowed);
  });
});
