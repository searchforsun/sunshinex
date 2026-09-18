import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LearnedSkillStore, slugify } from './learned';
import { parseSkillFrontmatter, resolveSkill } from '../skills';
import { resolveDataDir } from '../../config/data-dir';

function makeRoot(): { root: string; store: LearnedSkillStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-learned-'));
  // 数据目录钉到 root/.data：断言路径稳定（tmp 内），全局用户区零触达；node --test 每文件独立进程，无跨文件泄漏
  process.env.SUNSHINEX_DATA_DIR = path.join(root, '.data');
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

test('settle：超上限按 mtime 淘汰最旧（opts.limit 驱动）', () => {
  const { root, store } = makeRoot();
  try {
    const dir = path.join(resolveDataDir(root), 'skills');
    const limit = 3;
    // 固定各条 mtime：goal-0 最旧、goal-1 次旧、goal-2 最新（utimesSync 手法同「目录超上限」用例）
    for (let i = 0; i < limit; i += 1) {
      assert.equal(store.settle(`goal ${i}`, `reply ${i}`, { limit }).ok, true);
      const d = path.join(dir, `goal-${i}`);
      fs.utimesSync(d, new Date(2020, 0, 1 + i), new Date(2020, 0, 1 + i));
    }
    // 已达上限：第 4 次沉淀须淘汰 mtime 最旧的 goal-0，目录恒 ≤ limit
    assert.equal(store.settle('goal 4', 'reply 4', { limit }).ok, true);
    const ids = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
    assert.equal(ids.length, limit);
    assert.ok(!ids.includes('goal-0'), 'mtime 最旧的 goal-0 被淘汰');
    assert.ok(ids.includes('goal-1'), '次旧历史保留');
    assert.ok(ids.includes('goal-2'), '最新历史保留');
    assert.ok(ids.includes('goal-4'), '本次新写入保留');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settle：limit<=0 夹紧下界为 1（不抛错，仅保留本次新写入）', () => {
  const { root, store } = makeRoot();
  try {
    const dir = path.join(resolveDataDir(root), 'skills');
    for (let i = 0; i < 3; i += 1) assert.equal(store.settle(`goal ${i}`, `reply ${i}`).ok, true);
    const r = store.settle('goal 9', 'reply 9', { limit: 0 });
    assert.equal(r.ok, true, '下界夹紧不触发抛错/失败（旁路纪律：沉淀不得因入参失败）');
    const ids = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
    assert.equal(ids.length, 1, '夹紧为 1 后与 limit=1 既有语义一致：只留本次新写入');
    assert.ok(ids.includes('goal-9'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
