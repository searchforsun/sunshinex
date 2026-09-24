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
 * settings.json 两级硬保护 + ~/.sunshinex 子树放行：
 * - 两级 settings.json（项目级 <root>/.sunshinex/settings.json、全局 <userConfigDir>/settings.json）Write 拒绝，dontAsk 不豁免；
 * - ~/.sunshinex 其余子树（全局技能根等）Write 放行（模型可自助安装技能）；
 * - 放行置记忆写窄口之后：缺省数据目录落在 ~/.sunshinex/projects 下，记忆总开关关闭时写 memory 仍拒（放行不越权）；
 * - 子树外的外部路径拒绝语义不变。
 * HOME 重定向隔离真实用户目录；SUNSHINEX_DATA_DIR 显式钉点使数据目录落入 ~/.sunshinex/projects 形态。
 */

function withChain(fn: (chain: SafetyChain, root: string, userCfg: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-cfg-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-cfg-root-'));
    const userCfg = path.join(home, '.sunshinex');
    fs.mkdirSync(userCfg, { recursive: true });
    const dataDir = path.join(userCfg, 'projects', 'p', 'data');
    process.env.SUNSHINEX_DATA_DIR = dataDir;
    const chain = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
    fn(chain, root, userCfg);
    fs.rmSync(root, { recursive: true, force: true });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('settings.json 两级硬保护：全局与项目级 Write 拒绝，拒绝文案点名 protected', () => {
  withChain((chain, root, userCfg) => {
    const globalSettings = path.join(userCfg, 'settings.json');
    const dGlobal = chain.evaluate('Write', { path: globalSettings });
    assert.equal(dGlobal.allowed, false, '全局 settings.json 应拒绝');
    assert.ok(!dGlobal.allowed && dGlobal.reason.includes('settings.json is protected'), `拒绝文案应可辨识：${!dGlobal.allowed ? dGlobal.reason : ''}`);

    const projectSettings = path.join(root, '.sunshinex', 'settings.json');
    const dProject = chain.evaluate('Write', { path: projectSettings });
    assert.equal(dProject.allowed, false, '项目级 settings.json 应拒绝');
    assert.ok(!dProject.allowed && dProject.reason.includes('settings.json is protected'), `拒绝文案应可辨识：${!dProject.allowed ? dProject.reason : ''}`);

    // 只读两面恒开放：Read 两级 settings.json 放行（保护只约束写）
    assert.equal(chain.evaluate('Read', { path: globalSettings }).allowed, true, '全局 settings.json 读应放行');
    assert.equal(chain.evaluate('Read', { path: projectSettings }).allowed, true, '项目级 settings.json 读应放行');
  });
});

test('~/.sunshinex 子树放行：全局技能根 Write/Read 放行，子树外外部路径仍拒', () => {
  withChain((chain, root, userCfg) => {
    const skillFile = path.join(userCfg, 'skills', 'demo', 'SKILL.md');
    const dSkill = chain.evaluate('Write', { path: skillFile });
    assert.equal(dSkill.allowed, true, `全局技能根写应放行：${dSkill.allowed ? '' : dSkill.reason}`);
    if (dSkill.allowed) assert.ok(dSkill.safePath?.startsWith(userCfg), 'safePath 应归一到用户配置根下');

    assert.equal(chain.evaluate('Read', { path: path.join(userCfg, 'x') }).allowed, true, '配置根下读应放行');

    const outside = path.join(path.dirname(userCfg), 'elsewhere.txt');
    const dOut = chain.evaluate('Write', { path: outside });
    assert.equal(dOut.allowed, false, '配置根之外的外部路径写应仍拒');
    assert.ok(!dOut.allowed && dOut.reason.includes('path escapes project root'), `外部路径拒绝语义不变：${!dOut.allowed ? dOut.reason : ''}`);
  });
});

test('放行不越记忆窄口：数据目录在 ~/.sunshinex/projects 下且总开关关闭时，写 memory 仍拒', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-cfg-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const prevAuto = process.env.SUNSHINEX_AUTO_MEMORY;
  process.env.SUNSHINEX_AUTO_MEMORY = 'off';
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-cfg-root-'));
    const userCfg = path.join(home, '.sunshinex');
    fs.mkdirSync(userCfg, { recursive: true });
    process.env.SUNSHINEX_DATA_DIR = path.join(userCfg, 'projects', 'p', 'data');
    const chain = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
    const d = chain.evaluate('Write', { path: path.join(userCfg, 'projects', 'p', 'data', 'memory', 'x.md') });
    assert.equal(d.allowed, false, '记忆总开关关闭时写 memory 应拒（不被 ~/.sunshinex 放行绕过）');
    assert.ok(!d.allowed && d.reason.includes('memory write denied'), `拒绝原因应可辨识：${!d.allowed ? d.reason : ''}`);
    fs.rmSync(root, { recursive: true, force: true });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAuto === undefined) delete process.env.SUNSHINEX_AUTO_MEMORY;
    else process.env.SUNSHINEX_AUTO_MEMORY = prevAuto;
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
