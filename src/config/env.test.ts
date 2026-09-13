import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadEnv, loadGlobalEnv, parseDotenv, userConfigDir } from './env';

test('parseDotenv：KEY=VALUE / 引号 / 注释 / 非法行', () => {
  const kv = parseDotenv([
    '# 注释行',
    '',
    'A=1',
    'B="quoted value"',
    "C='single'",
    'D=a=b',
    'no_equal_sign',
    '1bad=x',
    '  E = spaced  ',
  ].join('\n'));
  assert.deepEqual(kv, { A: '1', B: 'quoted value', C: 'single', D: 'a=b', E: 'spaced' });
});

test('loadEnv：装载缺失键且不覆盖已导出环境变量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  fs.writeFileSync(path.join(dir, '.env'), 'DOTENV_T1=from-file\nDOTENV_T2=also-file\n');
  process.env.DOTENV_T1 = 'already-set';
  try {
    const n = loadEnv(dir);
    assert.equal(process.env.DOTENV_T1, 'already-set');
    assert.equal(process.env.DOTENV_T2, 'also-file');
    assert.ok(n >= 1);
  } finally {
    delete process.env.DOTENV_T1;
    delete process.env.DOTENV_T2;
  }
});

test('loadEnv：.env 缺失时返回 0 且不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-empty-'));
  assert.equal(loadEnv(dir), 0);
});

test('userConfigDir：指向用户家目录 .sunshinex（对标 ~/.claude 惯例）', () => {
  assert.equal(userConfigDir(), path.join(os.homedir(), '.sunshinex'));
});

test('loadGlobalEnv：~/.sunshinex/.env 作全局缺省，三级优先级 shell > 项目 > 全局', () => {
  // HOME 重定向到临时目录：测试不触碰真实用户家目录（os.homedir 在 POSIX 读 $HOME、Windows 读 USERPROFILE）
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-home-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  const cfg = path.join(fakeHome, '.sunshinex');
  try {
    fs.mkdirSync(cfg, { recursive: true });
    // 全局层：T1/T3 兜底；项目层：T1 覆盖全局、T2 落地；shell：T2 已导出最高
    fs.writeFileSync(path.join(cfg, '.env'), 'GLOBALENV_T1=from-global\nGLOBALENV_T3=from-global-only\n');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-proj-'));
    fs.writeFileSync(path.join(proj, '.env'), 'GLOBALENV_T1=from-project\nGLOBALENV_T2=from-project\n');
    process.env.GLOBALENV_T2 = 'from-shell';
    // 按入口真实顺序装载（cli/index.ts 与 index.ts 同款）：项目级先装占位、全局后装仅补缺
    loadEnv(proj);
    loadGlobalEnv();
    assert.equal(process.env.GLOBALENV_T1, 'from-project', '项目级覆盖全局级');
    assert.equal(process.env.GLOBALENV_T2, 'from-shell', '已导出环境变量最高优先，项目级不覆盖');
    assert.equal(process.env.GLOBALENV_T3, 'from-global-only', '全局级兜底项目未配置的键');
    fs.rmSync(proj, { recursive: true, force: true });
  } finally {
    delete process.env.GLOBALENV_T1;
    delete process.env.GLOBALENV_T2;
    delete process.env.GLOBALENV_T3;
    if (prevHome === undefined) delete process.env.HOME;else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
