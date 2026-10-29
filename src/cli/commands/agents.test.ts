import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * agents 子命令族端到端验收（Task 18）：spawn dist/cli/index.js 真子进程——CLI 全链
 * （parseArgs → dispatch → runAgents → catalog 读写面）原样走一遍，env 桩钉住 HOME/数据目录
 * （mcp.test 先例：HOME 重定向 + SUNSHINEX_* 显式清场，父测试进程态零污染）。
 * 用例对齐 brief：① add→list（含 --body-file 读入）② list --json 标注 scope/shadowed/
 * enabled ③ enable/disable 落 frontmatter ④ remove 移除 + not found ⑤ 缺 --name → usage + 零副作用。
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface Fixture {
  home: string;
  proj: string;
}

function makeFixture(tag: string): Fixture {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), `agentscli-${tag}-home-`)),
    proj: fs.mkdtempSync(path.join(os.tmpdir(), `agentscli-${tag}-proj-`)),
  };
}

function cleanup(f: Fixture): void {
  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.proj, { recursive: true, force: true });
}

/** spawn dist CLI：cwd = 临时项目（project 作用域锚），env 桩 = HOME 重定向 + 数据目录隔离 */
function runCli(f: Fixture, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'dist', 'cli', 'index.js'), 'agents', ...args], {
    cwd: f.proj,
    timeout: 60_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: f.home,
      SUNSHINEX_DATA_DIR: path.join(f.home, 'data'),
      SUNSHINEX_USER_SKILLS_DIR: path.join(f.home, 'user-skills'),
      SUNSHINEX_GLOBAL_SUNSHINE: path.join(f.home, 'SUNSHINE.md'),
      SUNSHINEX_LANGUAGE: 'en', // 钉 en：上屏文案断言（usage/error）不随宿主 settings/env 语言漂移
    },
  });
}

/** 项目新家 agent.md 落盘位（add/enable/disable 断言面） */
function agentMd(f: Fixture, id: string): string {
  return path.join(f.proj, '.sunshinex', 'agents', id, 'agent.md');
}

/** 前置 add（全旗标形态）：返回 body 文件路径供断言 */
function addReviewer(f: Fixture): string {
  const bodyPath = path.join(f.proj, 'body.md');
  fs.writeFileSync(bodyPath, 'You are a code reviewer.\nBe strict.', 'utf8');
  const r = runCli(f, [
    'add', 'reviewer',
    '--name=Reviewer',
    '--description=reviews code changes',
    '--memory',
    '--isolation=worktree',
    '--executor=internal-team',
    `--body-file=${bodyPath}`,
  ]);
  assert.equal(r.status, 0, `前置 add 应 exit 0，stderr：${r.stderr}`);
  return bodyPath;
}

test('① add（全旗标 + --body-file）→ agent.md 落盘 frontmatter 六件套 + 正文读入；list 表格可见', () => {
  const f = makeFixture('add');
  try {
    addReviewer(f);
    const md = fs.readFileSync(agentMd(f, 'reviewer'), 'utf8');
    assert.ok(md.includes('name: Reviewer'), `frontmatter 应含 name：${JSON.stringify(md)}`);
    assert.ok(md.includes('description: reviews code changes'), 'frontmatter 应含 description');
    assert.ok(md.includes('memory: true'), '--memory 应落 memory: true');
    assert.ok(md.includes('isolation: worktree'), 'frontmatter 应含 isolation');
    assert.ok(md.includes('executor: internal-team'), 'frontmatter 应含 executor');
    assert.ok(md.includes('Be strict.'), '正文应来自 --body-file 读入');
    const list = runCli(f, ['list']);
    assert.equal(list.status, 0, `list 应 exit 0，stderr：${list.stderr}`);
    assert.ok((list.stdout ?? '').includes('reviewer'), `表格应含条目 id：${JSON.stringify(list.stdout)}`);
    assert.ok((list.stdout ?? '').includes('Reviewer'), '表格应含 name 列值');
  } finally {
    cleanup(f);
  }
});

test('② list --json：条目标注 scope/shadowed/enabled 与 meta 字段', () => {
  const f = makeFixture('json');
  try {
    addReviewer(f);
    const r = runCli(f, ['list', '--json']);
    assert.equal(r.status, 0, `list --json 应 exit 0，stderr：${r.stderr}`);
    const entries = JSON.parse(r.stdout ?? '') as Array<{
      id: string; scope: string; shadowed: boolean;
      meta: { name: string; memory: boolean; isolation?: string; executor?: string; enabled: boolean };
    }>;
    assert.ok(Array.isArray(entries), '--json 应输出 JSON 数组');
    const e = entries.find((x) => x.id === 'reviewer');
    assert.ok(e, '数组应含 reviewer 条目');
    assert.equal(e!.scope, 'project');
    assert.equal(e!.shadowed, false, '新家条目无遮蔽');
    assert.equal('oldLocation' in e!, false, 'oldLocation 字段已随去兼容清理删除（两级视图）');
    assert.equal(e!.meta.name, 'Reviewer');
    assert.equal(e!.meta.memory, true);
    assert.equal(e!.meta.isolation, 'worktree');
    assert.equal(e!.meta.executor, 'internal-team');
    assert.equal(e!.meta.enabled, true, '缺省启用');
  } finally {
    cleanup(f);
  }
});

test('③ enable/disable 落 frontmatter enabled 行（翻转）', () => {
  const f = makeFixture('toggle');
  try {
    addReviewer(f);
    assert.ok(!fs.readFileSync(agentMd(f, 'reviewer'), 'utf8').includes('enabled:'), 'add 缺省不落 enabled 行');
    const off = runCli(f, ['disable', 'reviewer']);
    assert.equal(off.status, 0, `disable 应 exit 0，stderr：${off.stderr}`);
    assert.ok(fs.readFileSync(agentMd(f, 'reviewer'), 'utf8').includes('enabled: false'), 'disable 后应落 enabled: false');
    const on = runCli(f, ['enable', 'reviewer']);
    assert.equal(on.status, 0, `enable 应 exit 0，stderr：${on.stderr}`);
    assert.ok(fs.readFileSync(agentMd(f, 'reviewer'), 'utf8').includes('enabled: true'), 'enable 后应翻回 enabled: true');
  } finally {
    cleanup(f);
  }
});

test('④ remove 移除条目整目录；再 remove → exit 1 + not found', () => {
  const f = makeFixture('remove');
  try {
    addReviewer(f);
    const r = runCli(f, ['remove', 'reviewer']);
    assert.equal(r.status, 0, `remove 应 exit 0，stderr：${r.stderr}`);
    assert.equal(fs.existsSync(path.join(f.proj, '.sunshinex', 'agents', 'reviewer')), false, '条目目录应整体移除');
    const again = runCli(f, ['remove', 'reviewer']);
    assert.equal(again.status, 1, '重复 remove 应 exit 1');
    assert.ok((again.stderr ?? '').includes('not found'), `应上屏 not found：${JSON.stringify(again.stderr)}`);
  } finally {
    cleanup(f);
  }
});

test('⑤ add 缺 --name → usage + exit 1 + 零副作用', () => {
  const f = makeFixture('badadd');
  try {
    const r = runCli(f, ['add', 'x']);
    assert.equal(r.status, 1, '缺 --name 应 exit 1');
    assert.ok(/Usage: sunshinex agents/.test(r.stderr ?? ''), `应上屏 usage 行：${JSON.stringify(r.stderr)}`);
    assert.equal(fs.existsSync(path.join(f.proj, '.sunshinex', 'agents')), false, 'usage 错误不应建目录');
  } finally {
    cleanup(f);
  }
});
