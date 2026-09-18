import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';
import { SafetyChain } from '../security/chain';
import { DryRun } from '../security/dryrun';
import { builtinTools } from './builtin';
import { createSkillsFacade } from '../skills';

// 测试卫生：数据目录与全局技能根钉文件私有目录——技能装载含三级根，共享数据目录被并发测试写入会改变装载结果
process.env.SUNSHINEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skilltool-data-'));
process.env.SUNSHINEX_USER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skilltool-uskills-'));

function fixture(): { root: string; safety: SafetyChain; registry: ToolRegistry } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skilltool-'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root, undefined, undefined, undefined, createSkillsFacade(root))) registry.register(t);
  return { root, safety, registry };
}

function writeSkill(root: string, id: string, fm: string, body: string): void {
  fs.mkdirSync(path.join(root, '.sunshinex', 'skills', id), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshinex', 'skills', id, 'skill.md'), `---\n${fm}\n---\n${body}`);
}

test('skill 工具：登记为 read 类（可参与并行批）', () => {
  const { registry } = fixture();
  const t = registry.get('skill');
  assert.ok(t, 'skill 工具已注册');
  assert.equal(t.category, 'read');
});

test('skill 工具：按 id 加载正文（模型自主触发面）', async () => {
  const { root, safety, registry } = fixture();
  writeSkill(root, 'greet', 'name: Greet\ndescription: 问候用户\nversion: 1.0.0', '向用户问好，保持简洁。');
  const r = await registry.execute('skill', { id: 'greet' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.value.stdout.includes('[Skill] Greet'), '头部标注技能名');
    assert.ok(r.value.stdout.includes('向用户问好，保持简洁。'), '正文原样返回');
  }
});

test('skill 工具：未注册 id 报 SKILL_NOT_FOUND', async () => {
  const { safety, registry } = fixture();
  const r = await registry.execute('skill', { id: 'nope' }, safety);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'SKILL_NOT_FOUND');
});

test('skill 工具：缺形参报 SKILL_PARAM_MISSING；带参命中且占位符替换', async () => {
  const { root, safety, registry } = fixture();
  writeSkill(root, 'deploy', 'name: Deploy\ndescription: 部署\nversion: 1.0.0\nparams: env', '部署到 {{env}} 环境。');
  const miss = await registry.execute('skill', { id: 'deploy' }, safety);
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.equal(miss.error.code, 'SKILL_PARAM_MISSING');
  const hit = await registry.execute('skill', { id: 'deploy', params: { env: 'prod' } }, safety);
  assert.equal(hit.ok, true);
  if (hit.ok) assert.ok(hit.value.stdout.includes('部署到 prod 环境。'));
});

test('skill 工具：缺 id 报 INVALID_ARG；未装配技能门面报 skill_not_configured', async () => {
  const { root, safety, registry } = fixture();
  const bad = await registry.execute('skill', {}, safety);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'INVALID_ARG');

  const safety2 = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  const bare = new ToolRegistry();
  for (const t of builtinTools(safety2, root)) bare.register(t);
  const r = await bare.execute('skill', { id: 'x' }, safety2);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'skill_not_configured');
});

test('skill 工具：manual 模式免审批（只读族语义，与 Read 同档）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skilltool-manual-'));
  writeSkill(root, 'greet', 'name: Greet\ndescription: 问候\nversion: 1.0.0', '正文');
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root, undefined, undefined, undefined, createSkillsFacade(root))) registry.register(t);
  const r = await registry.execute('skill', { id: 'greet' }, safety);
  assert.equal(r.ok, true, 'manual 模式经 registry 规范名映射后免审批放行');
});
