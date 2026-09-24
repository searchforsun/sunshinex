import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * selfcheck 骨架行验收（Task 7）：isolation 上屏 + permissions 装配告警通道。
 * 缝位说明：landlock usable() 为进程级探测缓存且真实内核探针不入库——本文件经子进程直跑
 * dist 产物，用 --require 预载脚本在模块装载前 configureLandlockLoader 注入 fake，
 * 把「探测可用/不可用」钉成确定性输入（父测试进程态零污染）。
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface Fixture {
  home: string;
  root: string;
}

function makeFixture(tag: string): Fixture {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), `selfcheck-${tag}-home-`)),
    root: fs.mkdtempSync(path.join(os.tmpdir(), `selfcheck-${tag}-root-`)),
  };
}

function cleanup(f: Fixture): void {
  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.root, { recursive: true, force: true });
}

/** 生成预载脚本（.cjs 走 --require，require 已编译的 CommonJS landlock 模块单例，注入即生效） */
function writePreload(dir: string, probe: string): string {
  const p = path.join(dir, 'preload-landlock.cjs');
  const landlockDist = path.join(REPO_ROOT, 'dist', 'harness', 'security', 'landlock.js');
  fs.writeFileSync(
    p,
    [
      `// selfcheck 测试预载：真实内核探针不入库，loader 注入 fake（probe=${probe}）`,
      `const { configureLandlockLoader, resetLandlockProbe } = require(${JSON.stringify(landlockDist)});`,
      'configureLandlockLoader(async () => ({',
      "  launcherPath: () => '/fake/landlock-launcher',",
      `  probe: () => ${JSON.stringify(probe)},`,
      '  grantArgs: () => [],',
      '}));',
      'resetLandlockProbe();',
      '',
    ].join('\n'),
  );
  return p;
}

function runSelfcheck(f: Fixture, preload: string, extraEnv: Record<string, string>): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--require', preload, path.join(REPO_ROOT, 'dist', 'cli', 'index.js'), 'selfcheck'], {
    cwd: f.root,
    timeout: 60_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: f.home,
      SUNSHINEX_DATA_DIR: path.join(f.home, 'data'),
      SUNSHINEX_USER_SKILLS_DIR: path.join(f.home, 'user-skills'),
      SUNSHINEX_GLOBAL_SUNSHINE: path.join(f.home, 'SUNSHINE.md'),
      ...extraEnv,
    },
  });
}

test('selfcheck：isolation 行上屏——auto 探测可用 → landlock，紧随 shell 行，sandbox off 带标注', () => {
  const f = makeFixture('ok');
  try {
    const r = runSelfcheck(f, writePreload(f.home, 'ok'), {
      SUNSHINEX_SANDBOX: 'off',
      // 显式清空继承面：auto 语义（显式声明优先于探测，见 resolveIsolation 判定序）
      SUNSHINEX_ISOLATION: '',
    });
    assert.equal(r.status, 0, `selfcheck 退出码非 0，stderr：${r.stderr}`);
    const out = r.stdout ?? '';
    const shellAt = out.indexOf('shell   :');
    const isoAt = out.indexOf('isolation :');
    assert.ok(shellAt >= 0, 'shell 行在位（isolation 与既有行同构的锚点）');
    assert.ok(isoAt > shellAt, 'isolation 行在 shell 行之后上屏（简报位次）');
    // usable() 在非 Linux 直接短路 false（loader 不被消费），fake 只能钉 Linux 面——与 landlock.test.ts 同款平台分叉
    const expected = process.platform === 'linux' ? 'isolation : landlock (sandbox off)' : 'isolation : host (sandbox off)';
    assert.ok(out.includes(expected), `期望「${expected}」未上屏，实际片段：${JSON.stringify(out.slice(Math.max(0, isoAt - 40), isoAt + 80))}`);
  } finally {
    cleanup(f);
  }
});

test('selfcheck：isolation 行 auto 探测不可用 → 非 landlock 口径（进程级缓存固化的既成事实原样上屏，无 off 标注）', () => {
  const f = makeFixture('unusable');
  try {
    const r = runSelfcheck(f, writePreload(f.home, 'unusable'), { SUNSHINEX_ISOLATION: '', SUNSHINEX_SANDBOX: 'on' });
    assert.equal(r.status, 0, `selfcheck 退出码非 0，stderr：${r.stderr}`);
    const out = r.stdout ?? '';
    // auto 判定序（spec 5.5）：探测不可用 → 容器标记（/.dockerenv）→ host；期望值按本机标记计算（探针不入库，环境事实即输入）
    const expected = fs.existsSync('/.dockerenv') ? 'isolation : container' : 'isolation : host';
    assert.ok(out.includes(expected), `期望「${expected}」未上屏：${JSON.stringify(out.slice(-400))}`);
    assert.equal(out.includes('(sandbox off)'), false, '缺省 sandbox on，不得带 off 标注');
  } finally {
    cleanup(f);
  }
});

test('selfcheck：permissions 装配告警上屏——形状非法走 warnings 通道（permissions warn: 行）', () => {
  const f = makeFixture('warn');
  try {
    // 单级形状非法 → 该级整键忽略 + 告警（与 assembly.permissions.test.ts 同款夹具语义）
    fs.mkdirSync(path.join(f.home, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(f.home, '.sunshinex', 'settings.json'), JSON.stringify({ permissions: 'oops' }));
    const r = runSelfcheck(f, writePreload(f.home, 'ok'), {});
    assert.equal(r.status, 0, `selfcheck 退出码非 0，stderr：${r.stderr}`);
    const out = r.stdout ?? '';
    assert.ok(/^permissions warn: .+$/m.test(out), `期望「permissions warn:」行未上屏，stdout 尾部：${JSON.stringify(out.slice(-400))}`);
  } finally {
    cleanup(f);
  }
});
