/**
 * catalog/skills 测试（Task 12）：来源链 + 跨源遮蔽标注的只读视图。
 * 环境桩沿 harness/skills.test.ts 先例：SUNSHINEX_USER_SKILLS_DIR 钉 user 根、SUNSHINEX_DATA_DIR
 * 钉 learned 根（resolveDataDir 直指覆盖），插件根经 opts.pluginSkillDirs 显式钉（免真写插件根，
 * 沿 priorityChain 尾参测试口径）——全程禁直写真实 ~/.sunshinex。
 * 断言口径：组序（project>user>learned>plugin）与目录序（先传目录先列）钉死；同目录内条目次序是
 * readdir 序（平台相关），按 (source,id) 定位断言、不按位置钉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listSkills } from './skills';

/** 钉环境桩跑用例：项目 tmp root + user 根 + 数据（learned）根全重定向，退出恢复（沿 harness 先例） */
function withPinnedEnv<T>(fn: (root: string, userDir: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-skills-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-skills-user-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevUser = process.env.SUNSHINEX_USER_SKILLS_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(root, '.data');
  process.env.SUNSHINEX_USER_SKILLS_DIR = userDir;
  try {
    return fn(root, userDir);
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
    if (prevUser === undefined) delete process.env.SUNSHINEX_USER_SKILLS_DIR;else process.env.SUNSHINEX_USER_SKILLS_DIR = prevUser;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

/** 写一个技能条目（SKILL.md 标准名，frontmatter 三件套齐全），返回条目目录备 sourceDir 断言 */
function writeSkill(base: string, id: string, name: string, version = '1.0.0'): string {
  fs.mkdirSync(path.join(base, id), { recursive: true });
  fs.writeFileSync(
    path.join(base, id, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 说明\nversion: ${version}\n---\n${name} 正文`,
  );
  return path.join(base, id);
}

test('listSkills：项目与 user 同 id——项目正选、user 条目 shadowedBy 为来源名 project', () => {
  withPinnedEnv((root, userDir) => {
    const projXDir = writeSkill(path.join(root, '.sunshinex', 'skills'), 'x', 'ProjX', '2.0.0');
    const userXDir = writeSkill(userDir, 'x', 'UserX');
    writeSkill(path.join(root, '.sunshinex', 'skills'), 'proj-only', 'ProjOnly');
    writeSkill(userDir, 'user-only', 'UserOnly');
    const { entries, warnings } = listSkills(root, { pluginSkillDirs: [] });
    assert.deepEqual(warnings, [], '正常列举零告警（Listing 形态在场）');
    assert.deepEqual(entries.map((e) => e.source), ['project', 'project', 'user', 'user'], '组序：project 全部在前、user 在后');
    const px = entries.find((e) => e.source === 'project' && e.id === 'x');
    const ux = entries.find((e) => e.source === 'user' && e.id === 'x');
    assert.ok(px && ux, '同 id 跨源两源各一条（视图全量列出）');
    assert.equal(entries.length, 4, '零多列零漏列');
    assert.equal(px?.shadowedBy, undefined, '链上最高优先来源 = 正选，无遮蔽标注');
    assert.equal(px?.name, 'ProjX');
    assert.equal(px?.description, 'ProjX 说明');
    assert.equal(px?.version, '2.0.0');
    assert.equal(px?.sourceDir, projXDir, 'sourceDir = 技能条目自身目录');
    assert.equal(ux?.shadowedBy, 'project', '遮蔽标注为胜者来源名（非 id）');
    assert.equal(ux?.name, 'UserX', '被遮蔽条目保留自身内容（装载面才就近取一份）');
    assert.equal(ux?.sourceDir, userXDir);
  });
});

test('listSkills：三源同 id——user 与 learned 均标 shadowedBy:project（胜者恒链上最高优先者）', () => {
  withPinnedEnv((root, userDir) => {
    writeSkill(path.join(root, '.sunshinex', 'skills'), 'dup', 'ProjDup');
    writeSkill(userDir, 'dup', 'UserDup');
    writeSkill(path.join(root, '.data', 'skills'), 'dup', 'LearnedDup');
    writeSkill(path.join(root, '.data', 'skills'), 'learned-only', 'LearnedOnly');
    const { entries } = listSkills(root, { pluginSkillDirs: [] });
    assert.deepEqual(entries.map((e) => e.source), ['project', 'user', 'learned', 'learned'], '组序 project>user>learned');
    const at = (source: string, id: string): string | undefined =>
      entries.find((e) => e.source === source && e.id === id)?.shadowedBy;
    assert.equal(at('project', 'dup'), undefined, '正选无标注');
    assert.equal(at('user', 'dup'), 'project');
    assert.equal(at('learned', 'dup'), 'project', 'learned 遮蔽标注指向最高优先胜者 project（非相邻 user）');
    assert.equal(at('learned', 'learned-only'), undefined, '无撞名条目不标遮蔽');
  });
});

test('listSkills：plugin 来源经 opts 钉根——plugin 组排尾、同 id 标 shadowedBy:learned、目录序保持', () => {
  withPinnedEnv((root, _userDir) => {
    const pluginA = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-skills-plugina-'));
    const pluginB = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-skills-pluginb-'));
    try {
      writeSkill(path.join(root, '.data', 'skills'), 'shared', 'LearnedShared');
      const pluginSharedDir = writeSkill(pluginA, 'shared', 'PluginShared');
      writeSkill(pluginA, 'plugin-a-only', 'PluginAOnly');
      writeSkill(pluginB, 'plugin-b-only', 'PluginBOnly');
      const { entries } = listSkills(root, { pluginSkillDirs: [pluginA, pluginB] });
      assert.deepEqual(entries.map((e) => e.source), ['learned', 'plugin', 'plugin', 'plugin'], 'plugin 组恒排尾（learned 之后）');
      const shared = entries.find((e) => e.source === 'plugin' && e.id === 'shared');
      assert.ok(shared, 'plugin 段同 id 条目在列');
      assert.equal(shared?.shadowedBy, 'learned');
      assert.equal(shared?.sourceDir, pluginSharedDir);
      assert.equal(entries.find((e) => e.id === 'plugin-a-only')?.shadowedBy, undefined);
      assert.equal(entries.find((e) => e.id === 'plugin-b-only')?.shadowedBy, undefined);
      // 目录序：先传目录（pluginA）的全部条目先于后传目录（pluginB）——组内沿链目录现序
      const idxA = entries.findIndex((e) => e.id === 'plugin-a-only');
      const idxB = entries.findIndex((e) => e.id === 'plugin-b-only');
      assert.ok(idxA > -1 && idxA < idxB, '插件目录按传入序出条目');
    } finally {
      fs.rmSync(pluginA, { recursive: true, force: true });
      fs.rmSync(pluginB, { recursive: true, force: true });
    }
  });
});

test('listSkills：组内同 id 就近去重（project 双根与 plugin 双目录各只列一条、不标遮蔽）', () => {
  withPinnedEnv((root) => {
    const pluginA = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-skills-da-'));
    const pluginB = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-skills-db-'));
    try {
      // .sunshinex 与 .claude 同属 project 组：组内去重沿 loadSkillsGrouped 现序（.sunshinex 就近胜出）
      writeSkill(path.join(root, '.sunshinex', 'skills'), 'inner', 'SunshineInner');
      writeSkill(path.join(root, '.claude', 'skills'), 'inner', 'ClaudeInner');
      writeSkill(pluginA, 'plug', 'PluginA');
      writeSkill(pluginB, 'plug', 'PluginB');
      const { entries } = listSkills(root, { pluginSkillDirs: [pluginA, pluginB] });
      assert.deepEqual(
        entries.map((e) => [e.source, e.id, e.name, e.shadowedBy ?? null]),
        [
          ['project', 'inner', 'SunshineInner', null],
          ['plugin', 'plug', 'PluginA', null],
        ],
        '组内同 id 只列就近一条（沿装载链组内去重口径，败者静默让位非跨源遮蔽）',
      );
    } finally {
      fs.rmSync(pluginA, { recursive: true, force: true });
      fs.rmSync(pluginB, { recursive: true, force: true });
    }
  });
});

test('listSkills：零技能工作区——空条目空告警（Listing 降级形态，不抛）', () => {
  withPinnedEnv((root) => {
    const { entries, warnings } = listSkills(root, { pluginSkillDirs: [] });
    assert.deepEqual(entries, []);
    assert.deepEqual(warnings, []);
  });
});
