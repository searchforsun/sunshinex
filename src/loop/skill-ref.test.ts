import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LoopEngine, LoopDeps } from './engine';
import { agentNode } from './nodes';
import { ContextManager } from '../harness/context';
import { ContextItem } from '../types';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { SafetyChain } from '../harness/security/chain';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';
import { ScriptedAdapter } from '../model/adapter';
import { FileStore } from '../storage/adapter';
import { resolveSkill } from '../harness/skills';

/** 首帧观测：记录每次 assemble 产物，断言技能块仅出现在首帧 */
class RecordingContext extends ContextManager {
  frames: ContextItem[][] = [];
  assemble(goal: string, history: ContextItem[] = [], relPath?: string): ContextItem[] {
    const items = super.assemble(goal, history, relPath);
    this.frames.push(items);
    return items;
  }
}

function makeFixture(): { deps: LoopDeps; context: RecordingContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skillref-'));
  fs.mkdirSync(path.join(root, 'skills', 'greet'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'skills', 'greet', 'skill.md'),
    '---\nname: Greet\nversion: 0.1.0\nkind: prompt\nparams: name tone\n---\n\n# Hello {{name}}\n\nTone: {{tone}}。',
  );
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  const context = new RecordingContext(root, new FileStore(path.join(root, '.data')));
  const deps: LoopDeps = {
    safety,
    registry,
    context,
    model: new ScriptedAdapter(['{"done":true}']),
    skills: { resolve: (id, params) => resolveSkill(path.join(root, 'skills'), id, params) },
  };
  return { deps, context };
}

const TERM = { maxIterations: 5, maxTokens: 100_000, timeoutMs: 5_000 };

test('skillRef 调度：解析正文仅注入首帧（kind=system），任务正常 done', async () => {
  const { deps, context } = makeFixture();
  const engine = new LoopEngine([agentNode(deps)], deps, TERM);
  const r = await engine.run('完成问候', { skillRef: { id: 'greet', params: { name: '小明', tone: '正式' } } });

  assert.equal(r.status, 'done');
  assert.ok(context.frames.length >= 1);
  const first = context.frames[0].map((i) => i.content).join('\n');
  assert.ok(first.includes('[Skill]'), '首帧应含技能注入标记');
  assert.ok(first.includes('Hello 小明'), '首帧应含参数替换后的正文');
  assert.ok(first.includes('Tone: 正式。'));
  for (let i = 1; i < context.frames.length; i++) {
    assert.ok(!context.frames[i].some((x) => x.content.includes('[Skill]')), '技能块仅首帧，不随后续帧重复');
  }
});

test('skillRef：未注册 id → failed 且错误码可见，不静默放行', async () => {
  const { deps } = makeFixture();
  const engine = new LoopEngine([agentNode(deps)], deps, TERM);
  const r = await engine.run('任意目标', { skillRef: { id: 'nope' } });
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /SKILL_NOT_FOUND/);
});

test('skillRef：缺参 → failed 且报 SKILL_PARAM_MISSING 与缺失形参名', async () => {
  const { deps } = makeFixture();
  const engine = new LoopEngine([agentNode(deps)], deps, TERM);
  const r = await engine.run('任意目标', { skillRef: { id: 'greet', params: { name: '小明' } } });
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /SKILL_PARAM_MISSING/);
  assert.match(r.error ?? '', /tone/);
});

test('不带 skillRef：行为不回归（首帧无技能块）', async () => {
  const { deps, context } = makeFixture();
  const engine = new LoopEngine([agentNode(deps)], deps, TERM);
  const r = await engine.run('普通目标');
  assert.equal(r.status, 'done');
  assert.ok(context.frames[0].every((x) => !x.content.includes('[Skill]')));
});
