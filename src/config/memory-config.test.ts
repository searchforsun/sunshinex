import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveMemoryConfig, DEFAULT_LEARNED_SKILL_LIMIT } from '../config/memory-config';

function tmpRoot(md = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcfg-'));
  if (md) fs.writeFileSync(path.join(dir, 'SUNSHINE.md'), md);
  return dir;
}

test('缺省：全开 + 上限 50', () => {
  const c = resolveMemoryConfig(tmpRoot(), {});
  assert.equal(c.autoMemory, true);
  assert.equal(c.learnedSkills, true);
  assert.equal(c.learnedSkillLimit, DEFAULT_LEARNED_SKILL_LIMIT);
});

test('SUNSHINE.md ## 记忆 分区生效', () => {
  const c = resolveMemoryConfig(tmpRoot(['## 记忆', 'auto_memory: off', 'learned_skills: off', 'learned_skill_limit: 12'].join('\n')), {});
  assert.equal(c.autoMemory, false);
  assert.equal(c.learnedSkills, false);
  assert.equal(c.learnedSkillLimit, 12);
});

test('env 覆盖 SUNSHINE.md（优先级高）', () => {
  const root = tmpRoot(['## 记忆', 'auto_memory: on', 'learned_skill_limit: 12'].join('\n'));
  const c = resolveMemoryConfig(root, { SUNSHINEX_AUTO_MEMORY: 'off', SUNSHINEX_LEARNED_SKILL_LIMIT: '7' });
  assert.equal(c.autoMemory, false);
  assert.equal(c.learnedSkillLimit, 7);
});

test('非法值装配期 fail-fast', () => {
  assert.throws(() => resolveMemoryConfig(tmpRoot(), { SUNSHINEX_AUTO_MEMORY: 'maybe' }), /auto_memory/);
  assert.throws(() => resolveMemoryConfig(tmpRoot(), { SUNSHINEX_LEARNED_SKILL_LIMIT: '0' }), /learned_skill_limit/);
  assert.throws(() => resolveMemoryConfig(tmpRoot(), { SUNSHINEX_LEARNED_SKILL_LIMIT: 'abc' }), /learned_skill_limit/);
});

test('分区外的同名键不生效（只认 ## 记忆 区）', () => {
  const c = resolveMemoryConfig(tmpRoot(['## 编码规范', 'auto_memory: off'].join('\n')), {});
  assert.equal(c.autoMemory, true);
});

test('on/off 大小写不敏感 + 首尾空白（env 与分区两侧）', () => {
  assert.equal(resolveMemoryConfig(tmpRoot(), { SUNSHINEX_AUTO_MEMORY: ' OFF ' }).autoMemory, false);
  assert.equal(resolveMemoryConfig(tmpRoot(), { SUNSHINEX_AUTO_MEMORY: 'On' }).autoMemory, true);
  assert.equal(resolveMemoryConfig(tmpRoot(), { SUNSHINEX_AUTO_MEMORY: ' TRUE ' }).autoMemory, true);
  assert.equal(resolveMemoryConfig(tmpRoot(), { SUNSHINEX_AUTO_MEMORY: 'False' }).autoMemory, false);
  const secRoot = tmpRoot(['## 记忆', 'auto_memory: OFF'].join('\n'));
  assert.equal(resolveMemoryConfig(secRoot, {}).autoMemory, false);
  assert.throws(() => resolveMemoryConfig(tmpRoot(), { SUNSHINEX_AUTO_MEMORY: ' maybe ' }), /auto_memory/);
});

test('SUNSHINEX_LEARNED_SKILLS env 路径生效，且分区为 on 时 env 仍赢', () => {
  assert.equal(resolveMemoryConfig(tmpRoot(), { SUNSHINEX_LEARNED_SKILLS: 'off' }).learnedSkills, false);
  const root = tmpRoot(['## 记忆', 'learned_skills: on'].join('\n'));
  assert.equal(resolveMemoryConfig(root, {}).learnedSkills, true);
  assert.equal(resolveMemoryConfig(root, { SUNSHINEX_LEARNED_SKILLS: ' OFF ' }).learnedSkills, false);
});

test('SUNSHINE.md ## Memory 英文标题分区生效', () => {
  const c = resolveMemoryConfig(tmpRoot(['## Memory', 'auto_memory: off', 'learned_skills: off', 'learned_skill_limit: 9'].join('\n')), {});
  assert.equal(c.autoMemory, false);
  assert.equal(c.learnedSkills, false);
  assert.equal(c.learnedSkillLimit, 9);
});

test('learned_skill_limit 上界 1000 通过、1001 抛错（env 与分区两侧）', () => {
  assert.equal(resolveMemoryConfig(tmpRoot(), { SUNSHINEX_LEARNED_SKILL_LIMIT: '1000' }).learnedSkillLimit, 1000);
  assert.equal(resolveMemoryConfig(tmpRoot(['## 记忆', 'learned_skill_limit: 1000'].join('\n')), {}).learnedSkillLimit, 1000);
  assert.throws(() => resolveMemoryConfig(tmpRoot(), { SUNSHINEX_LEARNED_SKILL_LIMIT: '1001' }), /learned_skill_limit/);
  assert.throws(() => resolveMemoryConfig(tmpRoot(['## 记忆', 'learned_skill_limit: 1001'].join('\n')), {}), /learned_skill_limit/);
});
