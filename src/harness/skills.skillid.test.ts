import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isValidSkillId, loadSkills, createSkillsFacade } from './skills';
import { resolveDataDir } from '../config/data-dir';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skill-id-'));
}

test('isValidSkillId：规范 id 单点口径', () => {
  assert.equal(isValidSkillId('project-analysis-playbook'), true, '小写字母+连字符');
  assert.equal(isValidSkillId('a'), true, '单字符合法');
  assert.equal(isValidSkillId('sqlite-vec-backend-4'), true, '数字段合法');
  assert.equal(isValidSkillId('分析一下项目'), false, '非 ASCII 非法');
  assert.equal(isValidSkillId('-lead'), false, '连字符开头非法');
  assert.equal(isValidSkillId('trail-'), false, '连字符结尾非法');
  assert.equal(isValidSkillId('a--b'), false, '连续连字符非法');
  assert.equal(isValidSkillId(''), false, '空串非法');
  assert.equal(isValidSkillId('CamelCase'), false, '大写非法（id 口径小写）');
});

test('装载面校验：非规范 id 目录跳过不装载、不遮蔽合法 id', () => {
  const root = tmp();
  try {
    const md = (n: string) => `---\nname: ${n}\ndescription: d\nversion: 1.0.0\n---\n正文`;
    // 非法 id（中文/大写/连字符开头）与合法 id 同根共存：只装载合法者
    for (const bad of ['分析一下项目', '分析一下项目-2', 'CamelCase', '-lead']) {
      fs.mkdirSync(path.join(root, '.sunshinex', 'skills', bad), { recursive: true });
      fs.writeFileSync(path.join(root, '.sunshinex', 'skills', bad, 'SKILL.md'), md(bad));
    }
    fs.mkdirSync(path.join(root, '.sunshinex', 'skills', 'good-one'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'skills', 'good-one', 'SKILL.md'), md('Good One'));
    const out = loadSkills(root);
    const ids = out.map((s) => s.id);
    assert.ok(!ids.some((i) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(i)), '装载产物全为规范 id');
    assert.ok(ids.includes('good-one'), '合法 id 照常装载');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolve 面：非规范 id 出牌即拒（含 learned 中文遗留目录）', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(resolveDataDir(root), 'skills', '分析一下项目'), { recursive: true });
    fs.writeFileSync(path.join(resolveDataDir(root), 'skills', '分析一下项目', 'skill.md'), '---\nname: settle:分析一下项目\ndescription: d\nversion: 1.0.0\n---\n正文');
    const facade = createSkillsFacade(root);
    const r = facade.resolve('分析一下项目');
    assert.equal(r.ok, false, '中文遗留目录不可被 resolve 命中');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
