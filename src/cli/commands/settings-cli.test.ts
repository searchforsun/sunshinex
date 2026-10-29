import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * settings get/set 子命令端到端验收（Task 18）：spawn dist/cli/index.js 真子进程（mcp.test 先例：
 * HOME 重定向 + SUNSHINEX_* 显式清场，父测试进程态零污染）。
 * 用例对齐 brief：① get 历史退役键 model → 未知键口径 + exit 1（2026-10-29 撤退役专属指引面）
 * ② set language（project 缺省）→ settings.json
 * 落键 + get → 值+来源 ③ get language（env 真导出）→ source env + override 标注 ④ set --scope=global
 * → HOME settings.json 落键 ⑤ 注释文件走 surgical 手术（注释保真）⑥ 未知键/裸命令 → exit 1。
 * 来源归因依赖 CLI 入口 main 先跑 loadSettingsChain（selfFilledSlots 登记）——get 的 env/project/
 * global/default 判定与 GUI /settings 同源（effectiveKeyRow 单点）。
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface Fixture {
  home: string;
  proj: string;
}

function makeFixture(tag: string): Fixture {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), `setcli-${tag}-home-`)),
    proj: fs.mkdtempSync(path.join(os.tmpdir(), `setcli-${tag}-proj-`)),
  };
}

function cleanup(f: Fixture): void {
  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.proj, { recursive: true, force: true });
}

/** spawn dist CLI：cwd = 临时项目，env 桩 = HOME 重定向 + 数据目录隔离；overrides 里 undefined 值 = 从 env 删键
 *  （get 的来源断言需要摘掉 SUNSHINEX_LANGUAGE 钉——真导出会让来源恒判 env） */
function runCli(f: Fixture, args: string[], overrides: Record<string, string | undefined> = {}): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: f.home,
    SUNSHINEX_DATA_DIR: path.join(f.home, 'data'),
    SUNSHINEX_USER_SKILLS_DIR: path.join(f.home, 'user-skills'),
    SUNSHINEX_GLOBAL_SUNSHINE: path.join(f.home, 'SUNSHINE.md'),
    SUNSHINEX_LANGUAGE: 'en', // 钉 en：上屏文案断言不随宿主 settings/env 语言漂移
    ...overrides,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
  }
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'dist', 'cli', 'index.js'), 'settings', ...args], {
    cwd: f.proj,
    timeout: 60_000,
    encoding: 'utf8',
    env,
  });
}

function projSettings(f: Fixture): string {
  return path.join(f.proj, '.sunshinex', 'settings.json');
}

function globalSettings(f: Fixture): string {
  return path.join(f.home, '.sunshinex', 'settings.json');
}

test('① get 历史退役键 model → 未知键口径 + exit 1（零盘上副作用；专属指引面已删）', () => {
  const f = makeFixture('retired');
  try {
    const r = runCli(f, ['get', 'model']);
    assert.equal(r.status, 1, '退役键应 exit 1');
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    assert.ok(text.includes('model'), `错误应点名键名：${JSON.stringify(text)}`);
    assert.ok(/unknown settings key/i.test(text), '退役键走通用未知键口径（指引面已删）');
    assert.equal(fs.existsSync(projSettings(f)), false, 'get 不落盘');
  } finally {
    cleanup(f);
  }
});

test('② set language zh（project 缺省）→ settings.json 落键；get → 值 + 来源 project', () => {
  const f = makeFixture('setproj');
  try {
    const r = runCli(f, ['set', 'language', 'zh']);
    assert.equal(r.status, 0, `set 应 exit 0，stderr：${r.stderr}`);
    const doc = JSON.parse(fs.readFileSync(projSettings(f), 'utf8')) as Record<string, unknown>;
    assert.equal(doc['language'], 'zh', 'project settings 应落 language: "zh"（字符串）');
    assert.equal(doc['version'], 1, '新档应补 version: 1');
    // 来源断言：摘掉 SUNSHINEX_LANGUAGE 真导出钉——链装载自 project 文件 → source project
    const g = runCli(f, ['get', 'language'], { SUNSHINEX_LANGUAGE: undefined });
    assert.equal(g.status, 0, `get 应 exit 0，stderr：${g.stderr}`);
    const out = g.stdout ?? '';
    assert.ok(out.includes('zh'), `应上屏 effective 值：${JSON.stringify(out)}`);
    assert.ok(out.includes('project'), `应上屏来源 project：${JSON.stringify(out)}`);
  } finally {
    cleanup(f);
  }
});

test('③ get language（env 真导出钉）→ source env + env override 标注', () => {
  const f = makeFixture('getenv');
  try {
    const r = runCli(f, ['get', 'language'], { SUNSHINEX_LANGUAGE: 'en' });
    assert.equal(r.status, 0, `get 应 exit 0，stderr：${r.stderr}`);
    const out = r.stdout ?? '';
    assert.ok(out.includes('en'), `应上屏 effective 值：${JSON.stringify(out)}`);
    assert.ok(out.includes('env'), `应上屏来源 env：${JSON.stringify(out)}`);
    assert.ok(out.includes('override'), '真导出应带 env override 标注');
  } finally {
    cleanup(f);
  }
});

test('④ set --scope=global → HOME settings.json 落键（用户级面）', () => {
  const f = makeFixture('setglobal');
  try {
    const r = runCli(f, ['set', 'tier', 'medium', '--scope=global']);
    assert.equal(r.status, 0, `set --scope=global 应 exit 0，stderr：${r.stderr}`);
    const doc = JSON.parse(fs.readFileSync(globalSettings(f), 'utf8')) as Record<string, unknown>;
    assert.equal(doc['tier'], 'medium', 'global settings 应落 tier');
    assert.equal(fs.existsSync(projSettings(f)), false, 'global 写不应触项目文件');
  } finally {
    cleanup(f);
  }
});

test('⑤ 注释文件 → surgical 手术写：注释保真、只动目标键', () => {
  const f = makeFixture('surgical');
  try {
    fs.mkdirSync(path.join(f.proj, '.sunshinex'), { recursive: true });
    fs.writeFileSync(
      projSettings(f),
      '{\n  // user comment kept\n  "version": 1,\n  "language": "en"\n}\n',
      'utf8',
    );
    const r = runCli(f, ['set', 'language', 'zh']);
    assert.equal(r.status, 0, `注释文件 set 应 exit 0，stderr：${r.stderr}`);
    const raw = fs.readFileSync(projSettings(f), 'utf8');
    assert.ok(raw.includes('// user comment kept'), `注释应逐字保真：${JSON.stringify(raw)}`);
    const doc = JSON.parse(raw.replace(/\/\/ user comment kept/g, '')) as Record<string, unknown>;
    assert.equal(doc['language'], 'zh', '目标键应改写');
  } finally {
    cleanup(f);
  }
});

test('⑥ 非法面：未知键 get/set、裸 settings、set 退役键 → exit 1', () => {
  const f = makeFixture('bad');
  try {
    const unknown = runCli(f, ['get', 'noSuchKey']);
    assert.equal(unknown.status, 1, '未知键 get 应 exit 1');
    assert.ok((unknown.stderr ?? '').includes('noSuchKey'), `错误应点名键名：${JSON.stringify(unknown.stderr)}`);
    const unknownSet = runCli(f, ['set', 'noSuchKey', 'v']);
    assert.equal(unknownSet.status, 1, '未知键 set 应 exit 1');
    assert.equal(fs.existsSync(projSettings(f)), false, '拒绝写零盘上副作用');
    const retiredSet = runCli(f, ['set', 'model', 'gpt-x']);
    assert.equal(retiredSet.status, 1, '退役键 set 应 exit 1');
    assert.ok(/unknown settings key/i.test(`${retiredSet.stderr ?? ''}`), '退役键 set 走通用未知键口径（指引面已删）');
    const bare = runCli(f, []);
    assert.equal(bare.status, 1, '裸 settings 应 exit 1');
    assert.ok(/Usage: sunshinex settings/.test(bare.stderr ?? ''), `应上屏 usage 行：${JSON.stringify(bare.stderr)}`);
  } finally {
    cleanup(f);
  }
});
