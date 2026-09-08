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

test('loadSkills：扫描 skills/{id}/skill.md，无 skill.md 的目录被滤除，缺失目录返回空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  try {
    assert.deepEqual(loadSkills(dir), []);
    fs.mkdirSync(path.join(dir, 'skills', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills', 'beta'));
    fs.writeFileSync(path.join(dir, 'skills', 'alpha', 'skill.md'), '---\nname: Alpha\n---\n正文');
    const list = loadSkills(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'alpha');
    assert.equal(list[0].name, 'Alpha');
    assert.equal(list[0].version, '0.1.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
