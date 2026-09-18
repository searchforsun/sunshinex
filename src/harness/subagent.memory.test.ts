import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRegistry, SubagentRunner } from './subagent';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { MemoryStore } from './memory/store';
import { guardMemoryWrite } from './memory/writer';
import { resolveDataDir } from '../config/data-dir';

/**
 * 子代理自有记忆（规格 §8）：agent.md frontmatter `memory: true` 声明独立目录 <dataDir>/memory/agents/<id>/，
 * 索引以 fork 私有尾块注入（role 行与 task 行之间），主链零污染；子代理写面经 withMemoryScope 收窄到自身目录。
 * 范式对齐 subagent.test.ts / chain.memorywrite.test.ts：tmpdir 作 root、SUNSHINEX_DATA_DIR 重定向、finally 还原清理。
 */

interface Harness {
  root: string;
  dataDir: string;
  context: ContextManager;
  agents: AgentRegistry;
  safety: SafetyChain;
  registry: ToolRegistry;
  /** 组装 runner（model 由用例注入：capture 桩便于取 fork 帧） */
  makeRunner(model: ModelAdapter): SubagentRunner;
}

function makeHarness(tmp: string): Harness {
  const root = path.join(tmp, 'root');
  fs.mkdirSync(root, { recursive: true });
  const store = new FileStore(path.join(root, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, guardMemoryWrite)) registry.register(t);
  const context = new ContextManager(root, store);
  const agents = new AgentRegistry();
  agents.registerBuiltins();
  agents.loadAgents(root);
  return {
    root,
    dataDir: resolveDataDir(root),
    context,
    agents,
    safety,
    registry,
    makeRunner: (model) => {
      const runner = new SubagentRunner({ registry, safety, context, model, root }, agents);
      runner.attachParent(() => ({ maxSteps: 10, tokenCap: 100_000 }));
      return runner;
    },
  };
}

/** env 钉扎骨架：数据目录重定向 + 总开关复位（undefined=缺省开），finally 还原 */
function withEnv(autoMemory: 'on' | 'off' | undefined, fn: (tmp: string) => Promise<void> | void): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-subagent-memory-'));
  const prevDataDir = process.env.SUNSHINEX_DATA_DIR;
  const prevAuto = process.env.SUNSHINEX_AUTO_MEMORY;
  process.env.SUNSHINEX_DATA_DIR = tmp;
  if (autoMemory === undefined) delete process.env.SUNSHINEX_AUTO_MEMORY;
  else process.env.SUNSHINEX_AUTO_MEMORY = autoMemory;
  return (async () => {
    try {
      await fn(tmp);
    } finally {
      if (prevDataDir === undefined) delete process.env.SUNSHINEX_DATA_DIR;
      else process.env.SUNSHINEX_DATA_DIR = prevDataDir;
      if (prevAuto === undefined) delete process.env.SUNSHINEX_AUTO_MEMORY;
      else process.env.SUNSHINEX_AUTO_MEMORY = prevAuto;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
}

/** 写两个 agent 物料：auditor 声明 memory:true，plain 不声明 */
function writeAgentMaterials(root: string): void {
  fs.mkdirSync(path.join(root, 'agents', 'auditor'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agents', 'auditor', 'agent.md'),
    ['---', 'name: auditor', 'description: code review agent', 'version: 1.0.0', 'memory: true', '---', '', 'Review conventions live in your own memory.', ''].join('\n'),
  );
  fs.mkdirSync(path.join(root, 'agents', 'plain'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agents', 'plain', 'agent.md'),
    ['---', 'name: plain', 'description: no memory agent', 'version: 1.0.0', '---', '', 'No memory declared.', ''].join('\n'),
  );
}

/** 预置 auditor 自有记忆一条（经 MemoryStore.add 重建索引，索引即含该条） */
function seedOwnMemory(h: Harness): MemoryStore {
  const own = new MemoryStore(h.root, { subdir: path.join('agents', 'auditor') });
  const r = own.add({
    type: 'project',
    description: 'auditor checks fail 0 gate',
    body: 'Always assert fail 0 on the full suite.',
    created: '2026-09-18T00:00:00.000Z',
  });
  assert.ok(r.ok, `自有记忆预置应成功：${r.ok ? '' : r.error.message}`);
  assert.equal(own.count(), 1);
  return own;
}

/** capture 桩：透传 scripted 应答并记录每次 prompt（取 fork 首帧用，对齐 subagent.test.ts 惯用法） */
function capturePrompts(scripted: ScriptedAdapter): { model: ModelAdapter; prompts: string[] } {
  const prompts: string[] = [];
  const model: ModelAdapter = {
    provider: 'capture',
    complete: async (p: string) => {
      prompts.push(p);
      return scripted.complete(p);
    },
  } as ModelAdapter;
  return { model, prompts };
}

test('memory:true agent → fork 私有尾块含自有记忆索引（role < memory < task），主链零 memory 行污染', async () => {
  await withEnv(undefined, async (tmp) => {
    const h = (() => {
      const root = path.join(tmp, 'root');
      writeAgentMaterials(root);
      return makeHarness(tmp);
    })();
    const own = seedOwnMemory(h);
    const scripted = new ScriptedAdapter([JSON.stringify({ done: true, reply: '复核完成' })]);
    const { model, prompts } = capturePrompts(scripted);
    const before = h.context.chainView();
    const r = await h.makeRunner(model).runSubagent({ agent_id: 'auditor', prompt: '复核并给出结论' });
    assert.ok(r.ok, `spawn 应成功：${JSON.stringify(r)}`);
    // 主链零污染：终态唯一一行 node 结论行，绝无 memory 行入主链
    const after = h.context.chainView();
    assert.equal(after.length, before.length + 1, '主链只允许终态一行结论行');
    assert.equal(after[after.length - 1].action, 'node');
    assert.ok(!after.some((s) => s.action === 'memory'), '自有记忆索引不得进主链');
    // fork 私有尾块：捕获帧含自有目录与索引内容，顺序 role < memory < task
    const frame = prompts[prompts.length - 1];
    assert.ok(frame.includes(own.dir()), 'fork 帧应含自有记忆目录绝对路径');
    assert.ok(frame.includes('fail 0 gate'), 'fork 帧应含预置记忆索引行内容');
    const rolePos = frame.indexOf('Your role:');
    const memPos = frame.lastIndexOf(own.dir());
    const taskPos = frame.lastIndexOf('复核并给出结论');
    assert.ok(rolePos >= 0 && taskPos >= 0, '帧应含角色行与任务行');
    assert.ok(rolePos < memPos && memPos < taskPos, `尾块顺序应为 role < memory < task：${rolePos} ${memPos} ${taskPos}`);
  });
});

test('未声明 memory 的 agent → 无记忆行、无自有目录（目录注册制与内建预设两形态）', async () => {
  await withEnv(undefined, async (tmp) => {
    const h = (() => {
      const root = path.join(tmp, 'root');
      writeAgentMaterials(root);
      return makeHarness(tmp);
    })();
    // 目录注册制（plain）：帧无记忆引导、无目录创建
    const s1 = new ScriptedAdapter([JSON.stringify({ done: true, reply: 'ok' })]);
    const { model: m1, prompts: p1 } = capturePrompts(s1);
    await h.makeRunner(m1).runSubagent({ agent_id: 'plain', prompt: '普通任务' });
    const frame1 = p1[p1.length - 1];
    assert.ok(frame1.includes('Your role:'), 'plain 有角色行');
    assert.ok(!frame1.includes('Your own persistent memory'), '未声明 memory 不得注入记忆引导行');
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'memory', 'agents', 'plain')), '未声明 memory 不得创建自有目录');
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'memory', 'agents')), 'agents 记忆子树整体不得被误建');
    // 内建预设角色（planner）：同形态
    const s2 = new ScriptedAdapter([JSON.stringify({ done: true, reply: 'ok' })]);
    const { model: m2, prompts: p2 } = capturePrompts(s2);
    await h.makeRunner(m2).runSubagent({ agent_id: 'planner', prompt: '内建角色任务' });
    assert.ok(!p2[p2.length - 1].includes('Your own persistent memory'), '内建预设角色无记忆行');
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'memory', 'agents', 'planner')), '内建预设角色不得创建自有目录');
  });
});

test('子代理写入 scope 收窄：只可写自身 agents/<id>，主记忆目录被拒', async () => {
  await withEnv(undefined, async (tmp) => {
    const h = (() => {
      const root = path.join(tmp, 'root');
      writeAgentMaterials(root);
      return makeHarness(tmp);
    })();
    seedOwnMemory(h);
    const mainDir = new MemoryStore(h.root).dir();
    const scripted = new ScriptedAdapter([
      JSON.stringify({ tool: 'write', input: { path: path.join(mainDir, 'hijack.md'), content: '---\ntype: project\ndescription: hijack attempt\n---\nshould not land' } }),
      JSON.stringify({ tool: 'write', input: { path: path.join(mainDir, 'agents', 'auditor', 'own-fact.md'), content: '---\ntype: project\ndescription: auditor own fact\n---\nown scope write lands' } }),
      JSON.stringify({ done: true, reply: '写入收口' }),
    ]);
    const { model } = capturePrompts(scripted);
    const r = await h.makeRunner(model).runSubagent({ agent_id: 'auditor', prompt: '写自有记忆' });
    assert.ok(r.ok, `spawn 应成功：${JSON.stringify(r)}`);
    // 主记忆目录被拒：越界写入零落盘
    assert.ok(!fs.existsSync(path.join(mainDir, 'hijack.md')), '越界写主记忆目录必须被拒且零落盘');
    // 自身目录放行：文件经接缝规范化落盘、索引重建含该条（下会话可见）
    const ownDir = path.join(h.dataDir, 'memory', 'agents', 'auditor');
    const landed = fs.readdirSync(ownDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    assert.equal(landed.length, 2, `自身目录应含预置+新写两条记录：${landed.join(',')}`);
    const ownIndex = fs.readFileSync(path.join(ownDir, 'MEMORY.md'), 'utf8');
    assert.ok(ownIndex.includes('auditor own fact'), '新写记录应进自有索引');
  });
});

test('autoMemory: off → memory:true agent 亦无记忆行、无自有目录（总开关四贯通之注入面）', async () => {
  await withEnv('off', async (tmp) => {
    const h = (() => {
      const root = path.join(tmp, 'root');
      writeAgentMaterials(root);
      return makeHarness(tmp);
    })();
    const scripted = new ScriptedAdapter([JSON.stringify({ done: true, reply: 'ok' })]);
    const { model, prompts } = capturePrompts(scripted);
    const before = h.context.chainView();
    const r = await h.makeRunner(model).runSubagent({ agent_id: 'auditor', prompt: '关态任务' });
    assert.ok(r.ok);
    const frame = prompts[prompts.length - 1];
    assert.ok(frame.includes('Your role:'), '角色行不受开关影响');
    assert.ok(!frame.includes('Your own persistent memory'), '总开关关 → 不注入记忆引导行');
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'memory', 'agents', 'auditor')), '总开关关 → 不创建自有目录');
    // 主链语义不变：终态仍恰好一行 node 结论行
    const after = h.context.chainView();
    assert.equal(after.length, before.length + 1);
    assert.equal(after[after.length - 1].action, 'node');
  });
});
