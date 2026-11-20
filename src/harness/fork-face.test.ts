/** L2 终审 Important(fork 面剔除未闭合):loop/graph 两处 fork-scope 派生点曾只剔 spawn——
 *  send_agent_team_message / create_agent_teammate / 板四件套会泄入 fork 子面(板任务内部 fork 曾误调 create_agent_teammate)。
 *  修复裁定:三处派生点(subagent deriveChildRegistry / loop agentNode / graph makeLoopNode)同源消费
 *  FORK_EXCLUDED_TOOLS(send_agent_team_message + create_agent_teammate + agent_team_task_wait/stop + TASKBOARD_TOOL_NAMES);常量即契约——本文件钉测常量内容 +
 *  直测三处派生输出面(loop/graph 用 derive 间谍捕获产品派生点产物,不经内部实现细节)。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harness, SUNX_FACE_TOOLS } from './index';
import { RegisteredTool, ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { FORK_EXCLUDED_TOOLS, SUNX_ORCHESTRATION_TOOLS, TASKBOARD_TOOL_NAMES } from './tools/taskboard-tools';
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
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  // 假件(spawn/send_agent_team_message/四件套):证明确实被派生剔除,而非本就不在场
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

test('常量契约:FORK_EXCLUDED_TOOLS = send_agent_team_message + create_agent_teammate + agent_team_task_wait/stop + 四件套(单点定义,三派生点同源)', () => {
  assert.deepEqual(
    [...FORK_EXCLUDED_TOOLS],
    ['send_agent_team_message', 'create_agent_teammate', 'agent_team_task_wait', 'agent_team_task_stop', ...TASKBOARD_TOOL_NAMES],
  );
  assert.equal(FORK_EXCLUDED_TOOLS.length, TASKBOARD_TOOL_NAMES.length + 4);
  assert.ok(FORK_EXCLUDED_TOOLS.includes('create_agent_teammate'), 'create_agent_teammate 应在剔除族(板任务 fork 不得建成员)');
  assert.ok(FORK_EXCLUDED_TOOLS.includes('agent_team_task_wait'), 'agent_team_task_wait 应在剔除族(lead-only)');
  assert.ok(FORK_EXCLUDED_TOOLS.includes('agent_team_task_stop'), 'agent_team_task_stop 应在剔除族(lead-only)');
  assert.equal(FORK_EXCLUDED_TOOLS.includes('task_wait' as typeof FORK_EXCLUDED_TOOLS[number]), false, 'task_wait 不入剔除族(子面保留等 exec)');
  assert.equal(FORK_EXCLUDED_TOOLS.includes('task_stop' as typeof FORK_EXCLUDED_TOOLS[number]), false, 'task_stop 不入剔除族(子面保留停 exec)');
  for (const n of TASKBOARD_TOOL_NAMES) assert.ok(FORK_EXCLUDED_TOOLS.includes(n), `四件套 ${n} 应在剔除族`);
  // 三处消费点源码同源钉测(防再内联漂移;沿 prompt-language.test.ts 源扫描先例)
  const ROOT = path.resolve(__dirname, '..', '..');
  for (const rel of ['src/harness/subagent.ts', 'src/loop/nodes.ts', 'src/graph/nodes.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(src.includes('FORK_EXCLUDED_TOOLS'), `${rel} 应消费 FORK_EXCLUDED_TOOLS(三处同源)`);
  }
});

test('subagent 派生点:deriveChildRegistry 缺省/显式 allowlist 两分支均剔 send_agent_team_message+create_agent_teammate+四件套(真 Harness)', async () => {
  const tmp = mktmp('sunshinex-forkface-sub-');
  let h: Harness | undefined;
  try {
    h = new Harness({ root: tmp, mode: 'full-access', model: new ScriptedAdapter([]), learnSkills: false });
    for (const name of FORK_EXCLUDED_TOOLS) {
      assert.notEqual(h.tools.get(name), undefined, `lead 主面应有 ${name}(剔除应发生在派生点)`);
    }
    const faceDefault = h.runner.deriveChildRegistry();
    for (const name of FAMILY) assert.equal(faceDefault.get(name), undefined, `缺省派生不得含 ${name}`);
    // 2026-11-14 用户裁定「spawn tools 口封闭」:显式 allowlist 支路退役,子面口径单一(此断言随闭口改钉)
    const faceSingle = h.runner.deriveChildRegistry();
    for (const name of FORK_EXCLUDED_TOOLS) assert.equal(faceSingle.get(name), undefined, `单一口径恒剔 ${name}`);
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // sunx 工具面(2026-11-15 P1 Task 3):dispatch_task/task_status 入剔除族——sunx 装配基面持两件,
  // 派生面必无(防子生孙/自派发;standard 基面本就无两件,断言须在 sunx 装配上才有效)
  const tmpSunx = mktmp('sunshinex-forkface-sub-sunx-');
  let hx: Harness | undefined;
  try {
    hx = new Harness({ root: tmpSunx, mode: 'full-access', kind: 'sunx', model: new ScriptedAdapter([]), learnSkills: false });
    assert.notEqual(hx.tools.get('dispatch_task'), undefined, 'sunx 基面应有 dispatch_task(剔除应发生在派生点)');
    assert.notEqual(hx.tools.get('task_status'), undefined, 'sunx 基面应有 task_status(剔除应发生在派生点)');
    const faceSunx = hx.runner.deriveChildRegistry();
    assert.equal(faceSunx.get('dispatch_task'), undefined, 'fork 面不得含 dispatch_task(防子生孙)');
    assert.equal(faceSunx.get('task_status'), undefined, 'fork 面不得含 task_status(防自派发)');
    assert.notEqual(faceSunx.get('task_wait'), undefined, 'task_wait 仍在子面(等 exec 不受影响)');
  } finally {
    hx?.team.stopAll();
    hx?.tasks.stopAll();
    fs.rmSync(tmpSunx, { recursive: true, force: true });
  }
});

test('sunx fork 子面路由 ask 保留:deps.ask 在场 + askedBy 派生 → ask_question 在场(2026-11-14 既有裁定回归锚;Task 3 剔除族追加不得破坏该路径)', () => {
  const tmp = mktmp('sunshinex-forkface-ask-');
  let h: Harness | undefined;
  try {
    h = new Harness({
      root: tmp,
      mode: 'full-access',
      kind: 'sunx',
      model: new ScriptedAdapter([]),
      learnSkills: false,
      ask: async () => ({ type: 'dismissed' }),
    });
    const face = h.runner.deriveChildRegistry({ label: 'child-a' });
    assert.notEqual(face.get('ask_question'), undefined, '路由版 ask_question 应在 fork 面(askedBy 归因直通主对话挂起卡)');
    assert.equal(face.get('dispatch_task'), undefined, '路由 ask 与剔除族互不干扰:fork 面仍无 dispatch_task');
    const plain = h.runner.deriveChildRegistry();
    assert.equal(plain.get('ask_question'), undefined, '缺 askedBy 派生不注册 ask(旧制:结论回写即应答)');
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('常量契约:SUNX_ORCHESTRATION_TOOLS = 分派/窥视/调度四件(fix round 1 单点;2026-11-20 并入 schedule_*——子代不得给父会话排定时任务;三派生点同源;对偶 SUNX_FACE_TOOLS、不入板面剔除族)', () => {
  assert.deepEqual([...SUNX_ORCHESTRATION_TOOLS], ['dispatch_task', 'task_status', 'schedule_wakeup', 'schedule_task'], '编排件剔除族单点内容');
  for (const n of SUNX_ORCHESTRATION_TOOLS) {
    assert.ok(SUNX_FACE_TOOLS.includes(n), `${n} 应在 SUNX_FACE_TOOLS 白名单（主链准入——白名单=主链有,本清单=子面必无,语义对偶）`);
    assert.equal(FORK_EXCLUDED_TOOLS.includes(n as typeof FORK_EXCLUDED_TOOLS[number]), false, `${n} 不入 FORK_EXCLUDED_TOOLS（板面剔除族契约不混编排件）`);
  }
  // 三处消费点源码同源钉测（防再内联漂移;沿本文件 FORK_EXCLUDED_TOOLS 源扫描先例）
  const ROOT = path.resolve(__dirname, '..', '..');
  for (const rel of ['src/harness/subagent.ts', 'src/loop/nodes.ts', 'src/graph/nodes.ts']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(src.includes('SUNX_ORCHESTRATION_TOOLS'), `${rel} 应消费 SUNX_ORCHESTRATION_TOOLS（三处派生点同源）`);
  }
});

test('sunx 装配 loop/graph fork 派生点:私有面剔 dispatch_task/task_status(编排件不下放,防子生孙/自派发),ask_question 保留(deps.ask 在场)', async () => {
  // loop agentNode scope=fork:直测产品派生点输出面(derive 间谍,不经内部实现细节)
  const tmpLoop = mktmp('sunshinex-forkface-loop-sunx-');
  let hLoop: Harness | undefined;
  try {
    hLoop = new Harness({
      root: tmpLoop,
      mode: 'full-access',
      kind: 'sunx',
      model: new ScriptedAdapter([]),
      learnSkills: false,
      ask: async () => ({ type: 'dismissed' }),
    });
    assert.notEqual(hLoop.tools.get('dispatch_task'), undefined, 'sunx 基面应有 dispatch_task(剔除应发生在派生点)');
    assert.notEqual(hLoop.tools.get('task_status'), undefined, 'sunx 基面应有 task_status');
    const facesLoop: ToolRegistry[] = [];
    const realLoopDerive = hLoop.tools.derive.bind(hLoop.tools);
    hLoop.tools.derive = (opts?: { exclude?: string[]; only?: string[] }) => {
      const child = realLoopDerive(opts);
      facesLoop.push(child);
      return child;
    };
    const loopDeps: LoopDeps = { safety: hLoop.safety, registry: hLoop.tools, context: hLoop.context, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) };
    const out = await agentNode({ ...loopDeps, scope: 'fork' }, { maxSteps: 2 }).run(loopCtx(), null);
    assert.equal(out.status, 'done', 'agent 节点应正常收束');
    assert.equal(facesLoop.length, 1, 'fork 私有面应经基面 derive 恰一次');
    const loopFace = facesLoop[0]!;
    assert.equal(loopFace.get('dispatch_task'), undefined, 'loop fork 面不得含 dispatch_task(防子生孙)');
    assert.equal(loopFace.get('task_status'), undefined, 'loop fork 面不得含 task_status(防自派发)');
    assert.notEqual(loopFace.get('ask_question'), undefined, 'deps.ask 在场装配的 fork 面保留 ask_question(问询通道不因编排剔除而收走)');
  } finally {
    hLoop?.team.stopAll();
    hLoop?.tasks.stopAll();
    fs.rmSync(tmpLoop, { recursive: true, force: true });
  }
  // graph makeLoopNode fork 面同口径
  const tmpGraph = mktmp('sunshinex-forkface-graph-sunx-');
  let hGraph: Harness | undefined;
  try {
    hGraph = new Harness({
      root: tmpGraph,
      mode: 'full-access',
      kind: 'sunx',
      model: new ScriptedAdapter([]),
      learnSkills: false,
      ask: async () => ({ type: 'dismissed' }),
    });
    const facesGraph: ToolRegistry[] = [];
    const realGraphDerive = hGraph.tools.derive.bind(hGraph.tools);
    hGraph.tools.derive = (opts?: { exclude?: string[]; only?: string[] }) => {
      const child = realGraphDerive(opts);
      facesGraph.push(child);
      return child;
    };
    const graphDeps: LoopDeps = { safety: hGraph.safety, registry: hGraph.tools, context: hGraph.context, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) };
    const node = makeLoopNode('n1', {
      template: 'test-loop',
      goal: '完成任务(验收标准:c1=完成)',
      ruleCheckers: { c1: async () => true },
    });
    const term: GraphTermination = { maxNodes: 4, maxTokens: 100_000, timeoutMs: 60_000 };
    const ctx: GraphContext = { state: {}, tokensUsed: 0, startedAt: Date.now(), results: {}, termination: term };
    const o = await node.run(ctx, graphDeps, {});
    assert.equal(o.status, 'pass', `loop 节点应收敛 pass:${JSON.stringify(o)}`);
    assert.equal(facesGraph.length, 1, 'graph fork 面应经基面 derive 恰一次');
    const graphFace = facesGraph[0]!;
    assert.equal(graphFace.get('dispatch_task'), undefined, 'graph 节点 fork 面不得含 dispatch_task');
    assert.equal(graphFace.get('task_status'), undefined, 'graph 节点 fork 面不得含 task_status');
    assert.notEqual(graphFace.get('ask_question'), undefined, 'graph fork 面同样保留 ask_question');
  } finally {
    hGraph?.team.stopAll();
    hGraph?.tasks.stopAll();
    fs.rmSync(tmpGraph, { recursive: true, force: true });
  }
});

test('loop 派生点:agentNode scope=fork 的私有面剔 send_agent_team_message+四件套(直测产品派生点输出面)', async () => {
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

test('graph 派生点:makeLoopNode fork 面剔 send_agent_team_message+四件套(直测产品派生点输出面)', async () => {
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
