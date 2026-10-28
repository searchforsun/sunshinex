import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * mcp 子命令族端到端验收（Task 17）：spawn dist/cli/index.js 真子进程——CLI 全链
 * （parseArgs → dispatch → runMcpCommand → catalog 读写面）原样走一遍，env 桩钉住
 * HOME/数据目录（selfcheck.test 的 runSelfcheck 先例：HOME 重定向 + SUNSHINEX_* 显式清场，
 * 父测试进程态零污染）。
 * 六用例对齐 brief：① add project 落盘 ② list 表格 ③ list --json ④ enable/disable 翻转
 * ⑤ approve/deny 写全局 settings ⑥ 缺 --command/--url → exit 1 + usage。
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface Fixture {
  home: string;
  proj: string;
}

function makeFixture(tag: string): Fixture {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), `mcpcli-${tag}-home-`)),
    proj: fs.mkdtempSync(path.join(os.tmpdir(), `mcpcli-${tag}-proj-`)),
  };
}

function cleanup(f: Fixture): void {
  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.proj, { recursive: true, force: true });
}

/** spawn dist CLI：cwd = 临时项目（project 作用域锚），env 桩 = HOME 重定向 + 数据目录隔离 */
function runCli(f: Fixture, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'dist', 'cli', 'index.js'), 'mcp', ...args], {
    cwd: f.proj,
    timeout: 60_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: f.home,
      SUNSHINEX_DATA_DIR: path.join(f.home, 'data'),
      SUNSHINEX_USER_SKILLS_DIR: path.join(f.home, 'user-skills'),
      SUNSHINEX_GLOBAL_SUNSHINE: path.join(f.home, 'SUNSHINE.md'),
      SUNSHINEX_LANGUAGE: 'en', // 钉 en：上屏文案断言（usage/hint）不随宿主 settings/env 语言漂移
    },
  });
}

/** 项目 mcp.json 读取（add/enable/disable 落盘断言面） */
function readProjMcp(f: Fixture): { mcpServers: Record<string, { command?: string; args?: string[]; enabled?: boolean; url?: string }> } {
  return JSON.parse(fs.readFileSync(path.join(f.proj, '.sunshinex', 'mcp.json'), 'utf8'));
}

/** 全局 settings.json 读取（approve/deny 落盘断言面） */
function readGlobalSettings(f: Fixture): { mcpApprovals?: Record<string, string[]>; mcpDenied?: Record<string, string[]> } {
  return JSON.parse(fs.readFileSync(path.join(f.home, '.sunshinex', 'settings.json'), 'utf8'));
}

test('① add（project）→ .sunshinex/mcp.json 落条目，--arg/--env 透传，附带 approve 指引', () => {
  const f = makeFixture('add');
  try {
    const r = runCli(f, ['add', 'fs', '--command=npx', '--arg=a', '--arg=b', '--env=K=V', '--scope=project']);
    assert.equal(r.status, 0, `add 应 exit 0，stderr：${r.stderr}`);
    const doc = readProjMcp(f);
    assert.deepEqual(doc.mcpServers['fs'], { command: 'npx', args: ['a', 'b'], env: { K: 'V' } });
    // 安全阀指引：project 作用域新增后提示首次加载需 approve
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    assert.ok(text.includes('approve'), `应提示 approve 指引：${JSON.stringify(text)}`);
    assert.ok(text.includes('mcp approve fs'), '指引应含完整命令形态');
  } finally {
    cleanup(f);
  }
});

test('② list 表格含新增条目名（fs）', () => {
  const f = makeFixture('list');
  try {
    assert.equal(runCli(f, ['add', 'fs', '--command=npx']).status, 0, '前置 add 应成功');
    const r = runCli(f, ['list']);
    assert.equal(r.status, 0, `list 应 exit 0，stderr：${r.stderr}`);
    assert.ok((r.stdout ?? '').includes('fs'), `表格应含条目名 fs：${JSON.stringify(r.stdout)}`);
  } finally {
    cleanup(f);
  }
});

test('③ list --json 输出可解析 JSON 数组，条目含 name/scope/approval', () => {
  const f = makeFixture('json');
  try {
    assert.equal(runCli(f, ['add', 'fs', '--command=npx']).status, 0, '前置 add 应成功');
    const r = runCli(f, ['list', '--json']);
    assert.equal(r.status, 0, `list --json 应 exit 0，stderr：${r.stderr}`);
    const entries = JSON.parse(r.stdout ?? '') as Array<{ name: string; scope: string; approval: string }>;
    assert.ok(Array.isArray(entries), '--json 应输出 JSON 数组');
    const fsEntry = entries.find((e) => e.name === 'fs');
    assert.ok(fsEntry, '数组应含 fs 条目');
    assert.equal(fsEntry!.scope, 'project');
    assert.equal(fsEntry!.approval, 'pending', 'project 新条目未审应为 pending');
  } finally {
    cleanup(f);
  }
});

test('④ enable/disable 翻转条目 enabled 键', () => {
  const f = makeFixture('toggle');
  try {
    assert.equal(runCli(f, ['add', 'fs', '--command=npx']).status, 0, '前置 add 应成功');
    assert.equal(runCli(f, ['disable', 'fs']).status, 0, 'disable 应 exit 0');
    assert.equal(readProjMcp(f).mcpServers['fs']!.enabled, false, 'disable 后 enabled 应为 false');
    assert.equal(runCli(f, ['enable', 'fs']).status, 0, 'enable 应 exit 0');
    assert.equal(readProjMcp(f).mcpServers['fs']!.enabled, true, 'enable 后 enabled 应翻回 true');
  } finally {
    cleanup(f);
  }
});

test('⑤ approve/deny 写全局 settings（mcpApprovals/mcpDenied 互斥除名，HOME 桩）', () => {
  const f = makeFixture('approve');
  try {
    assert.equal(runCli(f, ['add', 'fs', '--command=npx']).status, 0, '前置 add 应成功');
    const ap = runCli(f, ['approve', 'fs']);
    assert.equal(ap.status, 0, `approve 应 exit 0，stderr：${ap.stderr}`);
    const approved = readGlobalSettings(f);
    const slugKeys = Object.keys(approved.mcpApprovals ?? {});
    assert.equal(slugKeys.length, 1, '应有且一个项目 slug 槽');
    assert.deepEqual(approved.mcpApprovals![slugKeys[0]!], ['fs'], 'mcpApprovals 应含 fs');
    assert.equal(runCli(f, ['deny', 'fs']).status, 0, 'deny 应 exit 0');
    const denied = readGlobalSettings(f);
    const deniedKeys = Object.keys(denied.mcpDenied ?? {});
    assert.equal(deniedKeys.length, 1, 'deny 应记入 mcpDenied');
    assert.deepEqual(denied.mcpDenied![deniedKeys[0]!], ['fs']);
    assert.deepEqual(denied.mcpApprovals![deniedKeys[0]!], [], 'deny 后应对向除名（互斥维护）');
  } finally {
    cleanup(f);
  }
});

test('⑥ add 缺 --command/--url → exit 1 + usage 行（非法参数口径）', () => {
  const f = makeFixture('badadd');
  try {
    const r = runCli(f, ['add', 'fs']);
    assert.equal(r.status, 1, '缺 --command/--url 应 exit 1');
    assert.ok(/Usage: sunshinex mcp/.test(r.stderr ?? ''), `应上屏 usage 行：${JSON.stringify(r.stderr)}`);
    // 非法参数不得落盘（零副作用）
    assert.equal(fs.existsSync(path.join(f.proj, '.sunshinex', 'mcp.json')), false, 'usage 错误不应写 mcp.json');
  } finally {
    cleanup(f);
  }
});
