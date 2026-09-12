import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initSunshine, sunshineTemplate } from './sunshine-init';
import { loadSunshinex } from '../config';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-init-'));
}

test('sunshineTemplate：骨架含三大分区，提示行不以 - 开头（不入规则），依赖超 6 项截断', () => {
  const tpl = sunshineTemplate('demo', 12, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.match(tpl, /^# 项目名称\n/);
  assert.match(tpl, /^# 架构原则\n- 感知扫描（SunshineX \/init 生成）：12 个源码文件，依赖 7 项：a、b、c、d、e、f 等/m);
  assert.match(tpl, /^# 编码规范\n（/m);
});

test('initSunshine：空目录生成骨架，项目名取 package.json，loadSunshinex 可提取', () => {
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-app', dependencies: { koa: '*' } }));
    fs.writeFileSync(path.join(dir, 'src.ts'), '');
    const r = initSunshine(dir);
    assert.equal(r.created, true);
    const raw = fs.readFileSync(r.path, 'utf8');
    assert.ok(raw.includes('demo-app'), '项目名应取 package.json name');
    const ctx = loadSunshinex(dir);
    assert.equal(ctx?.name, 'demo-app');
    assert.ok(ctx?.architecture.length, '架构原则应被提取');
    assert.deepEqual(ctx?.rules, [], '占位说明不应被当作规则');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('initSunshine：无 package.json 时项目名回退目录名', () => {
  const dir = tmpdir();
  try {
    const r = initSunshine(dir);
    assert.equal(r.created, true);
    assert.ok(fs.readFileSync(r.path, 'utf8').includes(path.basename(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('initSunshine：已存在 SUNSHINE.md 时跳过不覆盖', () => {
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, 'SUNSHINE.md'), '# 项目名称\n已有配置\n');
    const r = initSunshine(dir);
    assert.equal(r.created, false);
    assert.equal(fs.readFileSync(r.path, 'utf8'), '# 项目名称\n已有配置\n', '已有文件不得被改写');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
