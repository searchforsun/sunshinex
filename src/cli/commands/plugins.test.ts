import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runPlugins } from './plugins';

/**
 * plugins list/validate/enable/disable 子命令（Task 13 + Task 18）：插件作者 lint 面——schema 同源
 * 校验（parsePluginManifest），exit code 可进 CI。进程内直跑命令函数（kb-index.test 的 console 临时
 * 换桩先例），tmp 夹具沿 config/plugins.test 的 tmpPlugin/mkPluginIn 小助手形态；
 * list 经 loadEffectivePlugins 注入面（builtinRoot/userRoot/settingsReader/platform）免真写 HOME。
 * enable/disable（Task 18）走 catalog setPluginEnabled 写 settings plugins.<id> 记录——该路径无注入面
 * （settingsPath 直读两级真文件），故走 spawn dist + HOME 桩（mcp.test 先例，文件尾 spawn 段）；
 * skills list（Task 18）spawn 用例同段落本文件：与 plugins 同消费 loadEffectivePlugins 装载根
 * （插件 skills 段同源），且聚焦测试清单限定三文件——就近合并。
 */

/** console 临时换桩：收集输出行与命令返回码，finally 还原（进程内测试不向测试日志喷命令输出）。
 *  通道即语义：stdout（console.log）= 结果面（表格/ok 摘要），stderr（console.error/warn）= 诊断面（error/warn） */
async function captureConsole(fn: () => Promise<number>): Promise<{ out: string[]; err: string[]; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  console.warn = (...a: unknown[]) => void err.push(a.join(' '));
  try {
    const code = await fn();
    return { out, err, code };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

/** 在装载根下造一个合法插件目录（目录名 = id，规避 id ≠ 目录名告警） */
function mkPluginIn(root: string, id: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(path.join(root, id), { recursive: true });
  writeFileSync(path.join(root, id, 'plugin.json'), JSON.stringify({ manifestVersion: 1, id, name: 'Demo', version: '0.1.0', description: 'd', ...extra }));
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('validate：合法目录 exit 0 + ok 摘要含 id/version', async () => {
  const dir = tmpRoot('sunshinex-pcli-ok-');
  try {
    mkPluginIn(dir, 'demo');
    const { out, code } = await captureConsole(() => runPlugins(['validate', path.join(dir, 'demo')]));
    assert.equal(code, 0, '合法目录应 exit 0');
    const text = out.join('\n');
    assert.ok(/ok/.test(text), `应上屏 ok 级摘要：${JSON.stringify(text)}`);
    assert.ok(text.includes('demo'), '摘要应含 id');
    assert.ok(text.includes('0.1.0'), '摘要应含 version');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validate：非法 manifest exit 1 且 error: 行上屏', async () => {
  const dir = tmpRoot('sunshinex-pcli-bad-');
  try {
    mkPluginIn(dir, 'demo', { name: undefined, version: undefined, description: undefined });
    const { err, code } = await captureConsole(() => runPlugins(['validate', path.join(dir, 'demo')]));
    assert.equal(code, 1, 'schema 错误应 exit 1');
    const text = err.join('\n');
    assert.ok(text.includes('error:'), `应上屏 error: 前缀行：${JSON.stringify(text)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validate：仅告警（未知字段）不致命——warn: 行 + exit 0', async () => {
  const dir = tmpRoot('sunshinex-pcli-warn-');
  try {
    mkPluginIn(dir, 'demo', { futureThing: 1 });
    const { out, err, code } = await captureConsole(() => runPlugins(['validate', path.join(dir, 'demo')]));
    assert.equal(code, 0, '仅告警不致命应 exit 0');
    assert.ok(err.join('\n').includes('warn:'), '应上屏 warn: 前缀行');
    assert.ok(/ok/.test(out.join('\n')), '告警仍在场合法摘要照常上屏');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list：表格含 id/version/来源/启用态/server 名，告警表后 [warn] 逐行', async () => {
  const bRoot = tmpRoot('sunshinex-pcli-b-');
  const uRoot = tmpRoot('sunshinex-pcli-u-');
  try {
    mkPluginIn(bRoot, 'demo', { defaultEnabled: true, mcpServers: { srv: { command: 'node' } }, futureThing: 1 });
    mkPluginIn(bRoot, 'idle'); // 缺省禁用对照组
    const { out, err, code } = await captureConsole(() => runPlugins(['list', '--root', bRoot], {
      builtinRoot: bRoot,
      userRoot: uRoot,
      platform: 'win32',
      settingsReader: () => null,
    }));
    assert.equal(code, 0, 'list 信息面应 exit 0');
    const text = out.join('\n');
    assert.ok(text.includes('demo') && text.includes('idle'), `表格应含插件 id：${JSON.stringify(text)}`);
    assert.ok(text.includes('0.1.0'), '表格应含 version');
    assert.ok(text.includes('builtin'), '表格应含来源列值');
    assert.ok(text.includes('srv'), '表格应含 server 名');
    assert.ok(/on/.test(text) && text.includes('off'), '表格应含启用态（on/off）');
    const diag = err.join('\n');
    assert.ok(diag.includes('[warn]'), `装载告警应表后 [warn] 逐行（stderr）：${JSON.stringify(diag)}`);
    assert.ok(diag.includes('[builtin:demo]'), '告警应带 [builtin:id] 前缀点名');
  } finally {
    rmSync(bRoot, { recursive: true, force: true });
    rmSync(uRoot, { recursive: true, force: true });
  }
});

test('未知子命令/缺参 → usage 行 + exit 1（沿仓内非法参数 exit 1 口径）', async () => {
  for (const args of [[], ['wat'], ['validate'], ['list', '--root'], ['enable']]) {
    const { err, code } = await captureConsole(() => runPlugins(args));
    assert.equal(code, 1, `args=${JSON.stringify(args)} 应 exit 1`);
    assert.ok(/Usage: sunshinex plugins/.test(err.join('\n')), `应上屏 usage 行：args=${JSON.stringify(args)}`);
  }
});

/* ---------- Task 18：enable/disable + skills list（spawn dist + HOME 桩，mcp.test 先例） ---------- */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface SpawnFixture {
  home: string;
  proj: string;
}

function makeSpawnFixture(tag: string): SpawnFixture {
  return {
    home: mkdtempSync(path.join(tmpdir(), `pcli-spawn-${tag}-home-`)),
    proj: mkdtempSync(path.join(tmpdir(), `pcli-spawn-${tag}-proj-`)),
  };
}

function cleanupSpawn(f: SpawnFixture): void {
  rmSync(f.home, { recursive: true, force: true });
  rmSync(f.proj, { recursive: true, force: true });
}

/** spawn dist CLI（command 前缀可变：plugins / skills）；cwd = 临时项目，HOME 桩 + 数据目录隔离 */
function runCli(f: SpawnFixture, command: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'dist', 'cli', 'index.js'), command, ...args], {
    cwd: f.proj,
    timeout: 60_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: f.home,
      SUNSHINEX_DATA_DIR: path.join(f.home, 'data'),
      SUNSHINEX_USER_SKILLS_DIR: path.join(f.home, 'user-skills'),
      SUNSHINEX_GLOBAL_SUNSHINE: path.join(f.home, 'SUNSHINE.md'),
      SUNSHINEX_LANGUAGE: 'en', // 钉 en：上屏文案断言不随宿主 settings/env 语言漂移
    },
  });
}

/** 在 HOME 桩的用户插件根造一个合法插件（setPluginEnabled 的 id 定位依赖装载面真扫两级根） */
function mkUserPlugin(f: SpawnFixture, id: string): void {
  mkPluginIn(path.join(f.home, '.sunshinex', 'plugins'), id);
}

test('enable（project 缺省）→ 项目 settings.json plugins.<id>.enabled 落键（catalog 写面）', () => {
  const f = makeSpawnFixture('enable');
  try {
    mkUserPlugin(f, 'demo');
    const r = runCli(f, 'plugins', ['enable', 'demo']);
    assert.equal(r.status, 0, `enable 应 exit 0，stderr：${r.stderr}`);
    const doc = JSON.parse(readFileSync(path.join(f.proj, '.sunshinex', 'settings.json'), 'utf8')) as {
      plugins?: Record<string, { enabled?: boolean }>;
    };
    assert.equal(doc.plugins?.['demo']?.enabled, true, '项目 settings 应落 plugins.demo.enabled=true');
    // disable 翻转
    assert.equal(runCli(f, 'plugins', ['disable', 'demo']).status, 0, 'disable 应 exit 0');
    const after = JSON.parse(readFileSync(path.join(f.proj, '.sunshinex', 'settings.json'), 'utf8')) as {
      plugins?: Record<string, { enabled?: boolean }>;
    };
    assert.equal(after.plugins?.['demo']?.enabled, false, 'disable 后 enabled 应翻转为 false');
  } finally {
    cleanupSpawn(f);
  }
});

test('enable --scope=global → HOME settings.json plugins.<id>.enabled 落键（用户级面）', () => {
  const f = makeSpawnFixture('global');
  try {
    mkUserPlugin(f, 'demo');
    const r = runCli(f, 'plugins', ['enable', 'demo', '--scope=global']);
    assert.equal(r.status, 0, `enable --scope=global 应 exit 0，stderr：${r.stderr}`);
    const doc = JSON.parse(readFileSync(path.join(f.home, '.sunshinex', 'settings.json'), 'utf8')) as {
      plugins?: Record<string, { enabled?: boolean }>;
    };
    assert.equal(doc.plugins?.['demo']?.enabled, true, 'global settings 应落 plugins.demo.enabled=true');
    assert.equal(existsSync(path.join(f.proj, '.sunshinex', 'settings.json')), false, 'global 写不应触项目文件');
  } finally {
    cleanupSpawn(f);
  }
});

test('enable 未知 id → error + exit 1（catalog 严格语义：无装载态的 id 无从写）', () => {
  const f = makeSpawnFixture('unknown');
  try {
    mkUserPlugin(f, 'demo');
    const r = runCli(f, 'plugins', ['enable', 'nosuch']);
    assert.equal(r.status, 1, '未知 id 应 exit 1');
    assert.ok((r.stderr ?? '').includes('not found'), `应上屏 plugin not found：${JSON.stringify(r.stderr)}`);
    assert.equal(existsSync(path.join(f.proj, '.sunshinex', 'settings.json')), false, '拒绝写零盘上副作用');
  } finally {
    cleanupSpawn(f);
  }
});

/** 造一个技能条目（{root}/skills/{id}/SKILL.md，frontmatter 两件套 + 正文） */
function mkSkill(skillsRoot: string, id: string, name: string): void {
  const dir = path.join(skillsRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${id} skill\n---\nbody of ${id}\n`, 'utf8');
}

test('skills list：表格含来源列（project/user），同 id 跨源 --json 标 shadowedBy', () => {
  const f = makeSpawnFixture('skills');
  try {
    // 项目段：.sunshinex/skills/alpha；用户段（SUNSHINEX_USER_SKILLS_DIR 钉）：alpha（被项目遮蔽）+ beta
    mkSkill(path.join(f.proj, '.sunshinex', 'skills'), 'alpha', 'Alpha');
    mkSkill(path.join(f.home, 'user-skills'), 'alpha', 'Alpha User');
    mkSkill(path.join(f.home, 'user-skills'), 'beta', 'Beta');
    const r = runCli(f, 'skills', ['list']);
    assert.equal(r.status, 0, `skills list 应 exit 0，stderr：${r.stderr}`);
    const out = r.stdout ?? '';
    assert.ok(out.includes('alpha') && out.includes('beta'), `表格应含技能 id：${JSON.stringify(out)}`);
    assert.ok(out.includes('project') && out.includes('user'), `表格应含来源列值（来源列）：${JSON.stringify(out)}`);
    const j = runCli(f, 'skills', ['list', '--json']);
    assert.equal(j.status, 0, `skills list --json 应 exit 0，stderr：${j.stderr}`);
    const entries = JSON.parse(j.stdout ?? '') as Array<{ id: string; source: string; shadowedBy?: string }>;
    const projAlpha = entries.find((e) => e.id === 'alpha' && e.source === 'project');
    const userAlpha = entries.find((e) => e.id === 'alpha' && e.source === 'user');
    assert.ok(projAlpha && userAlpha, '跨源同 id 两行都应在列');
    assert.equal(userAlpha!.shadowedBy, 'project', '用户段 alpha 应标被 project 遮蔽');
    assert.equal(projAlpha!.shadowedBy, undefined, '正选（project）不带遮蔽标注');
    assert.ok(entries.some((e) => e.id === 'beta' && e.source === 'user'), 'beta 应在 user 段');
    // --scope=project 过滤：只剩项目段
    const p = runCli(f, 'skills', ['list', '--scope=project', '--json']);
    const projOnly = JSON.parse(p.stdout ?? '') as Array<{ source: string }>;
    assert.ok(projOnly.length > 0 && projOnly.every((e) => e.source === 'project'), '--scope=project 应只留项目段');
  } finally {
    cleanupSpawn(f);
  }
});
