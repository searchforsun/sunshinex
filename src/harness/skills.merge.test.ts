import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSkillsFacade } from './skills';
import { LearnedSkillStore } from './skills/learned';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skillmerge-'));
}

/** 项目根技能：写 <root>/.sunshinex/skills/{id}/skill.md（三级根之项目级） */
function writeUserSkill(root: string, id: string, name: string): void {
  fs.mkdirSync(path.join(root, '.sunshinex', 'skills', id), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshinex', 'skills', id, 'skill.md'), `---\nname: ${name}\ndescription: 项目级技能\nversion: 1.0.0\n---\n项目版正文`);
}

/** 全局根技能：写 SUNSHINEX_USER_SKILLS_DIR 指向的 {id}/skill.md（三级根之全局级，用例内先重定向） */
function writeGlobalSkill(base: string, id: string, name: string): void {
  fs.mkdirSync(path.join(base, id), { recursive: true });
  fs.writeFileSync(path.join(base, id, 'skill.md'), `---\nname: ${name}\ndescription: 全局技能\nversion: 1.0.0\n---\n全局版正文`);
}

/** 三根用例环境复原对：学习根随 SUNSHINEX_DATA_DIR、全局根随 SUNSHINEX_USER_SKILLS_DIR 重定向 */
function restoreEnv(prevData: string | undefined, prevUser: string | undefined): void {
  if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
  if (prevUser === undefined) delete process.env.SUNSHINEX_USER_SKILLS_DIR;else process.env.SUNSHINEX_USER_SKILLS_DIR = prevUser;
}

test('项目根+学习根并存：学习技能可 list/get/resolve，与项目技能并存', () => {
  const root = makeRoot();
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevUser = process.env.SUNSHINEX_USER_SKILLS_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(root, '.data');
  process.env.SUNSHINEX_USER_SKILLS_DIR = path.join(root, 'global-skills');
  try {
    writeUserSkill(root, 'greet', 'Greet');
    new LearnedSkillStore(root).settle('数据库巡检手册', '每日巡检步骤……');
    const facade = createSkillsFacade(root);
    const ids = facade.list().map((s) => s.id);
    assert.ok(ids.includes('greet'), '项目技能仍在');
    assert.ok(ids.includes('数据库巡检手册'), '学习技能进入清单');
    assert.ok(facade.get('数据库巡检手册'), 'get 可见学习技能');
    const r = facade.resolve('数据库巡检手册');
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.value.body.includes('每日巡检步骤'), 'resolve 学习技能走同一三态语义');
  } finally {
    restoreEnv(prevData, prevUser);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('id 撞名三级遮蔽：项目 > 全局 > 学习，list 恒一且项目版胜出', () => {
  const root = makeRoot();
  const globalDir = path.join(root, 'global-skills');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevUser = process.env.SUNSHINEX_USER_SKILLS_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(root, '.data');
  process.env.SUNSHINEX_USER_SKILLS_DIR = globalDir;
  try {
    writeUserSkill(root, 'dup', 'ProjDup');
    writeGlobalSkill(globalDir, 'dup', 'GlobalDup');
    const r = new LearnedSkillStore(root).settle('dup', '机器版');
    assert.ok(r.ok && r.value === 'dup');
    const facade = createSkillsFacade(root);
    const hits = facade.list().filter((s) => s.id === 'dup');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, 'ProjDup');
    const resolved = facade.resolve('dup');
    assert.ok(resolved.ok);
    if (resolved.ok) assert.ok(resolved.value.body.includes('项目版正文'), '项目级胜出');
  } finally {
    restoreEnv(prevData, prevUser);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('无 .data/skills 目录：零影响，learnedCount 为 0', () => {
  const root = makeRoot();
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevUser = process.env.SUNSHINEX_USER_SKILLS_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(root, '.data');
  process.env.SUNSHINEX_USER_SKILLS_DIR = path.join(root, 'global-skills');
  try {
    writeUserSkill(root, 'greet', 'Greet');
    const facade = createSkillsFacade(root);
    assert.equal(facade.list().length, 1);
    assert.equal(facade.learnedCount(), 0);
  } finally {
    restoreEnv(prevData, prevUser);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolve 回退链：项目未注册→全局根命中→学习根兜底；项目根 PARAM_MISSING 不回退', () => {
  const root = makeRoot();
  const globalDir = path.join(root, 'global-skills');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevUser = process.env.SUNSHINEX_USER_SKILLS_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(root, '.data');
  process.env.SUNSHINEX_USER_SKILLS_DIR = globalDir;
  try {
    writeGlobalSkill(globalDir, 'greet', 'GlobalGreet');
    new LearnedSkillStore(root).settle('deploy', '部署步骤……');
    const facade = createSkillsFacade(root);
    const g = facade.resolve('greet');
    assert.ok(g.ok && g.value.body.includes('全局版正文'), '项目未注册→全局根命中');
    const l = facade.resolve('deploy');
    assert.ok(l.ok && l.value.body.includes('部署步骤'), '项目与全局均未注册→学习根兜底');
    // 项目根放同 id 缺参版本：PARAM_MISSING 不回退全局根（就近优先，语义钉死）
    fs.mkdirSync(path.join(root, '.sunshinex', 'skills', 'greet'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'skills', 'greet', 'skill.md'), '---\nname: ProjGreet\nparams: name\n---\n你好 {{name}}');
    const miss = facade.resolve('greet');
    assert.ok(!miss.ok && miss.error.code === 'SKILL_PARAM_MISSING', '项目根缺参不回退全局根');
  } finally {
    restoreEnv(prevData, prevUser);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('selfcheck 输出含学习技能行（learned: N，空目录显示 0 不崩溃）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-selfcheck-'));
  try {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const p = spawnSync(process.execPath, [path.join(repoRoot, 'dist', 'cli', 'index.js'), 'selfcheck'], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, SUNSHINEX_DATA_DIR: path.join(tmp, '.data'), SUNSHINEX_USER_SKILLS_DIR: path.join(tmp, 'user-skills') },
    });
    assert.equal(p.status, 0, `selfcheck 退出码 ${p.status}：${p.stderr}`);
    // selfcheck 数字行在 TTY/FORCE_COLOR 下带 ANSI 着色（管道缺省无色），断言前剥离保证用例 TTY 无关
    const plain = p.stdout.replace(/\x1B\[[0-9;]*m/g, '');
    assert.match(plain, /learned\s*:\s*0/, '应含 learned 行且空目录显示 0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
