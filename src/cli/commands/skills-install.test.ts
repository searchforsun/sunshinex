import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installSkillsFromDir, locateSkillDirs, hasSkillFile } from './skills-install';

/** 离线单测只覆盖纯函数面（目录定位 + 拷贝安装）；git 克隆与 CLI 出入口由 pnpm selfcheck 与探针覆盖 */

function makeSource(): string {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skills-src-'));
  fs.mkdirSync(path.join(src, 'skills', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(src, 'skills', 'not-a-skill'), { recursive: true });
  fs.mkdirSync(path.join(src, 'skills', 'bad id'), { recursive: true });
  fs.writeFileSync(path.join(src, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: demo\nversion: 0.1.0\n---\nbody\n');
  fs.writeFileSync(path.join(src, 'skills', 'not-a-skill', 'README.md'), 'no skill file\n');
  fs.writeFileSync(path.join(src, 'skills', 'bad id', 'SKILL.md'), '---\nname: x\ndescription: x\nversion: 0.1.0\n---\nx\n');
  return src;
}

test('locateSkillDirs：skills/ 候选目录命中优先于整仓平铺判定', () => {
  const src = makeSource();
  try {
    const r = locateSkillDirs(src);
    assert.equal(r.layout, 'candidate');
    assert.deepEqual(r.dirs, [path.join(src, 'skills')]);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('locateSkillDirs：无候选目录且根下直接含 {id}/SKILL.md 时整仓即技能集', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skills-flat-'));
  try {
    fs.mkdirSync(path.join(src, 'solo'));
    fs.writeFileSync(path.join(src, 'solo', 'SKILL.md'), '---\nname: solo\ndescription: s\nversion: 0.1.0\n---\nb\n');
    const r = locateSkillDirs(src);
    assert.equal(r.layout, 'flat-root');
    assert.deepEqual(r.dirs, [src]);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('locateSkillDirs：空仓返回空清单（调用方报错不静默）', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skills-empty-'));
  try {
    const r = locateSkillDirs(src);
    assert.deepEqual(r.dirs, []);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('installSkillsFromDir：只拷贝合法技能目录，非法 id 与无技能文件目录跳过', () => {
  const src = makeSource();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skills-dst-'));
  try {
    const r = installSkillsFromDir(path.join(src, 'skills'), target, false);
    assert.deepEqual(r.installed.sort(), ['alpha']);
    assert.equal(fs.existsSync(path.join(target, 'alpha', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(target, 'not-a-skill')), false);
    assert.equal(fs.existsSync(path.join(target, 'bad id')), false);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('installSkillsFromDir：已存在缺省跳过，--force 覆盖', () => {
  const src = makeSource();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skills-dst-'));
  try {
    installSkillsFromDir(path.join(src, 'skills'), target, false);
    fs.writeFileSync(path.join(src, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: v2\nversion: 0.2.0\n---\nnew\n');
    const skip = installSkillsFromDir(path.join(src, 'skills'), target, false);
    assert.deepEqual(skip.installed, []);
    assert.deepEqual(skip.skipped, ['alpha']);
    assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8').includes('0.1.0'), true, '跳过时旧内容保留');
    const force = installSkillsFromDir(path.join(src, 'skills'), target, true);
    assert.deepEqual(force.installed, ['alpha']);
    assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8').includes('0.2.0'), true, 'force 后内容更新');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('hasSkillFile：SKILL.md 优先、skill.md 兜底、皆缺为 false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skills-has-'));
  try {
    assert.equal(hasSkillFile(dir), false);
    fs.writeFileSync(path.join(dir, 'skill.md'), 'x\n');
    assert.equal(hasSkillFile(dir), true);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'x\n');
    assert.equal(hasSkillFile(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
