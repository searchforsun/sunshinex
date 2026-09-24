import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPermissions, matchAnyRule, matchPermission, pathGlobMatch } from './permissions';

function withHome(fn: (home: string, root: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-perm-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-perm-root-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fn(home, root);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeSettings(dir: string, body: object): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(body));
}

test('两级装载合并不遮蔽：deny 并集 + 去重', () => {
  withHome((home, root) => {
    writeSettings(path.join(home, '.sunshinex'), { permissions: { deny: ['Bash(rm*)', 'Read(**/.env)'] } });
    writeSettings(path.join(root, '.sunshinex'), {
      permissions: { deny: ['Read(**/.env)'], allow: ['Write(src/**)'], additionalDirs: ['../lib'] },
    });
    const { config, warnings } = loadPermissions(root);
    assert.equal(warnings.length, 0);
    assert.deepEqual(config.deny, ['Bash(rm*)', 'Read(**/.env)']);
    assert.deepEqual(config.allow, ['Write(src/**)']);
    assert.deepEqual(config.additionalDirs, ['../lib']);
  });
});

test('单级形状非法：该级警告跳过，另一级照常生效', () => {
  withHome((home, root) => {
    writeSettings(path.join(home, '.sunshinex'), { permissions: 'oops' });
    writeSettings(path.join(root, '.sunshinex'), { permissions: { deny: ['Bash(rm*)'] } });
    const { config, warnings } = loadPermissions(root);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes('须为对象'));
    assert.deepEqual(config.deny, ['Bash(rm*)']);
  });
});

test('deny 数组元素非字符串：该键警告忽略', () => {
  withHome((home, root) => {
    writeSettings(path.join(root, '.sunshinex'), { permissions: { deny: ['ok', 42] } });
    const { config, warnings } = loadPermissions(root);
    assert.equal(warnings.length, 1);
    assert.deepEqual(config.deny, []);
  });
});

test('两级均缺省：空配置零警告', () => {
  withHome((_home, root) => {
    const { config, warnings } = loadPermissions(root);
    assert.deepEqual(config, { deny: [], allow: [], additionalDirs: [] });
    assert.equal(warnings.length, 0);
  });
});

test('pathGlobMatch：** 跨段、* 不跨段、无 / 模式对 basename', () => {
  assert.equal(pathGlobMatch('**/.env', 'home/u/.env'), true);
  assert.equal(pathGlobMatch('**/.env', 'home/u/proj/.env'), true);
  assert.equal(pathGlobMatch('src/**', 'src/a/b.ts'), true);
  assert.equal(pathGlobMatch('src/**', 'lib/x.ts'), false);
  assert.equal(pathGlobMatch('a/**', 'a'), false);
  assert.equal(pathGlobMatch('*.pem', 'server.pem'), true);
  assert.equal(pathGlobMatch('*.pem', 'a/server.pem'), false);
  assert.equal(pathGlobMatch('src/*.ts', 'src/a.ts'), true);
  assert.equal(pathGlobMatch('src/*.ts', 'src/a/b.ts'), false);
});

test('matchPermission：Bash 前缀（尾 *）/ 精确、mcp 直名尾通配、文件工具按 specifiers 任一命中', () => {
  assert.equal(matchPermission('Bash(rm -rf*)', 'Bash', ['rm -rf /x']), true);
  assert.equal(matchPermission('Bash(ls)', 'Bash', ['ls -la']), false);
  assert.equal(matchPermission('Bash(ls)', 'Bash', ['ls']), true);
  assert.equal(matchPermission('mcp__legacy__*', 'mcp__legacy__query', ['']), true);
  assert.equal(matchPermission('mcp__legacy__query', 'mcp__legacy__other', ['']), false);
  const specifiers = ['home/u/proj/src/a.ts', 'src/a.ts', 'a.ts'];
  assert.equal(matchPermission('Write(src/**)', 'Write', specifiers), true);
  assert.equal(matchPermission('Write(*.ts)', 'Write', specifiers), true);
  assert.equal(matchPermission('Read(**/.env)', 'Read', ['home/u/.env']), true);
  assert.equal(matchAnyRule(['Bash(git*)', 'Write(src/**)'], 'Write', ['proj/src/a.ts', 'src/a.ts', 'a.ts']), true);
});
