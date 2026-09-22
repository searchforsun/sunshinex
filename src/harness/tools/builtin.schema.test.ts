import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { builtinTools } from './builtin';
import { makeSpawnTool, SubagentRunner, SPAWN_TOOL_NAME } from '../subagent';
import { ToolRegistry } from '../tools';
import type { RegisteredTool } from '../tools';
import type { JsonSchema } from '../../types';
import { SafetyChain } from '../security/chain';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';
import { DryRun } from '../security/dryrun';

/**
 * T1（原生 function calling 迁移）工具参数声明化回归钉：
 * ①全注册形态下每个注册工具必须声明 parameters（type:'object' + additionalProperties 显式闭合）
 * ②逐工具 required/properties 与执行器真实入参一一对应（memory_write 不暴露 scope——scope 由执行期安全链注入）
 * ③strict 兼容不变量：所有声明字段 ∈ required（可选项以 null 联合表达）；唯一登记宽松点 skill.params（自由键值，additionalProperties:true 显式标记）
 * ④spawn 工厂同口径（prompt/agent_id/label/tools/background；「agent_id 与 prompt 至少其一」无法用 schema 表达，留执行面校验）
 */

function makeSafety(root: string): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withRegistries(fn: (ctx: { bare: ToolRegistry; full: ToolRegistry }) => void): void {
  const tmp = tmpDir('sunshinex-params-');
  try {
    const safety = makeSafety(tmp);
    const bare = new ToolRegistry();
    for (const t of builtinTools(safety, tmp)) bare.register(t);
    const full = new ToolRegistry();
    const stubMemoryWrite = () => ({ ok: true as const, value: { slug: 'stub-slug', existed: false, notice: null } });
    const stubAsk = async () => ({ type: 'dismissed' as const });
    for (const t of builtinTools(safety, tmp, undefined, undefined, undefined, undefined, undefined, stubMemoryWrite, stubAsk)) full.register(t);
    full.register(makeSpawnTool({} as unknown as SubagentRunner));
    fn({ bare, full });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function paramsOf(tool: RegisteredTool): JsonSchema {
  const p = tool.parameters;
  assert.ok(p, `tool ${tool.name} must declare parameters`);
  assert.equal(p.type, 'object', `tool ${tool.name} parameters.type must be 'object'`);
  return p;
}

/** strict 兼容游走：所有对象节点显式闭合（additionalProperties 显式出现，false 之外只容登记宽松点）、
 * 声明字段全量进 required（可选项以 null 联合表达而非省略） */
function walkStrict(node: JsonSchema, pathKey: string, loose: ReadonlySet<string>, issues: string[]): void {
  if (node.properties !== undefined) {
    if (node.additionalProperties === undefined) issues.push(`${pathKey}: object node without explicit additionalProperties`);
    if (node.additionalProperties !== false && !loose.has(pathKey)) issues.push(`${pathKey}: non-closed object outside registered loose points`);
    const required = new Set(node.required ?? []);
    for (const [key, child] of Object.entries(node.properties)) {
      if (!required.has(key)) issues.push(`${pathKey}.${key}: declared but missing from required (optionals must be null-union)`);
      walkStrict(child as JsonSchema, `${pathKey}.${key}`, loose, issues);
    }
  }
  if (node.items !== undefined) walkStrict(node.items as JsonSchema, `${pathKey}[]`, loose, issues);
}

test('内建工具全量声明 parameters 且对象节点显式闭合（裸装配与全接缝装配两态一致）', () => {
  withRegistries(({ bare, full }) => {
    const bareNames = bare.list().map((t) => t.name).sort();
    assert.deepEqual(bareNames, ['exec', 'glob', 'grep', 'kb_search', 'read', 'skill', 'todo_write', 'webfetch', 'websearch', 'worktree', 'write']);
    const fullNames = full.list().map((t) => t.name).sort();
    assert.deepEqual(fullNames, [...bareNames, 'ask_question', 'memory_write', SPAWN_TOOL_NAME].sort());
    for (const registry of [bare, full]) {
      for (const tool of registry.list()) paramsOf(tool);
    }
  });
});

test('逐工具 required/properties 与执行器真实入参一一对应', () => {
  withRegistries(({ full }) => {
    const expected: Record<string, string[]> = {
      exec: ['command', 'background'],
      read: ['path', 'range'],
      skill: ['id', 'params'],
      write: ['path', 'content'],
      grep: ['pattern', 'glob', 'path'],
      glob: ['pattern'],
      webfetch: ['url'],
      websearch: ['query', 'count'],
      worktree: ['action', 'name'],
      kb_search: ['query', 'topK'],
      memory_write: ['type', 'content', 'description'],
      ask_question: ['question', 'options', 'multiple', 'allowCustom'],
      [SPAWN_TOOL_NAME]: ['prompt', 'agent_id', 'label', 'tools', 'background'],
    };
    for (const [name, keys] of Object.entries(expected)) {
      const tool = full.get(name);
      assert.ok(tool, `tool ${name} must be registered`);
      const p = paramsOf(tool);
      assert.deepEqual(
        Object.keys(p.properties ?? {}).sort(),
        [...keys].sort(),
        `tool ${name}: declared properties must match the executor's real inputs`,
      );
      assert.deepEqual((p.required ?? []).sort(), [...keys].sort(), `tool ${name}: required must cover all declared inputs`);
    }
  });
});

test('memory_write 参数面：type 四值枚举、不暴露 scope（scope 由执行期安全链注入）', () => {
  withRegistries(({ full }) => {
    const p = paramsOf(full.get('memory_write')!);
    const type = p.properties?.type as JsonSchema;
    assert.deepEqual(type.enum, ['user', 'feedback', 'project', 'reference'], 'type enum must mirror MemoryType (memory/store.ts)');
    assert.ok(!('scope' in (p.properties ?? {})), 'scope must not be exposed to the model (execution-time injection via SafetyChain.memoryScope)');
  });
});

test('strict 兼容不变量：唯一宽松点 skill.params（自由键值 additionalProperties:true），其余全闭合', () => {
  withRegistries(({ full }) => {
    const loose = new Set(['skill.params']);
    const issues: string[] = [];
    for (const tool of full.list()) walkStrict(paramsOf(tool), tool.name, loose, issues);
    assert.deepEqual(issues, [], 'strict-compatibility violations found');
    // 宽松点显式登记的钉子：skill.params 必须 additionalProperties:true（不佯装严格、也不靠省略隐式宽松）
    const skillParams = full.get('skill')!.parameters!.properties!.params as JsonSchema;
    assert.equal(skillParams.additionalProperties, true, 'skill.params must explicitly register its loose point');
  });
});

test('抽查：read.range 走 null 联合可选项；ask_question.options 2–8 项且子项闭合', () => {
  withRegistries(({ full }) => {
    const read = paramsOf(full.get('read')!);
    assert.deepEqual((read.properties?.range as JsonSchema).type, ['string', 'null'], 'optionals must be expressed as null-union');
    const ask = paramsOf(full.get('ask_question')!);
    const options = ask.properties?.options as JsonSchema;
    assert.equal(options.minItems, 2);
    assert.equal(options.maxItems, 8);
    const item = options.items as JsonSchema;
    assert.deepEqual(Object.keys(item.properties ?? {}).sort(), ['description', 'label']);
    assert.deepEqual(item.required, ['label', 'description']);
  });
});

test('spawn 工厂声明 parameters（至少其一约束留执行面）', () => {
  const spawn = makeSpawnTool({} as unknown as SubagentRunner);
  assert.equal(spawn.name, SPAWN_TOOL_NAME);
  assert.equal(spawn.category, 'subagent');
  const p = paramsOf(spawn);
  assert.deepEqual(
    Object.keys(p.properties ?? {}).sort(),
    ['agent_id', 'background', 'label', 'prompt', 'tools'],
    'spawn parameters must mirror SubagentSpawnInput',
  );
  assert.deepEqual((p.properties?.tools as JsonSchema).items?.type, 'string');
});

test('todo_write 执行面：条数钳制 >50 拒绝、非法 status 拒绝、facade 未注入报 todo_not_configured', async () => {
  const tmp = tmpDir('sunshinex-todowrite-exec-');
  try {
    const safety = makeSafety(tmp);
    const reg = new ToolRegistry();
    // 不注入第 12 参：恒注册但未接线（bare 形态）
    for (const t of builtinTools(safety, tmp)) reg.register(t);
    const tool = reg.get('todo_write');
    assert.ok(tool, 'todo_write 恒注册（对标 skill 先例）');
    // 现场校正：CodedToolError 经 ToolRegistry.execute 转 Result 错误通道（skill_not_configured 同款先例），
    // 直调 executor 时 code 不在 message 内——断言走 registry 通道的 error.code
    const miss = await reg.execute('todo_write', { todos: [] }, safety);
    assert.equal(miss.ok, false);
    if (!miss.ok) assert.equal(miss.error.code, 'todo_not_configured');
    const wired: Array<{ text: string; status: string }> = [];
    const reg2 = new ToolRegistry();
    for (const t of builtinTools(safety, tmp, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { set: (items) => wired.push(...items) })) reg2.register(t);
    const wiredTool = reg2.get('todo_write')!;
    // 现场校正（同上）：INVALID_ARG 断言走 registry 错误通道
    const over = await reg2.execute('todo_write', { todos: Array.from({ length: 51 }, (_, i) => ({ text: `t${i}`, status: 'pending' })) }, safety);
    assert.equal(over.ok, false);
    if (!over.ok) assert.match(over.error.code, /INVALID_ARG/);
    if (!over.ok) assert.match(over.error.message, /50/);
    const bad = await reg2.execute('todo_write', { todos: [{ text: 'a', status: 'doing' }] }, safety);
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.error.code, 'INVALID_ARG');
      assert.match(bad.error.message, /status/);
    }
    const okRun = await reg2.execute('todo_write', { todos: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }] }, safety);
    assert.equal(okRun.ok, true);
    assert.equal(wired.length, 2, 'facade 收到全量替换清单');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
