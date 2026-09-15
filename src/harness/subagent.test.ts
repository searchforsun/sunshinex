import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRegistry, resolveSpawnSpec } from './subagent';

test('AgentRegistry：内建四角色可解析、未命中 fail-fast', () => {
  const reg = new AgentRegistry();
  reg.registerBuiltins();
  for (const id of ['planner', 'developer', 'tester', 'reviewer']) {
    const def = reg.resolve(id);
    assert.ok(def.name.length > 0 && def.framing.length > 0);
  }
  assert.throws(() => reg.resolve('ghost'), /未找到智能体|not found/i);
});

test('AgentRegistry：目录注册制加载与畸形 fail-fast（同 skills/MCP 装配纪律）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-agents-'));
  try {
    fs.mkdirSync(path.join(root, 'agents', 'code-reviewer'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'agents', 'code-reviewer', 'agent.md'),
      '---\nname: code-reviewer\ndescription: 审查代码变更\nversion: 1.0.0\n---\n\n以审查者角色框定工作，产出审查报告。',
    );
    const reg = new AgentRegistry();
    reg.registerBuiltins();
    reg.loadAgents(root);
    const def = reg.resolve('code-reviewer');
    assert.equal(def.name, 'code-reviewer');
    assert.ok(def.framing.includes('审查者'), '角色框定取 frontmatter 之后正文');

    // 缺 frontmatter → 整次加载 fail-fast，不静默跳过
    fs.mkdirSync(path.join(root, 'agents', 'bad'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', 'bad', 'agent.md'), '无 frontmatter 正文');
    const bad = new AgentRegistry();
    bad.registerBuiltins();
    assert.throws(() => bad.loadAgents(root), /frontmatter/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSpawnSpec：同传两行 / 仅 prompt 内联 / 仅 agent_id 缺省续接行 / 显式任务行优先 / 皆缺报错', () => {
  const reg = new AgentRegistry();
  reg.registerBuiltins();

  const both = resolveSpawnSpec(reg, { agent_id: 'reviewer', prompt: '审查 src/foo.ts' });
  assert.ok(both.roleLine!.includes('reviewer'), '角色行含角色标识（graph 先例模板）');
  assert.equal(both.taskLine, '审查 src/foo.ts');
  assert.equal(both.label, 'reviewer');

  const inline = resolveSpawnSpec(reg, { prompt: '独立任务' });
  assert.equal(inline.roleLine, undefined, '内联临时无角色行');
  assert.equal(inline.taskLine, '独立任务');
  assert.equal(inline.label, 'subagent', 'label 缺省 subagent');

  const onlyId = resolveSpawnSpec(reg, { agent_id: 'planner' });
  assert.ok(onlyId.roleLine !== undefined);
  assert.ok(onlyId.taskLine.length > 0, '仅 agent_id 时缺省续接任务行兜底');

  assert.equal(resolveSpawnSpec(reg, { agent_id: 'planner', label: '规划' }).label, '规划', 'label 显式优先');

  const explicit = resolveSpawnSpec(reg, { agent_id: 'tester' }, { taskLine: '跑全量回归' });
  assert.equal(explicit.taskLine, '跑全量回归', 'graph 显式任务行优先于缺省续接行');

  assert.throws(() => resolveSpawnSpec(reg, {}), /agent_id 与 prompt 皆缺|both missing/i);
});
