import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSkill, parseSkillFrontmatter } from './skills';

function makeSkillDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skills-'));
  fs.mkdirSync(path.join(dir, 'greet'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'greet', 'skill.md'),
    ['---', 'name: Greet', 'description: Greeting template', 'version: 0.2.0', 'kind: prompt', 'params: name tone', '---', '', '# Hello {{name}}', '', '语气：{{tone}}。'].join('\n'),
  );
  return dir;
}

test('parseSkillFrontmatter：kind 与 params 清单解析', () => {
  const m = parseSkillFrontmatter('---\nname: X\ndescription: d\nversion: 1.0.0\nkind: prompt\nparams: name tone\n---\n正文');
  assert.deepEqual(m.params, ['name', 'tone']);
  assert.equal(m.kind, 'prompt');
});

test('resolveSkill：命中——manifest 完整且 {{param}} 全部替换', () => {
  const r = resolveSkill(makeSkillDir(), 'greet', { name: '小明', tone: '正式' });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.manifest.id, 'greet');
    assert.equal(r.value.manifest.version, '0.2.0');
    assert.ok(r.value.body.includes('Hello 小明'));
    assert.ok(r.value.body.includes('语气：正式。'));
    assert.ok(!r.value.body.includes('{{name}}'), '不应残留未替换占位符');
  }
});

test('resolveSkill：未注册 id → fail(SKILL_NOT_FOUND)', () => {
  const r = resolveSkill(makeSkillDir(), 'nope');
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'SKILL_NOT_FOUND');
});

test('resolveSkill：缺参 → fail(SKILL_PARAM_MISSING) 且报缺失形参名', () => {
  const r = resolveSkill(makeSkillDir(), 'greet', { name: '小明' });
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.error.code, 'SKILL_PARAM_MISSING');
    assert.match(r.error.message, /tone/);
  }
});

test('resolveSkill：白名单外多余参数被过滤；无参技能正文原样返回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skills-'));
  fs.mkdirSync(path.join(dir, 'plain'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plain', 'skill.md'), '---\nname: P\n---\n固定正文');
  const r = resolveSkill(dir, 'plain', { junk: 'ignored' });
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.value.body.includes('固定正文'));
    assert.equal(r.value.manifest.params, undefined);
  }
});
