import { textReplyToChatFace } from '../model/chat-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRegistry, resolveSpawnSpec, SubagentRunner } from './subagent';
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
import type { SessionEvent } from '../types';
import { TaskRegistry } from './tasks';
import type { ExecOpts } from '../types';

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

/* ---------- 执行半边（Task 3）测试脚手架 ---------- */

interface Harness {
  tmp: string;
  safety: SafetyChain;
  registry: ToolRegistry;
  context: ContextManager;
  makeRunner(model: ModelAdapter, onEvent?: (e: SessionEvent) => void, opts?: { noBudget?: boolean }): SubagentRunner;
}

function makeHarness(tmp: string): Harness {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const reg = new AgentRegistry();
  reg.registerBuiltins();
  return {
    tmp,
    safety,
    registry,
    context,
    // spawn 通道缺省挂标准预算源（对应 reactor run 接线）；失败用例可覆写、INVALID_STATE 用例可关闭
    makeRunner: (model, onEvent, opts) => {
      const runner = new SubagentRunner({ registry, safety, context, model, ...(onEvent ? { onEvent } : {}) }, reg);
      if (!opts?.noBudget) runner.attachParent(() => ({ maxSteps: 200, tokenCap: 100_000 }));
      return runner;
    },
  };
}

/** capture 桩：透传 scripted 应答并记录每次 prompt（回归矩阵取帧用，对齐 graph agents.test 惯用法） */
function captureModel(scripted: ScriptedAdapter): { model: ModelAdapter; prompts: string[] } {
  const prompts: string[] = [];
  const model: ModelAdapter = {
    provider: 'capture',
    chat: async (req, hooks) => {
      prompts.push(req.messages.map((m) => m.content).join('\n'));
      return scripted.chat(req, hooks);
    },
  } as ModelAdapter;
  return { model, prompts };
}

test('Runner 工具面收窄：todo_write 恒不在子面（规格 D9）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-runner-todo-'));
  try {
    const h = makeHarness(tmp);
    const runner = h.makeRunner(new ScriptedAdapter([JSON.stringify({ done: true, reply: 'ok' })]));
    const deft = runner.deriveChildRegistry();
    assert.ok(!deft.has('todo_write'), '缺省派生子面恒无 todo_write');
    const explicit = runner.deriveChildRegistry({ prompt: 'w', tools: ['todo_write', 'read'] });
    assert.ok(explicit.has('read'), '显式清单保留 read');
    assert.ok(!explicit.has('todo_write'), '显式列名同样剔除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('Runner fork 组装：子首帧 = 主链严格前缀 + 尾追（role/task 行只在尾部）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-runner-prefix-'));
  try {
    const scripted = new ScriptedAdapter([
      JSON.stringify({ done: true, reply: '子任务完成' }),
    ]);
    const { model, prompts } = captureModel(scripted);
    const h = makeHarness(tmp);
    // 主链预置两条链行（模拟已发生的主任务轨迹）
    h.context.appendChain([{ action: 'node', observation: 'planner：上游结论行' }, { action: 'task', observation: '主任务：落地某功能' }]);
    const mainTail = h.context.chainView();
    const runner = h.makeRunner(model);
    const r = await runner.runSubagent({ prompt: '独立子任务' }, { label: 'worker' });
    assert.ok(r.ok, `runSubagent 应成功：${JSON.stringify(r)}`);
    const forkFrame = prompts[prompts.length - 1];
    assert.ok(forkFrame.length > 0);
    // 主链基线文本必须逐字节出现在子首帧中（严格前缀语义：差异只允许在尾部尾追段）
    for (const step of mainTail) assert.ok(forkFrame.includes(step.observation), `主链行应进子首帧：${step.observation}`);
    assert.ok(
      forkFrame.lastIndexOf('独立子任务') > forkFrame.lastIndexOf('主任务：落地某功能'),
      '任务行尾追位于基线之后（尾部差异）',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Runner 私有性：子运行期间 chainView 零增长；成功终态恰好 +1 行（action node、[label] 前缀、首行截断）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-runner-private-'));
  try {
    // 子 Reactor 先执行一次工具调用再 done：工具观察必须只进 fork，不进主链
    const { model } = captureModel(new ScriptedAdapter([
      JSON.stringify({ tool: 'exec', input: { command: 'echo fork-step' }, done: false }),
      JSON.stringify({ done: true, reply: '结论首行\n第二行不应入链' }),
    ]));
    const h = makeHarness(tmp);
    const baseline = h.context.chainView().length;
    const runner = h.makeRunner(model);
    const r = await runner.runSubagent({ prompt: '干点活' }, { label: 'worker' });
    assert.ok(r.ok);
    assert.equal(r.value.reply, '结论首行\n第二行不应入链');
    const after = h.context.chainView();
    assert.equal(after.length, baseline + 1, '终态恰好回写一行（结论行）');
    const last = after[after.length - 1];
    assert.equal(last.action, 'node');
    assert.ok(last.observation.startsWith('[worker] '), `结论行带 [label] 前缀，实际：${last.observation}`);
    assert.ok(last.observation.includes('结论首行') && !last.observation.includes('第二行'), '结论行只取 reply 首行（截断摘要）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Runner 失败补丁行：子 Reactor 未完成 → 恰好 +1 行（action note）且 Result.fail', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-runner-fail-'));
  try {
    // 预算钉 maxSteps=1 且模型永远不给 done：步数耗尽 → 子未完成收束
    const { model } = captureModel(new ScriptedAdapter([
      JSON.stringify({ tool: 'exec', input: { command: 'echo step' }, done: false }),
    ]));
    const h = makeHarness(tmp);
    const baseline = h.context.chainView().length;
    const runner = h.makeRunner(model);
    const r = await runner.runSubagent({ prompt: '干点活' }, { label: 'worker', budget: { maxSteps: 1, tokenCap: 100_000 } });
    assert.ok(!r.ok, '未完成收束应返回 fail');
    assert.ok(['INCOMPLETE', 'MAX_STEPS'].includes(r.error.code), `失败码应为护栏语义，实际 ${r.error.code}`);
    const after = h.context.chainView();
    assert.equal(after.length, baseline + 1, '终态恰好回写一行（补丁行）');
    const last = after[after.length - 1];
    assert.equal(last.action, 'note');
    assert.ok(last.observation.startsWith('[worker] '), `补丁行带 [label] 前缀，实际：${last.observation}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Runner 工具面收窄：缺省子面 = 父全量 − spawn；tools 收窄取交集', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-runner-narrow-'));
  try {
    const h = makeHarness(tmp);
    const runner = h.makeRunner(new ScriptedAdapter([JSON.stringify({ done: true, reply: 'ok' })]));
    const narrowed = runner.deriveChildRegistry({ prompt: 'w', tools: ['read'] });
    const names = narrowed.list().map((t) => t.name);
    assert.ok(names.includes('read'), 'tools 收窄后子面保留 read');
    assert.ok(!names.includes('webfetch') && !names.includes('exec'), 'tools 收窄排除未列名工具');
    assert.ok(!names.includes('spawn'), '子面恒无 spawn');
    const deft = runner.deriveChildRegistry();
    assert.ok(deft.has('read') && deft.has('exec') && !deft.has('spawn'), '缺省派生 = 父全量 − spawn（深度 1 层缺省收窄）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Runner 并发护栏：同层第 5 个并发返回 CONCURRENCY_LIMIT，不排队', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-runner-conc-'));
  try {
    // 挂起式桩：首个 done 由测试手动释放，制造 4 个在飞
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const hanging: ModelAdapter = {
      provider: 'hang',
      chat: textReplyToChatFace(async () => {
        await gate;
        return JSON.stringify({ done: true, reply: 'ok' });
      }),
    };
    const h = makeHarness(tmp);
    const runner = h.makeRunner(hanging);
    const flights = Promise.all(
      Array.from({ length: 4 }, () => runner.runSubagent({ prompt: `并行任务`, label: 'w' })),
    );
    const fifth = await runner.runSubagent({ prompt: '第5个', label: 'x' });
    assert.ok(!fifth.ok && fifth.error.code === 'CONCURRENCY_LIMIT', `第 5 个并发应被拒，实际 ${JSON.stringify(fifth)}`);
    release();
    const results = await flights;
    assert.ok(results.every((r) => r.ok), '前 4 个并发在飞后应正常完成');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Runner 预算源缺失：未 attachParent 时显式 INVALID_STATE（禁静默递归）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-runner-nobudget-'));
  try {
    const h = makeHarness(tmp);
    // 显式关闭脚手架缺省预算源：spawn 通道无预算 → 必须失败而非静默
    const runner = h.makeRunner(new ScriptedAdapter([JSON.stringify({ done: true, reply: 'ok' })]), undefined, { noBudget: true });
    const r = await runner.runSubagent({ prompt: '孤儿派生' }, { label: 'w' });
    assert.ok(!r.ok && r.error.code === 'INVALID_STATE', `无预算源应 INVALID_STATE，实际 ${JSON.stringify(r)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Runner 事件透传：子代理事件经 onEvent 流出并带 subagent 标识', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-runner-event-'));
  try {
    const { model } = captureModel(new ScriptedAdapter([JSON.stringify({ done: true, reply: '事件任务完成' })]));
    const h = makeHarness(tmp);
    const events: SessionEvent[] = [];
    const runner = h.makeRunner(model, (e) => events.push(e));
    const r = await runner.runSubagent({ prompt: '发点事件' }, { label: 'evt' });
    assert.ok(r.ok);
    assert.ok(events.some((e) => e.type === 'done'), 'done 事件应透传');
    const doneEvt = events.find((e) => e.type === 'done')!;
    assert.equal(doneEvt.payload?.subagent, 'evt', '透传事件带子代理标识');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('同名并发消歧：后到者 label #N 后缀，事件与结论行一致；不冲突时保持裸 label', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sub-disamb-'));
  try {
    let gateResolve!: () => void;
    const gate = new Promise<void>((res) => {
      gateResolve = res;
    });
    let calls = 0;
    // 挂起适配器对齐 subagent.spawn.test.ts 并发用例惯用法（ModelAdapter.complete 签名）
    const model: ModelAdapter = {
      provider: 'probe',
      chat: textReplyToChatFace(async () => {
        calls++;
        if (calls <= 4) {
          await gate;
          return JSON.stringify({ done: true, reply: '子完成' });
        }
        return JSON.stringify({ done: true, reply: '主链完成' });
      }),
    } as ModelAdapter;
    const h = makeHarness(tmp);
    const events: SessionEvent[] = [];
    const runner = h.makeRunner(model, (e) => events.push(e));
    // 注意：此处不经 spawn 工具（子面已剔除 spawn），直接调 runSubagent 双发同名并行
    const p1 = runner.runSubagent({ prompt: 'p1', label: 'w' });
    const p2 = runner.runSubagent({ prompt: 'p2', label: 'w' });
    await new Promise((res) => setTimeout(res, 30)); // 等两个子 Reactor 先后创建（后到者消歧）
    gateResolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1.ok && r2.ok);
    const tags = events.filter((e) => e.type === 'done').map((e) => e.payload?.subagent);
    assert.deepEqual(
      [...tags].sort(),
      ['w', 'w#2'],
      `两个在飞同名子代理事件标识应互异，实际 ${JSON.stringify(tags)}`,
    );
    const chain = h.context.chainView();
    const nodeLines = chain.filter((s) => s.action === 'node').map((s) => s.observation);
    assert.equal(nodeLines.length, 2);
    assert.ok(nodeLines.every((l) => l.startsWith('[w')), `结论行前缀应带消歧 label，实际 ${JSON.stringify(nodeLines)}`);
    // 顺序结束后第三次 spawn：计数归零，回裸 label（按 r3 之后的事件切片判定）
    const before = events.length;
    const r3 = await runner.runSubagent({ prompt: 'p3', label: 'w' });
    assert.ok(r3.ok);
    const tagsAfter = events.slice(before).filter((e) => e.type === 'done').map((e) => e.payload?.subagent);
    assert.deepEqual(tagsAfter, ['w'], '并发清零后新 spawn 应回裸 label');
    runner.detachParent();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('exec background:true 提交即返回，观察行含任务 ID 与输出路径，输出落任务日志', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bgexec-'));
  try {
    const store = new FileStore(path.join(root, 'data'));
    const ctx = new ContextManager(root, store);
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
    const registry = new ToolRegistry();
    const tasks = new TaskRegistry(path.join(root, 'data'));
    for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tasks)) registry.register(t);
    const input = { command: 'echo step-1 && echo step-2', background: true };
    const p = registry.execute('exec', input, safety);
    // 等登记：execute 为异步提交（安全链审批→executor.submit），轮询账本出现记录后再断言字段
    for (let i = 0; i < 40 && tasks.list().length === 0; i++) await new Promise((r2) => setTimeout(r2, 50));
    const task = tasks.list().at(-1)!;
    assert.equal(task.kind, 'exec');
    assert.ok(task.outputFilePath.includes(path.join('data', 'tasks')), '日志落 <dataDir>/tasks/');
    for (let i = 0; i < 40 && tasks.get(task.id)?.status === 'running'; i++) await new Promise((r2) => setTimeout(r2, 50));
    const obs = await p.then((r) => (r.ok ? r.value.stdout : `EXEC_FAILED: ${r.error.message}`));
    assert.match(obs, /^task b1 started/);
    assert.ok(obs.includes(task.outputFilePath), '观察行含输出路径');
    const body = fs.readFileSync(task.outputFilePath, 'utf8');
    assert.ok(body.includes('step-1') && body.includes('step-2'), '输出流式落日志');
    assert.ok(body.endsWith('[exit 0]\n'), '终态行落文件尾');
    assert.equal(tasks.get(task.id)?.status, 'done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 小超时后端：把前台 exec 的 timeoutMs 钉到 120ms 构造超时转后台边界（CLAUDE.md §12 允许测试显式小值） */
class QuickTimeoutSandbox extends ProcessSandbox {
  exec(cmd: string, opts?: ExecOpts) {
    return super.exec(cmd, { ...opts, timeoutMs: opts?.timeoutMs ?? 120 });
  }
}

test('前台 exec 触超时转后台：观察行含 moved to background、任务接管存活子进程', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bgtimeout-'));
  try {
    const store = new FileStore(path.join(root, 'data'));
    const ctx = new ContextManager(root, store);
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new QuickTimeoutSandbox(), new DryRun(), root);
    const registry = new ToolRegistry();
    const tasks = new TaskRegistry(path.join(root, 'data'));
    for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tasks)) registry.register(t);
    const r = await registry.execute('exec', { command: 'echo warm && sleep 5' }, safety);
    assert.ok(r.ok);
    assert.match(r.value.stdout, /^command moved to background after timeout: task b1/);
    const task = tasks.get('b1')!;
    assert.equal(task.status, 'running', '超时瞬间任务转后台登记');
    assert.ok(fs.readFileSync(task.outputFilePath, 'utf8').includes('warm'), '超时前已缓冲输出随任务落日志');
    task.stop?.(); // 收尾：终结存活子进程
    for (let i = 0; i < 40 && tasks.get('b1')?.status === 'running'; i++) await new Promise((r2) => setTimeout(r2, 50));
    assert.notEqual(tasks.get('b1')?.status, 'running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sleep 开头命令超时不转后台：EXEC_TIMEOUT 照旧失败（规格 D5 豁免）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sleepexc-'));
  try {
    const store = new FileStore(path.join(root, 'data'));
    const ctx = new ContextManager(root, store);
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new QuickTimeoutSandbox(), new DryRun(), root);
    const registry = new ToolRegistry();
    const tasks = new TaskRegistry(path.join(root, 'data'));
    for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tasks)) registry.register(t);
    const r = await registry.execute('exec', { command: 'sleep 5' }, safety);
    assert.ok(!r.ok);
    assert.match(r.error.message, /EXEC_TIMEOUT/);
    assert.equal(tasks.list().length, 0, '豁免路径零任务登记');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
