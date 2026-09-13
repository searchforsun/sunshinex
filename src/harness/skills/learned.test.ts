import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LearnedSkillStore, slugify } from './learned';
import { parseSkillFrontmatter, resolveSkill } from '../skills';

function makeRoot(): { root: string; store: LearnedSkillStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-learned-'));
  return { root, store: new LearnedSkillStore(root) };
}

test('settle：写入 .data/skills/{id}/skill.md，frontmatter 可读回且可 resolve', () => {
  const { root, store } = makeRoot();
  try {
    const r = store.settle('实现 sqlite-vec 后端', '选型 node:sqlite vec0，零编译接入');
    assert.ok(r.ok);
    if (!r.ok) return;
    const id = r.value;
    assert.equal(id, '实现-sqlite-vec-后端');
    const file = path.join(root, '.data', 'skills', id, 'skill.md');
    assert.ok(fs.existsSync(file));
    const meta = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
    assert.equal(meta.name, '沉淀:实现 sqlite-vec 后端');
    assert.equal(meta.version, '0.1.0');
    assert.equal(meta.kind, 'prompt');
    const resolved = resolveSkill(path.join(root, '.data', 'skills'), id);
    assert.ok(resolved.ok);
    if (resolved.ok) assert.ok(resolved.value.body.includes('成功答复'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settle：同名 goal 二次沉淀得 -2 后缀，不覆盖既有产物', () => {
  const { root, store } = makeRoot();
  try {
    const r1 = store.settle('部署手册', '第一版');
    const r2 = store.settle('部署手册', '第二版');
    assert.ok(r1.ok && r2.ok);
    if (!r1.ok || !r2.ok) return;
    assert.equal(r1.value, '部署手册');
    assert.equal(r2.value, '部署手册-2');
    assert.ok(fs.existsSync(path.join(root, '.data', 'skills', '部署手册', 'skill.md')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('slugify：中文与特殊字符确定性折叠，全特殊字符回退 learned', () => {
  assert.equal(slugify('实现 A&B 功能!!'), slugify('实现 A&B 功能!!'));
  assert.equal(slugify('实现 A&B 功能!!'), '实现-A-B-功能');
  assert.equal(slugify('!!!???'), 'learned');
});

test('settle：目录超 50 删最旧（mtime 序，对齐 CAP.skill）', () => {
  const { root, store } = makeRoot();
  try {
    const dir = path.join(root, '.data', 'skills');
    for (let i = 0; i < 50; i += 1) {
      const d = path.join(dir, `old-${String(i).padStart(2, '0')}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'skill.md'), '---\nname: old\n---\nbody');
      fs.utimesSync(d, new Date(2020, 0, 1 + i), new Date(2020, 0, 1 + i));
    }
    const r = store.settle('新技能', '内容');
    assert.ok(r.ok);
    const ids = fs.readdirSync(dir).sort();
    assert.equal(ids.length, 50);
    assert.ok(!ids.includes('old-00'), 'mtime 最旧的 old-00 被清理');
    assert.ok(ids.includes('old-01'));
    assert.ok(ids.includes('新技能'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settle：goal 或 reply 为空 → SKILL_SETTLE_EMPTY，不落盘', () => {
  const { root, store } = makeRoot();
  try {
    const r = store.settle('  ', '内容');
    assert.ok(!r.ok);
    if (r.ok) return;
    assert.equal(r.error.code, 'SKILL_SETTLE_EMPTY');
    assert.ok(!fs.existsSync(path.join(root, '.data')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
