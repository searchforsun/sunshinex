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

function writeUserSkill(root: string, id: string, name: string): void {
  fs.mkdirSync(path.join(root, 'skills', id), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', id, 'skill.md'), `---\nname: ${name}\ndescription: 用户技能\nversion: 1.0.0\n---\n用户版正文`);
}

test('双根合并：学习技能可 list/get/resolve，与用户技能并存', () => {
  const root = makeRoot();
  try {
    writeUserSkill(root, 'greet', 'Greet');
    new LearnedSkillStore(root).settle('数据库巡检手册', '每日巡检步骤……');
    const facade = createSkillsFacade(root);
    const ids = facade.list().map((s) => s.id);
    assert.ok(ids.includes('greet'), '用户技能仍在');
    assert.ok(ids.includes('数据库巡检手册'), '学习技能进入清单');
    assert.ok(facade.get('数据库巡检手册'), 'get 可见学习技能');
    const r = facade.resolve('数据库巡检手册');
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.value.body.includes('每日巡检步骤'), 'resolve 学习技能走同一三态语义');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('id 撞名：用户技能恒优先，学习产物被遮蔽不抛', () => {
  const root = makeRoot();
  try {
    writeUserSkill(root, 'dup', 'UserDup');
    const r = new LearnedSkillStore(root).settle('dup', '机器版');
    assert.ok(r.ok && r.value === 'dup');
    const facade = createSkillsFacade(root);
    const hits = facade.list().filter((s) => s.id === 'dup');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, 'UserDup');
    const resolved = facade.resolve('dup');
    assert.ok(resolved.ok);
    if (resolved.ok) assert.ok(resolved.value.body.includes('用户版正文'), '用户版胜出');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('无 .data/skills 目录：零影响，learnedCount 为 0', () => {
  const root = makeRoot();
  try {
    writeUserSkill(root, 'greet', 'Greet');
    const facade = createSkillsFacade(root);
    assert.equal(facade.list().length, 1);
    assert.equal(facade.learnedCount(), 0);
  } finally {
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
    });
    assert.equal(p.status, 0, `selfcheck 退出码 ${p.status}：${p.stderr}`);
    assert.match(p.stdout, /learned\s*:\s*0/, '应含 learned 行且空目录显示 0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
