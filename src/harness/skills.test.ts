import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSkillsFacade, formatSkillsIndex, parseSkillFrontmatter, loadSkills } from './skills';

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

/** 技能清单格式化（对标 Claude Code 常驻技能清单）：按 name 字典序排序（前置段字节冻结先例）、description 截断预算、空清单 null 零开销 */
test('formatSkillsIndex：空清单 null、按 name 排序、行格式与截断预算', () => {
  assert.equal(formatSkillsIndex([]), null, '空清单返回 null：零条目零开销注入');
  const out = formatSkillsIndex([
    { id: 'b', name: 'Beta', description: '后注册', version: '1.0.0' },
    { id: 'a', name: 'Alpha', description: 'd'.repeat(200), version: '1.0.0' },
  ]);
  assert.ok(out !== null);
  const lines = (out as string).split('\n');
  assert.equal(lines.length, 2, '每技能恰一行');
  assert.equal(lines[0], `- Alpha: ${'d'.repeat(128)}…`, '按 name 字典序 + 超长 description 截 128 加省略号');
  assert.equal(lines[1], '- Beta: 后注册');
});


/** 兼容链（规格 v2）：五根统一 {根}/skills/{id}/SKILL.md（Agent Skills 标准形态），异构形态零兼容 */
function writeCompatSkill(root: string, dot: string, id: string, name: string): void {
  fs.mkdirSync(path.join(root, dot, 'skills', id), { recursive: true });
  fs.writeFileSync(path.join(root, dot, 'skills', id, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 说明\nversion: 1.0.0\n---\n${name} 正文`);
}

function withCompatEnv<T>(root: string, fn: () => T): T {
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevUser = process.env.SUNSHINEX_USER_SKILLS_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(root, '.data');
  process.env.SUNSHINEX_USER_SKILLS_DIR = path.join(root, 'global-skills');
  try {
    return fn();
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
    if (prevUser === undefined) delete process.env.SUNSHINEX_USER_SKILLS_DIR;else process.env.SUNSHINEX_USER_SKILLS_DIR = prevUser;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('兼容链：五根统一 SKILL.md 标准形态，互不相同 id 全量并入清单', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-compat-'));
  withCompatEnv(root, () => {
    writeCompatSkill(root, '.cursor', 'a-skill', 'CursorSkill');
    writeCompatSkill(root, '.codex', 'b-skill', 'CodexSkill');
    writeCompatSkill(root, '.claude', 'c-skill', 'ClaudeSkill');
    writeCompatSkill(root, '.agents', 'd-skill', 'AgentsSkill');
    writeCompatSkill(root, '.sunshinex', 'e-skill', 'SunshineSkill');
    assert.deepEqual(loadSkills(root).map((s) => s.id).sort(), ['a-skill', 'b-skill', 'c-skill', 'd-skill', 'e-skill']);
  });
});

test('兼容链就近遮蔽：同 id 取最高优先根（.sunshinex 遮蔽 .agents/.claude），list 恒一', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-compat-'));
  withCompatEnv(root, () => {
    writeCompatSkill(root, '.claude', 'dup', 'ClaudeDup');
    writeCompatSkill(root, '.agents', 'dup', 'AgentsDup');
    writeCompatSkill(root, '.sunshinex', 'dup', 'SunshineDup');
    const hits = loadSkills(root).filter((s) => s.id === 'dup');
    assert.equal(hits.length, 1, '同 id 就近遮蔽、list 恒一');
    assert.equal(hits[0].name, 'SunshineDup');
  });
});

/**
 * 文件系统大小写敏感性探测：Windows/macOS 缺省不区分（`SKILL.md` 与 `skill.md` 是同一文件），
 * Linux 区分。测试用它区分平台前提，而不是把某一平台的 FS 语义编进断言。
 */
function fsIsCaseSensitive(dir: string): boolean {
  fs.writeFileSync(path.join(dir, 'CaseProbe.tmp'), '');
  const same = fs.existsSync(path.join(dir, 'caseprobe.tmp'));
  fs.rmSync(path.join(dir, 'CaseProbe.tmp'), { force: true });
  return !same;
}

test('标准文件名口径：SKILL.md 优先、skill.md 兜底', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-compat-'));
  withCompatEnv(root, () => {
    writeCompatSkill(root, '.sunshinex', 'upper', 'UpperName');
    fs.mkdirSync(path.join(root, '.sunshinex', 'skills', 'lower'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'skills', 'lower', 'skill.md'), '---\nname: LowerName\ndescription: 小写兜底\nversion: 1.0.0\n---\n正文');
    // 兜底：仅小写文件名时照常装载（Linux 必须显式补齐才与 Windows/macOS 装载结果一致）
    assert.deepEqual(loadSkills(root).map((s) => s.id).sort(), ['lower', 'upper']);
    assert.equal(loadSkills(root).find((s) => s.id === 'lower')?.name, 'LowerName', 'skill.md 兜底装载');

    if (fsIsCaseSensitive(root)) {
      // 并存优先仅大小写敏感文件系统可构造：不敏感平台上两个文件名指向同一文件，不存在并存态
      fs.writeFileSync(path.join(root, '.sunshinex', 'skills', 'upper', 'skill.md'), '---\nname: LowerUpper\ndescription: 小写同名\nversion: 1.0.0\n---\n正文');
      assert.equal(loadSkills(root).find((s) => s.id === 'upper')?.name, 'UpperName', '同 id 并存时 SKILL.md 优先');
    } else {
      // 不敏感平台：写 skill.md 即覆写同一文件（登记的 FS 事实），断言退化为「口径仍取 SKILL.md 位置」
      fs.writeFileSync(path.join(root, '.sunshinex', 'skills', 'upper', 'skill.md'), '---\nname: LowerUpper\ndescription: 小写同名\nversion: 1.0.0\n---\n正文');
      assert.equal(loadSkills(root).find((s) => s.id === 'upper')?.name, 'LowerUpper', '大小写不敏感平台两名为同一文件，读取最新内容');
    }
  });
});

test('异构形态零装载：rules/*.mdc、AGENTS.md、commands/*.md 就位不进清单', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-compat-'));
  withCompatEnv(root, () => {
    fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor', 'rules', 'x.mdc'), '---\ndescription: 规则\n---\n规则正文');
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'AGENTS.md'), '# 指令文件\n正文');
    fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'commands', 'y.md'), '---\nname: Cmd\n---\n正文');
    assert.deepEqual(loadSkills(root), [], '异构形态一律不装载');
  });
});

test('resolve 回退链跨兼容根：仅 .claude 注册的技能可命中（就近优先）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-compat-'));
  withCompatEnv(root, () => {
    writeCompatSkill(root, '.claude', 'solo', 'ClaudeSolo');
    const facade = createSkillsFacade(root);
    const r = facade.resolve('solo');
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.value.body.includes('ClaudeSolo 正文'));
    const miss = facade.resolve('nope');
    assert.equal(miss.ok, false);
    if (!miss.ok) assert.equal(miss.error.code, 'SKILL_NOT_FOUND');
  });
});
