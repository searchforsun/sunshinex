/** T3(create_agent_teammate + teammate 工具面):独立动词建长驻执行体 → TeamRegistry
 *  长驻 teammate(非 fork);teammate 派生面 get_agent_team_board/get_task 只读注入、主链面零污染;agent_team_task_stop 按名可打断。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { CodedToolError } from './tools';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { deriveTeammateRegistry } from '../taskboard/teammate-tools';
import { MemoryAgentTeamStore } from '../taskboard/team-registry';
import type { AgentTeamRegistry } from '../taskboard/team-registry';
import type { AskUserRequest, ChatRequest } from '../types';

const TEAM_ID = 'team-alpha-test';

/** 经 harness 注册表注入固定 teamId（会话隔离后不再写工作区级 teams/registry.json） */
function seedTeam(agentTeams: AgentTeamRegistry): void {
  const store = new MemoryAgentTeamStore();
  store.save([{ teamId: TEAM_ID, name: 'alpha', createdAt: 1 }]);
  agentTeams.adopt(store);
}

function withDataDir(root: string): () => void {
  const prev = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(root, 'data');
  return () => {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
  };
}

const TEAM_ENVELOPE = JSON.stringify({ tool: 'create_agent_teammate', input: { teamId: TEAM_ID, name: 'w1', prompt: 'review stuff' } });

test('create_agent_teammate:teammate 建成(aliveNames 含 w1),回执 teammate w1 started,主链面零污染、teammate 面含 get_agent_team_board/get_task,agent_team_task_stop 按名可打断', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tm-spawn-1-'));
  const restore = withDataDir(tmp);
  let h: Harness | undefined;
  try {
    const model = new ScriptedAdapter([
      TEAM_ENVELOPE,
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false });
    seedTeam(h.agentTeams);
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true, '主链应正常收束');
    const obs = r.steps.map((s) => s.observation).join('\n');
    assert.ok(/teammate "?w1"? started/.test(obs), `spawn 观察应含 teammate w1 started,实际:${obs}`);
    // 长驻体定位(2026-10-20 用户裁决「teammate 是声明不是任务」):存活面=TeamRegistry 活名,
    // 不进任务账本(账本只承载有生命周期的工作单元);打断=agent_team_task_stop 按名寻址
    assert.ok(h.team.aliveNames().includes('w1'), 'w1 应为活 teammate');
    assert.ok(!h.tasks.list().some((t) => t.label === 'w1'), 'teammate 不进任务账本(无生命周期不入工作单元账)');
    // agent_team_task_stop 按名=打断当前任务,成员存活(上下文承载体无停止概念;任务才有生命周期)
    const stopOut = (await h.tools.execute('agent_team_task_stop', { taskId: 'w1' }, h.safety)) as
      | { ok: true; value: { stdout: string } }
      | { ok: false; error: { message: string } };
    assert.ok(stopOut.ok, `agent_team_task_stop 按名打断应成功`);
    if (stopOut.ok) assert.match(stopOut.value.stdout, /idle|interrupted/, '回执按在跑与否分流');
    assert.equal(h.team.get('w1')!.stopped, false, '成员存活(不消亡)');
    // 面隔离(2026-10-20 收束后):get_agent_team_board 读权收编进主链面;teammate 派生面剔除写板四件套、
    // 注入只读对(get_agent_team_board/get_task)
    assert.ok(h.tools.get('get_agent_team_board') !== undefined, '主链面含 get_agent_team_board(板读取权在 lead)');
    assert.equal(h.tools.get('get_task'), undefined, '主链面不得有 get_task');
    const face = deriveTeammateRegistry(h.tools, h.taskboard, { tasks: h.tasks });
    assert.ok(face.get('get_agent_team_board') !== undefined, 'teammate 面应含 get_agent_team_board');
    assert.ok(face.get('get_task') !== undefined, 'teammate 面应含 get_task');
    assert.equal(face.get('spawn'), undefined, 'teammate 面不得再生子代');
    assert.equal(face.get('create_agent_team_task'), undefined, 'teammate 面不得碰板面写操作');
    assert.equal(face.get('create_agent_teammate'), undefined, 'teammate 面不得再建成员(lead-only)');
    assert.notEqual(face.get('task_wait'), undefined, 'teammate 面保留 task_wait(等 exec 自动转后台)');
    // fork 子面剔除 send_agent_team_message / create_agent_teammate(消息身份与建成员属 lead);task_wait 保留为 exec-only
    assert.equal(h.runner.deriveChildRegistry().get('send_agent_team_message'), undefined, 'fork 子面缺省派生不得含 send_agent_team_message');
    assert.equal(h.runner.deriveChildRegistry().get('create_agent_teammate'), undefined, 'fork 子面不得含 create_agent_teammate');
    assert.notEqual(h.runner.deriveChildRegistry().get('task_wait'), undefined, 'fork 子面保留 task_wait(exec-only)');
    assert.equal(h.runner.deriveChildRegistry().get('send_agent_team_message'), undefined, '显式 allowlist 亦恒剔除 send_agent_team_message');
    assert.equal(h.runner.deriveChildRegistry().get('create_agent_teammate'), undefined, '显式 allowlist 亦恒剔除 create_agent_teammate');
    assert.notEqual(h.runner.deriveChildRegistry().get('task_wait'), undefined, '显式 allowlist 内 task_wait 换装保留');
    const created = h.taskboard.create({ teamId: TEAM_ID, title: 'A', spec: 'do A stuff' });
    assert.ok(created.ok);
    const aId = created.value.taskId;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const status = h.taskboard.snapshot().tasks[aId]!.status;
    const boardOut = (await face.get('get_agent_team_board')!.executor({})) as { stdout: string };
    assert.ok(boardOut.stdout.includes(`${aId} [${status}] A`), 'get_agent_team_board 应回板摘要行');
    const taskOut = (await face.get('get_task')!.executor({ taskId: aId })) as { stdout: string };
    assert.ok(taskOut.stdout.includes(`id: ${aId}`));
    assert.match(taskOut.stdout, new RegExp(`status: ${status}`));
    assert.match(taskOut.stdout, /spec: do A stuff/);
    await assert.rejects(
      face.get('get_task')!.executor({ taskId: 'zz' }),
      (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG',
      '未知 taskId 应 INVALID_ARG',
    );
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create_agent_teammate:agent_id 字符串 "null" 归一为缺席——只传 prompt 即可建队友(防 Subagent not found 死循环)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tm-nullish-'));
  const restore = withDataDir(tmp);
  let h: Harness | undefined;
  try {
    h = new Harness({ root: tmp, mode: 'full-access', model: new ScriptedAdapter([]), learnSkills: false });
    seedTeam(h.agentTeams);
    const r = await h.tools.execute(
      'create_agent_teammate',
      { teamId: TEAM_ID, name: '小助手', prompt: 'help with board tasks', agent_id: 'null' },
      h.safety,
    );
    assert.ok(r.ok && r.value.exitCode === 0, `agent_id:"null" 应成功:${JSON.stringify(r)}`);
    assert.match(r.value.stdout, /teammate "小助手" started/);
    assert.ok(h.team.aliveNames().includes('小助手'));
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create_agent_teammate 带 agent_id:目录注册角色的 frontmatter 成为队友框定(name=agent_id)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tm-spawn-2-'));
  const restore = withDataDir(tmp);
  let h: Harness | undefined;
  try {
    fs.mkdirSync(path.join(tmp, 'agents', 'ee'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'agents', 'ee', 'agent.md'),
      '---\nname: EE\ndescription: x\nexecutor: internal-team\n---\nYou are the reviewer.\n',
      'utf8',
    );
    const model = new ScriptedAdapter([
      JSON.stringify({ tool: 'create_agent_teammate', input: { teamId: TEAM_ID, name: 'ee', agent_id: 'ee' } }),
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false });
    seedTeam(h.agentTeams);
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true);
    const obs = r.steps.map((s) => s.observation).join('\n');
    assert.ok(obs.includes('teammate "ee" started') || obs.includes('teammate ee started'), `create_agent_teammate 应建 teammate ee,实际:${obs}`);
    assert.ok(h.team.aliveNames().includes('ee'));
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mode 缺席 + 无 frontmatter executor:普通 fork 路径原样(team 零登记)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tm-spawn-3-'));
  let h: Harness | undefined;
  try {
    h = new Harness({ root: tmp, mode: 'full-access', model: new ScriptedAdapter([]), learnSkills: false });
    // 无预算源(reactor run 外直执):fork 路径确定性 INVALID_STATE 回执——证明走的是 SubagentRunner 而非 team 分流
    const r = await h.tools.execute('spawn', { prompt: 'x' }, h.safety);
    assert.ok(r.ok && r.value.exitCode === 1 && r.value.stdout.includes('budget source not attached'), `应走 fork 路径,实际:${JSON.stringify(r)}`);
    assert.deepEqual(h.team.aliveNames(), [], 'team 零登记');
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mountTeammate 链注 ask/kind(P2 Task 1):sunx 装配成员面路由 ask(askedBy=成员名+板任务 id)且稳定段带 Sunx 身份行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tm-spawn-askkind-'));
  const restore = withDataDir(tmp);
  let h: Harness | undefined;
  try {
    const prompts: string[] = [];
    const seen: AskUserRequest[] = [];
    const base = new ScriptedAdapter([
      JSON.stringify({ tool: 'ask_question', input: { question: 'Proceed?', options: [{ label: 'A' }, { label: 'B' }] } }),
      JSON.stringify({ done: true, reply: 'ok' }),
    ]);
    const model: ModelAdapter = {
      provider: 'probe',
      chat: async (req: ChatRequest) => {
        prompts.push(req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
        return base.chat(req);
      },
    };
    const parentAsk = async (req: AskUserRequest): Promise<{ type: 'dismissed' }> => {
      seen.push(req);
      return { type: 'dismissed' };
    };
    // sunx 装配 + 真实 ask 接缝:opts.kind/opts.ask 经 mountTeammate 链入 teammate(TeammateDeps.kind/registryFactory)
    h = new Harness({ root: tmp, mode: 'full-access', kind: 'sunx', model, learnSkills: false, ask: parentAsk });
    seedTeam(h.agentTeams);
    const created = await h.tools.execute('create_agent_teammate', { teamId: TEAM_ID, name: 'w1', prompt: 'help board tasks', agent_id: 'null' }, h.safety);
    assert.ok(created.ok && created.value.exitCode === 0, `create_agent_teammate 应成功:${JSON.stringify(created)}`);
    assert.ok(h.team.aliveNames().includes('w1'), 'w1 应为活 teammate');
    const t = h.taskboard.create({ teamId: TEAM_ID, title: 'A', spec: 'do A' });
    assert.ok(t.ok);
    const idA = t.value.taskId;
    const okA = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (h!.taskboard.snapshot().tasks[idA]?.status === 'success') return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return h!.taskboard.snapshot().tasks[idA]?.status === 'success';
    })();
    assert.ok(okA, `成员应消化板任务(ask 裁决回填后收口):${JSON.stringify(h.taskboard.snapshot().tasks[idA])}`);
    assert.equal(seen.length, 1, '路由 ask 恰一次到装配接缝');
    assert.deepEqual(seen[0].askedBy, { label: 'w1', taskId: idA }, '归因=成员名+板任务 id(mountTeammate 闭包转交 deriveTeammateRegistry)');
    assert.ok(prompts[0]?.includes('You are the SunshineX agent'), `sunx 装配的成员=standard 身份面(2026-11-16 二轮裁定「根部不加工具和分派工具,不需要反向约束,更加纯净」;自有 fresh ctx 既有):${prompts[0]?.slice(0, 200)}`);
    assert.ok(!prompts[0]?.includes('You are the Sunx orchestrator'), '零编排者身份行(成员是 worker,矛盾从根上不产生)');
    assert.ok(!prompts[0]?.includes('never do the work yourself'), '零编排章程行组(随身份槽一并退出)');
    assert.ok(!prompts[0]?.includes('Override:'), '零覆写尾行(覆写是 chain 同面通道补丁,clean 面不需要)');
    assert.ok(!prompts[0]?.includes('dispatch_task tool'), '零反向约束(工具清单自会说话,提示词不重复干工具描述的活)');
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
