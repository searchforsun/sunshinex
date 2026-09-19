import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveMemoryConfig, DEFAULT_LEARNED_SKILL_LIMIT } from './memory-config';

const ORIG_CWD = process.cwd();

test('缺省：全开 + 上限 50', () => {
  const c = resolveMemoryConfig({});
  assert.equal(c.autoMemory, true);
  assert.equal(c.learnedSkills, true);
  assert.equal(c.learnedSkillLimit, DEFAULT_LEARNED_SKILL_LIMIT);
});

test('env 三键各自生效（关 / 关 / 配 12）', () => {
  const c = resolveMemoryConfig({ SUNSHINEX_AUTO_MEMORY: 'off', SUNSHINEX_LEARNED_SKILLS: 'off', SUNSHINEX_LEARNED_SKILL_LIMIT: '12' });
  assert.equal(c.autoMemory, false);
  assert.equal(c.learnedSkills, false);
  assert.equal(c.learnedSkillLimit, 12);
});

test('on/off 大小写与首尾空白容错', () => {
  assert.equal(resolveMemoryConfig({ SUNSHINEX_AUTO_MEMORY: ' OFF ' }).autoMemory, false);
  assert.equal(resolveMemoryConfig({ SUNSHINEX_AUTO_MEMORY: 'On' }).autoMemory, true);
  assert.equal(resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILLS: 'False' }).learnedSkills, false);
});

test('上限上下界：1 与 1000 通过，0 / 1001 / abc 抛错', () => {
  assert.equal(resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILL_LIMIT: '1' }).learnedSkillLimit, 1);
  assert.equal(resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILL_LIMIT: '1000' }).learnedSkillLimit, 1000);
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILL_LIMIT: '0' }), /learned_skill_limit/);
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILL_LIMIT: '1001' }), /learned_skill_limit/);
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILL_LIMIT: 'abc' }), /learned_skill_limit/);
});

test('开关非法值装配期 fail-fast', () => {
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_AUTO_MEMORY: 'maybe' }), /auto_memory/);
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILLS: 'yes' }), /learned_skills/);
});

test('钉子：SUNSHINE.md 不参与配置（同 CLAUDE.md 定位）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memcfg-'));
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), ['## 记忆', 'auto_memory: off', 'learned_skill_limit: 3'].join('\n'));
    process.chdir(tmp); // 当前目录放一份"带配置的 SUNSHINE.md"，解析结果必须不受影响
    const c = resolveMemoryConfig({});
    assert.equal(c.autoMemory, true, 'SUNSHINE.md 分区不得进控制面');
    assert.equal(c.learnedSkillLimit, DEFAULT_LEARNED_SKILL_LIMIT);
  } finally {
    process.chdir(ORIG_CWD);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('memory-config：管线四键缺省值与 env 覆盖', () => {
  const d = resolveMemoryConfig({} as NodeJS.ProcessEnv);
  assert.equal(d.memoryIdleKickMs, 300000);
  assert.equal(d.stepDigestMaxSteps, 20);
  assert.equal(d.stepDigestItemChars, 120);
  assert.equal(d.stepDigestTotalChars, 1500);
  const e = {
    SUNSHINEX_MEMORY_IDLE_KICK_MS: '1000',
    SUNSHINEX_MEMORY_STEP_DIGEST_MAX_STEPS: '5',
    SUNSHINEX_MEMORY_STEP_DIGEST_ITEM_CHARS: '64',
    SUNSHINEX_MEMORY_STEP_DIGEST_TOTAL_CHARS: '800',
  } as NodeJS.ProcessEnv;
  const c = resolveMemoryConfig(e);
  assert.equal(c.memoryIdleKickMs, 1000);
  assert.equal(c.stepDigestMaxSteps, 5);
  assert.equal(c.stepDigestItemChars, 64);
  assert.equal(c.stepDigestTotalChars, 800);
});

test('memory-config：管线四键非法值 fail-fast', () => {
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_MEMORY_IDLE_KICK_MS: 'abc' } as NodeJS.ProcessEnv));
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_MEMORY_STEP_DIGEST_MAX_STEPS: '0' } as NodeJS.ProcessEnv));
});
