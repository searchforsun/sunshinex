/** L2 终审 Important(fork 面剔除未闭合):loop/graph 两处 fork-scope 派生点曾只剔 spawn——
 *  send_message(lead 消息身份)与六件套 lead-only 板工具会泄入 fork 子面(经 TUI /init scope:'fork' 可达,lead 冒充)。
 *  修复裁定:三处派生点(subagent deriveChildRegistry / loop agentNode / graph makeLoopNode)同源消费
 *  FORK_EXCLUDED_TOOLS(send_message + TASKBOARD_TOOL_NAMES);常量即契约——本文件钉测常量内容 +
 *  直测三处派生输出面(loop/graph 用 derive 间谍捕获产品派生点产物,不经内部实现细节)。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harness } from './index';
import { RegisteredTool, ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { FORK_EXCLUDED_TOOLS, TASKBOARD_TOOL_NAMES } from './tools/taskboard-tools';
import { SPAWN_TOOL_NAME } from './subagent';
import { agentNode } from '../loop/nodes';
import { makeLoopNode } from '../graph/nodes';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ScriptedAdapter } from '../model/adapter';
import type { GraphContext, GraphTermination, LoopContext, LoopTermination } from '../types';
import type { LoopDeps } from '../loop/engine';

const FAMILY: readonly string[] = [SPAWN_TOOL_NAME, ...FORK_EXCLUDED_TOOLS];

const dummy = (name: string): RegisteredTool => ({
  name,
  description: `dummy ${name} for fork-face test`,
  parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
  category: 'task',
  executor: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
});

const mktmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** 装配真依赖(builtinTools + 假 lead 工具族),并在 registry 上挂 derive 间谍捕获产品派生点产物 */
function makeFaceDeps(root: string): { deps: LoopDeps; faces: ToolRegistry[] } {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  // 假件(spawn/send_message/六件套):证明确实被派生剔除,而非本就不在场
  for (const name of FAMILY) registry.register(dummy(name));
  const faces: ToolRegistry[] = [];
  const realDerive = registry.derive.bind(registry);
  registry.derive = (opts?: { exclude?: string[]; only?: string[] }) => {
    const child = realDerive(opts);
    faces.push(child);
    return child;
  };
  return { deps: { safety, registry, context: new ContextManager(root, new FileStore(root)), model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) }, faces };
}

/** 断言 fork 派生面:lead 身份/板权工具全剔,普通工具保留(证明是剔除而非空面) */
function assertForkFace(face: ToolRegistry, label: string, base: ToolRegistry): void {
  for (const name of FAMILY) {
    assert.notEqual(base.get(name), undefined, `${label}:基面应有 ${name}(剔除应发生在派生点)`);
    assert.equal(face.get(name), undefined, `${label}:fork 面不得含 ${name}`);
  }
  assert.notEqual(face.get('read'), undefined, `${label}:普通工具 read 应保留(非过度剔除)`);
}

const loopCtx = (): LoopContext => ({
  iteration: 1,
  state: { goal: 'g' },
  tokensUsed: 0,
  startedAt: Date.now(),
  termination: { maxIterations: 2, timeoutMs: 60_000 } as LoopTermination,
});

test('常量契约:FORK_EXCLUDED_TOOLS = send_message + 六件套(单点定义,三派生点同源)', () => {
  assert.deepEqual([...FORK_EXCLUDED_TOOLS], ['send_message', ...TASKBOARD_TOOL_NAMES]);
  assert.equal(FORK_EXCLUDED_TOOLS.length, TASKBOARD_TOOL_NAMES.length + 1);
  for (const n of TASKBOARD_TOOL_NAMES) assert.ok(FORK_EXCLUDED_TOOLS.includes(n), `六件套 ${n} 应在剔除族`);
  // 三处消费点源码同源钉测(防再内联漂移;沿 prompt-language.test.ts 源扫描先例)
  const ROOT = path.resolve(__dirname, '..', '..');
  for (const rel of ['src/harness/subagent.ts', 'src/loop/nodes.ts', 'src/graph/nodes.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(src.includes('FORK_EXCLUDED_TOOLS'), `${rel} 应消费 FORK_EXCLUDED_TOOLS(三处同源)`);
  }
});

test('subagent 派生点:deriveChildRegistry 缺省/显式 allowlist 两分支均剔 send_message+六件套(真 Harness)', async () => {
  const tmp = mktmp('sunshinex-forkface-sub-');
  let h: Harness | undefined;
  try {
    h = new Harness({ root: tmp, mode: 'dontAsk', model: new ScriptedAdapter([]), learnSkills: false });
    for (const name of FORK_EXCLUDED_TOOLS) {
      assert.notEqual(h.tools.get(name), undefined, `lead 主面应有 ${name}(剔除应发生在派生点)`);
    }
    const faceDefault = h.runner.deriveChildRegistry({});
    for (const name of FAMILY) assert.equal(faceDefault.get(name), undefined, `缺省派生不得含 ${name}`);
    const faceAllow = h.runner.deriveChildRegistry({ tools: ['send_message', 'create_task', 'read'] });
    for (const name of FORK_EXCLUDED_TOOLS) assert.equal(faceAllow.get(name), undefined, `显式 allowlist 亦恒剔 ${name}`);
    assert.notEqual(faceAllow.get('read'), undefined, 'allowlist 内普通工具应保留');
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loop 派生点:agentNode scope=fork 的私有面剔 send_message+六件套(直测产品派生点输出面)', async () => {
  const tmp = mktmp('sunshinex-forkface-loop-');
  try {
    const { deps, faces } = makeFaceDeps(tmp);
    const out = await agentNode({ ...deps, scope: 'fork' }, { maxSteps: 2 }).run(loopCtx(), null);
    assert.equal(out.status, 'done', 'agent 节点应正常收束(脚本化 done 回复)');
    assert.equal(faces.length, 1, 'fork 私有面应经基面 derive 恰一次');
    assertForkFace(faces[0]!, 'loop fork 面', deps.registry);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 反向控制:session 作用域零派生——主链工具面原样(lead 身份工具在主链在场)
  const tmp2 = mktmp('sunshinex-forkface-loop2-');
  try {
    const session = makeFaceDeps(tmp2);
    await agentNode(session.deps, { maxSteps: 2 }).run(loopCtx(), null);
    assert.equal(session.faces.length, 0, 'session 作用域不应派生收窄');
    for (const name of FAMILY) assert.notEqual(session.deps.registry.get(name), undefined, `session 主面应保留 ${name}`);
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('graph 派生点:makeLoopNode fork 面剔 send_message+六件套(直测产品派生点输出面)', async () => {
  const tmp = mktmp('sunshinex-forkface-graph-');
  try {
    const { deps, faces } = makeFaceDeps(tmp);
    const node = makeLoopNode('n1', {
      template: 'test-loop',
      goal: '完成任务(验收标准:c1=完成)',
      ruleCheckers: { c1: async () => true },
    });
    const term: GraphTermination = { maxNodes: 4, maxTokens: 100_000, timeoutMs: 60_000 };
    const ctx: GraphContext = { state: {}, tokensUsed: 0, startedAt: Date.now(), results: {}, termination: term };
    const o = await node.run(ctx, deps, {});
    assert.equal(o.status, 'pass', `loop 节点应收敛 pass:${JSON.stringify(o)}`);
    assert.equal(faces.length, 1, 'graph fork 面应经基面 derive 恰一次(loop 内层再派生发生在子面上,不计入)');
    assertForkFace(faces[0]!, 'graph fork 面', deps.registry);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
