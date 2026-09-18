import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSkillFrontmatter, loadSkills } from './skills';

test('parseSkillFrontmatter：--- 块内 key: value 提取', () => {
  const m = parseSkillFrontmatter('---\nname: TUI 技能\ndescription: 终端交互\nversion: 1.2.0\n---\n正文');
  assert.equal(m.name, 'TUI 技能');
  assert.equal(m.description, '终端交互');
  assert.equal(m.version, '1.2.0');
});

test('parseSkillFrontmatter：无 frontmatter 回默认值', () => {
  const m = parseSkillFrontmatter('只有正文，没有 frontmatter');
  assert.equal(m.name, '');
  assert.equal(m.description, '');
  assert.equal(m.version, '0.1.0');
});

test('loadSkills：扫描项目根 .sunshinex/skills/{id}/skill.md，无 skill.md 的目录被滤除，缺失目录返回空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevUser = process.env.SUNSHINEX_USER_SKILLS_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(dir, '.data');
  process.env.SUNSHINEX_USER_SKILLS_DIR = path.join(dir, 'global-skills-root');
  try {
    assert.deepEqual(loadSkills(dir), []);
    fs.mkdirSync(path.join(dir, '.sunshinex', 'skills', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.sunshinex', 'skills', 'beta'));
    fs.writeFileSync(path.join(dir, '.sunshinex', 'skills', 'alpha', 'skill.md'), '---\nname: Alpha\n---\n正文');
    const list = loadSkills(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'alpha');
    assert.equal(list[0].name, 'Alpha');
    assert.equal(list[0].version, '0.1.0');
    // 旧根 skills/ 不再被扫描（上新删旧，无兼容路径）
    fs.mkdirSync(path.join(dir, 'skills', 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'legacy', 'skill.md'), '---\nname: Legacy\n---\n旧位置');
    assert.ok(!loadSkills(dir).some((s) => s.id === 'legacy'), '旧 skills/ 根零扫描残留');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
    if (prevUser === undefined) delete process.env.SUNSHINEX_USER_SKILLS_DIR;else process.env.SUNSHINEX_USER_SKILLS_DIR = prevUser;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSkills 三根合并就近遮蔽：项目 .sunshinex/skills > 全局根 > 学习根，id 撞名 list 恒一', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-global-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevUser = process.env.SUNSHINEX_USER_SKILLS_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(dir, '.data');
  process.env.SUNSHINEX_USER_SKILLS_DIR = globalDir;
  const write = (base: string, id: string, name: string): void => {
    fs.mkdirSync(path.join(base, id), { recursive: true });
    fs.writeFileSync(path.join(base, id, 'skill.md'), `---\nname: ${name}\ndescription: d\nversion: 1.0.0\n---\n正文`);
  };
  try {
    write(path.join(dir, '.sunshinex', 'skills'), 'dup', 'ProjDup');
    write(path.join(dir, '.sunshinex', 'skills'), 'proj-only', 'ProjOnly');
    write(globalDir, 'dup', 'GlobalDup');
    write(globalDir, 'global-only', 'GlobalOnly');
    write(path.join(dir, '.data', 'skills'), 'dup', 'LearnedDup');
    write(path.join(dir, '.data', 'skills'), 'learned-only', 'LearnedOnly');
    const list = loadSkills(dir);
    assert.equal(list.filter((s) => s.id === 'dup').length, 1, '三级同 id list 恒一');
    assert.equal(list.find((s) => s.id === 'dup')?.name, 'ProjDup', '项目级就近遮蔽全局与学习');
    const ids = list.map((s) => s.id);
    assert.ok(ids.includes('global-only'), '全局根技能进入清单');
    assert.ok(ids.includes('learned-only'), '学习根技能进入清单');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
    if (prevUser === undefined) delete process.env.SUNSHINEX_USER_SKILLS_DIR;else process.env.SUNSHINEX_USER_SKILLS_DIR = prevUser;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  }
});
