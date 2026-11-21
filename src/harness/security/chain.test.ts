import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafetyChain } from './chain';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ProcessSandbox } from './sandbox';
import { isWithin } from '../../paths';

/** 平台能力探测：Windows 建 symlink 需管理员或开发者模式，无权限时测试跳过（断言目标与平台无关） */
export function canSymlink(): boolean {
  if (process.platform !== 'win32') return true;
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sym-probe-'));
  try {
    fs.symlinkSync(probeRoot, path.join(probeRoot, 'probe'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

function chain(root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-')), mode: 'acceptEdits' | 'full-access' = 'acceptEdits'): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), mode), new ProcessSandbox(), root);
}

test('SafetyChain.evaluate 经 guard 拦截危险命令', () => {
  const p = new PolicyEngine();
  p.add('deny', 'Bash(rm *)');
  const c = chain(process.cwd());
  const d = c.evaluate('Bash', { command: 'rm -rf /' });
  assert.equal(d.allowed, false);
});

test('SafetyChain.run 经沙箱执行 echo', async () => {
  const r = await chain(process.cwd()).run('echo hi');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.stdout, /hi/);
});

test('evaluate 对 Read 越界相对路径放行（spec 5.1 读分支 D1：域外缺省全放）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-'));
  const d = chain(root).evaluate('Read', { path: '../outside.txt' });
  assert.equal(d.allowed, true);
});

test('evaluate 对绝对路径越出 root 的 Write 按 full-access 放行（spec 5.1 写分支 D2：root 外写审批化，full-access=放行）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-outside-'));
  const d = chain(root, 'full-access').evaluate('Write', { path: path.join(outside, 'x.txt') });
  assert.equal(d.allowed, true);
  if (d.allowed) assert.equal(d.safePath, path.join(outside, 'x.txt'));
});

test('evaluate 界内路径 allow 并返回绝对 safePath', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-'));
  const d = chain(root, 'full-access').evaluate('Write', { path: 'sub/a.txt' });
  assert.equal(d.allowed, true);
  if (d.allowed) assert.equal(d.safePath, path.join(root, 'sub', 'a.txt'));
});

test('Glob 与 Bash 不做路径校验且无 safePath', () => {
  const c = chain(process.cwd());
  const g = c.evaluate('Glob', { pattern: '**/*' });
  assert.equal(g.allowed, true);
  if (g.allowed) assert.equal(g.safePath, undefined);
  const b = c.evaluate('Bash', { command: 'echo hi' });
  assert.equal(b.allowed, true);
  if (b.allowed) assert.equal(b.safePath, undefined);
});

test('maskResult 按模式集脱敏 stdout 与 stderr', () => {
  const r = chain(process.cwd()).maskResult('Read', {
    exitCode: 0,
    stdout: ['key sk-abc12345678901234567890', 'Authorization: Bearer abcdefgh12345678', 'aws=AKIAIOSFODNN7EXAMPLE', 'password=hunter2', '"apiKey": "xyz123"'].join('\n'),
    stderr: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    timedOut: false,
  });
  assert.ok(!r.stdout.includes('sk-abc12345678901234567890'));
  assert.ok(!r.stdout.includes('Bearer abcdefgh12345678'));
  assert.ok(!r.stdout.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!r.stdout.includes('hunter2'));
  assert.ok(!r.stdout.includes('"apiKey": "xyz123"'));
  assert.equal(r.stderr, '***');
});

test('maskResult 无命中原样返回', () => {
  const r = chain(process.cwd()).maskResult('Read', { exitCode: 0, stdout: 'plain output 123', stderr: '', timedOut: false });
  assert.equal(r.stdout, 'plain output 123');
});

test('evaluate 对 root 内符号链接指向 root 外目标的 Read 放行（D1 读分支：域外缺省全放）', { skip: !canSymlink() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sym-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sym-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOPSECRET');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  const d = chain(root).evaluate('Read', { path: 'link.txt' });
  assert.equal(d.allowed, true);
  if (d.allowed) assert.match(d.safePath ?? '', /secret\.txt/);
});

test('evaluate 对符号链接父目录下的 Write 放行（acceptEdits=ask 且 askDir 记链接目标目录）', { skip: !canSymlink() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sym-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sym-out-'));
  fs.symlinkSync(outside, path.join(root, 'escdir'));
  const d = chain(root, 'full-access').evaluate('Write', { path: 'escdir/x.txt', content: 'pwn' });
  assert.equal(d.allowed, true);
  const acceptEdits = chain(root, 'acceptEdits').evaluate('Write', { path: 'escdir/x.txt', content: 'pwn' });
  assert.ok(!acceptEdits.allowed && acceptEdits.ask === true);
  if (!acceptEdits.allowed) assert.equal(acceptEdits.askDir, outside);
});

test('evaluate 对指向 root 内目标的符号链接路径放行（反向场景）', { skip: !canSymlink() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sym-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sym-out-'));
  fs.writeFileSync(path.join(root, 'in.txt'), 'x');
  fs.symlinkSync(path.join(root, 'in.txt'), path.join(outside, 'alias.txt'));
  const d = chain(root).evaluate('Read', { path: path.join(outside, 'alias.txt') });
  assert.equal(d.allowed, true);
});

test('evaluate 对多级新建路径的 Write 放行（逐级上溯回归）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sym-'));
  const d = chain(root, 'full-access').evaluate('Write', { path: 'a/b/c.txt', content: 'x' });
  assert.equal(d.allowed, true);
  if (d.allowed) assert.equal(d.safePath, path.join(root, 'a/b/c.txt'));
});

test('evaluate 以 rootReal 为基准：root 经符号链接传入时判界仍正确（safePath 归一；域外读按 D1 缺省全放）', { skip: !canSymlink() }, () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sym-root-'));
  const ws = path.join(outer, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
  fs.symlinkSync(ws, path.join(outer, 'link'));
  const c = chain(path.join(outer, 'link'));
  const inside = c.evaluate('Read', { path: 'a.txt' });
  assert.equal(inside.allowed, true);
  // 判界基准锚 rootReal（符号链接目标真身）：safePath 为归一真实路径，而非链接面相对拼接
  if (inside.allowed) assert.equal(inside.safePath, path.join(ws, 'a.txt'));
  // D1 读分支：域外缺省全放（既有 deny 断言随行为变更二退役）；越界事实以归一 safePath 表达
  const escaped = c.evaluate('Read', { path: '../sibling.txt' });
  assert.equal(escaped.allowed, true);
  if (escaped.allowed) assert.ok(!isWithin(ws, String(escaped.safePath)), 'safePath 已逃出 rootReal 子树（域外读缺省全放）');
});

test('resolveSafe 判界异常按拒绝处理（spec 2.1 兜底条款）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sym-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  const fsRaw = require('fs') as { realpathSync: unknown };
  const orig = fsRaw.realpathSync;
  fsRaw.realpathSync = () => { throw new Error('EACCES: permission denied (simulated)'); };
  try {
    const d = chain(root).evaluate('Read', { path: 'a.txt' });
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.match(d.reason, /path boundary check failed/);
  } finally {
    fsRaw.realpathSync = orig;
  }
});

// ═══════════ userConfigDir 白名单围栏（2026-11-21 channels spec §5.3 / Task 14）═══════════
// 写族路径 ∈ ~/.sunshinex/：白名单四面（skills/**、agents/**、teams/**、SUNSHINE.md）放行，
// 其余恒拒——应用档（mcp.json/serve-token/schedules.json/plugins/gui）与三容器 data
// （projects/sunx/channels）只读；自 dataDir 子树交给记忆+技能两窄口；自 root/活动树豁免；
// 用户 allow 不可放宽。读族零影响。范式对齐 chain.settings-protect.test.ts：
// HOME 重定向隔离真实用户目录（env.ts homeDir 单点），SUNSHINEX_DATA_DIR 钉缺省 projects 形态。

interface FenceFixture { chain: SafetyChain; root: string; home: string; userCfg: string; dataDir: string }

function withFenceChain(fn: (f: FenceFixture) => void, mode: 'acceptEdits' | 'full-access' = 'acceptEdits'): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-fence-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-fence-root-'));
  const prevHome = process.env.HOME;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevLearned = process.env.SUNSHINEX_LEARNED_SKILLS;
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  process.env.HOME = home;
  delete process.env.SUNSHINEX_PROJECTS_DIR; // 缺省全局形态：数据目录落 ~/.sunshinex/projects/<slug>/data（钉掉机器级覆盖）
  delete process.env.SUNSHINEX_LEARNED_SKILLS; // 技能窄口总开关取缺省 on
  const userCfg = path.join(home, '.sunshinex');
  fs.mkdirSync(userCfg, { recursive: true });
  const dataDir = path.join(userCfg, 'projects', 'p', 'data'); // 本工作区数据目录钉点（缺省布局形态，同 chain.settings-protect.test.ts）
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  const c = new SafetyChain(new SecurityGuard(new PolicyEngine(), mode), new ProcessSandbox(), root);
  try {
    fn({ chain: c, root, home, userCfg, dataDir });
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prevData;
    if (prevLearned === undefined) delete process.env.SUNSHINEX_LEARNED_SKILLS; else process.env.SUNSHINEX_LEARNED_SKILLS = prevLearned;
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR; else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 恒拒断言单点：不许放行、不带 ask（硬底线非审批化）、文案带只读定性与路径 */
function assertHardDeny(d: ReturnType<SafetyChain['evaluate']>, target: string, label: string): void {
  assert.equal(d.allowed, false, `${label} 应恒拒：${d.allowed ? 'unexpected allow' : ''}`);
  assert.ok(!d.allowed && d.ask === undefined, `${label} 恒拒不得审批化（ask 不出现）：${!d.allowed && d.ask !== undefined ? 'unexpected ask' : ''}`);
  if (!d.allowed) {
    assert.match(d.reason, /read-only/, `${label} 拒绝文案应带只读定性：${d.reason}`);
    assert.ok(d.reason.includes(target), `${label} 拒绝文案应带路径：${d.reason}`);
  }
}

/** 窄口/白名单放行断言单点：acceptEdits 档下 allowed=true 即定论放行（写分支档位只会给 ask=拒形态，
 *  不可能给出 allowed=true——能放行只可能是硬底线区窄口/白名单短路，断言成立即证明判定位置正确） */
function assertGateAllow(d: ReturnType<SafetyChain['evaluate']>, target: string, label: string): void {
  assert.equal(d.allowed, true, `${label} 应定论放行（acceptEdits 档下放行只能是窄口/白名单短路）：${!d.allowed ? d.reason : ''}`);
  if (d.allowed) assert.equal(d.safePath, target, `${label} safePath 应为归一真实路径`);
}

test('围栏①：写其它项目 data 恒拒（三容器只读·projects）', () => {
  withFenceChain(({ chain, userCfg }) => {
    const target = path.join(userCfg, 'projects', 'other-ws', 'data', 'x.md');
    assertHardDeny(chain.evaluate('Write', { path: target }), target, '其它项目 data');
  });
});

test('围栏②：写 sunx 域 data 恒拒（三容器只读·sunx）', () => {
  withFenceChain(({ chain, userCfg }) => {
    const target = path.join(userCfg, 'sunx', 'j-1', 'data', 'memory', 'main.md');
    assertHardDeny(chain.evaluate('Write', { path: target }), target, 'sunx 域 data');
  });
});

test('围栏③：写 channels 域 data 恒拒（三容器只读·channels）', () => {
  withFenceChain(({ chain, userCfg }) => {
    const target = path.join(userCfg, 'channels', 'im-foo-bar', 'data', 'ledger.json');
    assertHardDeny(chain.evaluate('Write', { path: target }), target, 'channels 域 data');
  });
});

test('围栏④：应用档采样各拒（mcp.json/serve-token/schedules.json/plugins/gui）', () => {
  withFenceChain(({ chain, userCfg }) => {
    const targets = [
      path.join(userCfg, 'mcp.json'),
      path.join(userCfg, 'serve-token'),
      path.join(userCfg, 'schedules.json'),
      path.join(userCfg, 'plugins', 'demo', 'plugin.js'),
      path.join(userCfg, 'gui', 'assets', 'app.js'),
    ];
    for (const target of targets) assertHardDeny(chain.evaluate('Write', { path: target }), target, `应用档 ${path.basename(target)}`);
  });
});

test('围栏⑤：写 ~/.sunshinex/skills/** 放行（白名单·acceptEdits 直放不 ask）', () => {
  withFenceChain(({ chain, userCfg }) => {
    const target = path.join(userCfg, 'skills', 'demo', 'SKILL.md');
    assertGateAllow(chain.evaluate('Write', { path: target }), target, '用户级技能根写');
  });
});

test('围栏⑥：写 ~/.sunshinex/agents/** 与 teams/**（team.md）放行（白名单）', () => {
  withFenceChain(({ chain, userCfg }) => {
    for (const target of [path.join(userCfg, 'agents', 'helper', 'AGENT.md'), path.join(userCfg, 'teams', 'support', 'team.md')]) {
      assertGateAllow(chain.evaluate('Write', { path: target }), target, `白名单 ${path.basename(path.dirname(target))}`);
    }
  });
});

test('围栏⑦：写 ~/.sunshinex/SUNSHINE.md 放行（白名单单档）', () => {
  withFenceChain(({ chain, userCfg }) => {
    const target = path.join(userCfg, 'SUNSHINE.md');
    assertGateAllow(chain.evaluate('Write', { path: target }), target, '用户级 SUNSHINE.md');
  });
});

test('围栏⑧：写自 <dataDir>/skills/** 与 <dataDir>/memory/** 放行（两窄口回归锚）', () => {
  withFenceChain(({ chain, dataDir }) => {
    for (const target of [path.join(dataDir, 'skills', 'learned-x', 'SKILL.md'), path.join(dataDir, 'memory', 'main.md')]) {
      assertGateAllow(chain.evaluate('Write', { path: target }), target, '本域窄口写');
    }
  });
});

test('围栏⑨：写自 <dataDir>/sessions/** 与 <dataDir>/teams/**（板面运行态）恒拒', () => {
  withFenceChain(({ chain, dataDir }) => {
    for (const target of [path.join(dataDir, 'sessions', 's-1', 'turns.jsonl'), path.join(dataDir, 'teams', 'j-1', 'board.md')]) {
      assertHardDeny(chain.evaluate('Write', { path: target }), target, `本域数据目录 ${path.basename(path.dirname(target))}`);
    }
  });
});

test('围栏⑩：root 落 dataDir 子树布局写自己 root 内文件放行（自 root 豁免不误伤）', () => {
  withFenceChain(({ dataDir }) => {
    const nestedRoot = path.join(dataDir, 'ws'); // root = dataDir 子目录（SUNSHINEX_DATA_DIR 重定向形态）
    fs.mkdirSync(nestedRoot, { recursive: true });
    const c = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'acceptEdits'), new ProcessSandbox(), nestedRoot);
    const inside = path.join(nestedRoot, 'a.txt');
    const d = c.evaluate('Write', { path: inside });
    assert.equal(d.allowed, true, `自 root 内写应放行（白名单豁免不误伤）：${d.allowed ? '' : d.reason}`);
    // 对照：同布局下 dataDir 内 root 外路径仍拒（豁免不放大写面）
    const outside = path.join(dataDir, 'outside-ws.txt');
    assertHardDeny(c.evaluate('Write', { path: outside }), outside, 'root 外 dataDir 残余');
  });
});

test('围栏⑪：用户 allow 一条 data 路径后仍拒（硬底线·allow 不可放宽白名单）', () => {
  withFenceChain(({ chain, userCfg }) => {
    chain.setPermissions({ deny: [], allow: ['Write(**/data/**)'], additionalDirs: [] });
    const target = path.join(userCfg, 'projects', 'other-ws', 'data', 'x.md');
    const d = chain.evaluate('Write', { path: target });
    assert.equal(d.allowed, false, `allow 规则不得放宽白名单恒拒：${d.allowed ? 'unexpected allow' : d.reason}`);
    assert.ok(!d.allowed && d.reason.includes(target));
  });
});

test('围栏⑫：读族不受影响（settings.json/serve-token/三容器 data 读全放行）', () => {
  withFenceChain(({ chain, userCfg }) => {
    for (const target of [
      path.join(userCfg, 'settings.json'),
      path.join(userCfg, 'serve-token'),
      path.join(userCfg, 'projects', 'other-ws', 'data', 'x.md'),
    ]) {
      const d = chain.evaluate('Read', { path: target });
      assert.equal(d.allowed, true, `读族应放行 ${target}：${d.allowed ? '' : d.reason}`);
    }
    const g = chain.evaluate('Grep', { path: path.join(userCfg, 'sunx', 'j-1', 'data') });
    assert.equal(g.allowed, true, `Grep 域外读按 D1 缺省全放：${g.allowed ? '' : g.reason}`);
  });
});
