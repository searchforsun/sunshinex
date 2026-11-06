import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSkillsFacade, isSkillDisabled, loadSkillsGrouped, loadSkills } from './skills';

/**
 * 技能加载开关(2026-11-07 用户裁定「设置页技能卡片项目标签换加载开关,默认开启」+「项目名无法
 * 区分,需要绝对路径」):disabledSkills 落 settings 全局档(SEMANTIC_KEYS 标量槽 →
 * SUNSHINEX_DISABLED_SKILLS),值为逗号分隔的技能目录**绝对路径**(id 跨项目/跨来源撞名,路径才是
 * 唯一落点)。装配面过滤(loadSkills/facade.resolve),视图面不滤(loadSkillsGrouped 照列+带
 * disabled 标注职责在 serve 行标注)。本文件钉 env 直驱(与 settings 桥接面解耦)。
 */

/** 隔离环境:钉 data/user-skills/HOME 桩,保存/恢复 SUNSHINEX_DISABLED_SKILLS */
function withIsoEnv(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-disabled-'));
  const prev = {
    data: process.env.SUNSHINEX_DATA_DIR,
    user: process.env.SUNSHINEX_USER_SKILLS_DIR,
    home: process.env.HOME,
    disabled: process.env.SUNSHINEX_DISABLED_SKILLS,
  };
  process.env.SUNSHINEX_DATA_DIR = path.join(dir, '.data');
  process.env.SUNSHINEX_USER_SKILLS_DIR = path.join(dir, 'global-skills-root');
  process.env.HOME = path.join(dir, 'home');
  delete process.env.SUNSHINEX_DISABLED_SKILLS;
  try {
    fn(dir);
  } finally {
    if (prev.data === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prev.data;
    if (prev.user === undefined) delete process.env.SUNSHINEX_USER_SKILLS_DIR;else process.env.SUNSHINEX_USER_SKILLS_DIR = prev.user;
    if (prev.home === undefined) delete process.env.HOME;else process.env.HOME = prev.home;
    if (prev.disabled === undefined) delete process.env.SUNSHINEX_DISABLED_SKILLS;else process.env.SUNSHINEX_DISABLED_SKILLS = prev.disabled;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const writeSkill = (root: string, id: string, name: string): string => {
  const dir = path.join(root, '.sunshinex', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.md'), `---\nname: ${name}\n---\n正文`);
  return dir;
};

test('loadSkills 过滤停用目录;loadSkillsGrouped 视图照列(开关要能拨回来)', () => {
  withIsoEnv((dir) => {
    const alphaDir = writeSkill(dir, 'alpha', 'Alpha');
    writeSkill(dir, 'beta', 'Beta');
    // 大小写/尾斜杠漂移(win32):settings 手写路径与 daemon 解析路径不必逐字一致
    const drifted = process.platform === 'win32' ? alphaDir.toUpperCase() + '\\' : alphaDir + '/';
    process.env.SUNSHINEX_DISABLED_SKILLS = `${drifted}, 不存在路径 `;
    const list = loadSkills(dir);
    assert.deepEqual(list.map((s) => s.id), ['beta'], '停用 alpha 不进装配面,beta 照常');
    assert.equal(isSkillDisabled(alphaDir), true, '判定单点命中(归一后)');
    assert.equal(isSkillDisabled(undefined), false, '无路径行恒不停用');
    // 视图面不滤:两组行照列且带 sourceDir(开关回拨依据)
    const groups = loadSkillsGrouped(dir);
    const ids = groups.find((g) => g.source === 'project')!.skills.map((s) => s.id).sort();
    assert.deepEqual(ids, ['alpha', 'beta'], '视图照列');
    for (const row of groups.find((g) => g.source === 'project')!.skills) {
      assert.equal(row.sourceDir, path.join(dir, '.sunshinex', 'skills', row.id), '行带落盘绝对路径');
    }
  });
});

test('facade.resolve 停用技能按未注册处理(SKILL_NOT_FOUND);未停用照常解析', () => {
  withIsoEnv((dir) => {
    const alphaDir = writeSkill(dir, 'alpha', 'Alpha');
    writeSkill(dir, 'beta', 'Beta');
    const facade = createSkillsFacade(dir);
    process.env.SUNSHINEX_DISABLED_SKILLS = alphaDir;
    assert.equal(facade.get('alpha'), undefined, 'get 走 loadSkills 过滤面');
    const r = facade.resolve('alpha');
    assert.equal(r.ok, false, '停用不可出牌');
    if (!r.ok) assert.equal(r.error.code, 'SKILL_NOT_FOUND');
    const ok2 = facade.resolve('beta');
    assert.equal(ok2.ok, true, '未停用照常解析');
  });
});

test('disabledSkills 缺省/空串=全开启(缺省语义)', () => {
  withIsoEnv((dir) => {
    writeSkill(dir, 'alpha', 'Alpha');
    assert.equal(loadSkills(dir).length, 1);
    process.env.SUNSHINEX_DISABLED_SKILLS = '  , ';
    assert.equal(loadSkills(dir).length, 1, '纯空白等价未配置');
  });
});
