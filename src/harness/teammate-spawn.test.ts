/** T3(create_teammate + teammate 工具面):独立动词建长驻执行体 → TeamRegistry
 *  长驻 teammate(非 fork);teammate 派生面 get_board/get_task 只读注入、主链面零污染;task_stop 可停。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { CodedToolError } from './tools';
import { ScriptedAdapter } from '../model/adapter';
import { deriveTeammateRegistry } from '../taskboard/teammate-tools';
import { resolveDataDir } from '../config/data-dir';

const TEAM_ID = 'team-alpha-test';

function seedTeam(root: string): () => void {
  const prev = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(root, 'data');
  const dir = path.join(resolveDataDir(root), 'teams');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify([{ teamId: TEAM_ID, name: 'alpha', createdAt: 1 }]));
  return () => {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
  };
}

const TEAM_ENVELOPE = JSON.stringify({ tool: 'create_teammate', input: { teamId: TEAM_ID, name: 'w1', prompt: 'review stuff' } });

test('create_teammate:teammate 建成(aliveNames 含 w1),回执 teammate w1 started,主链面零污染、teammate 面含 get_board/get_task,task_stop 按名可停', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tm-spawn-1-'));
  const restore = seedTeam(tmp);
  let h: Harness | undefined;
  try {
    const model = new ScriptedAdapter([
      TEAM_ENVELOPE,
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true, '主链应正常收束');
    const obs = r.steps.map((s) => s.observation).join('\n');
    assert.ok(/teammate "?w1"? started/.test(obs), `spawn 观察应含 teammate w1 started,实际:${obs}`);
    // 长驻体定位(2026-10-20 用户裁决「teammate 是声明不是任务」):存活面=TeamRegistry 活名,
    // 不进任务账本(账本只承载有生命周期的工作单元);停止=task_stop 按名寻址
    assert.ok(h.team.aliveNames().includes('w1'), 'w1 应为活 teammate');
    assert.ok(!h.tasks.list().some((t) => t.label === 'w1'), 'teammate 不进任务账本(无生命周期不入工作单元账)');
    // task_stop 按名=打断当前任务,成员存活(上下文承载体无停止概念;任务才有生命周期)
    const stopOut = (await h.tools.execute('task_stop', { taskId: 'w1' }, h.safety)) as
      | { ok: true; value: { stdout: string } }
      | { ok: false; error: { message: string } };
    assert.ok(stopOut.ok, `task_stop 按名打断应成功`);
    if (stopOut.ok) assert.match(stopOut.value.stdout, /idle|interrupted/, '回执按在跑与否分流');
    assert.equal(h.team.get('w1')!.stopped, false, '成员存活(不消亡)');
    // 面隔离(2026-10-20 收束后):get_board 读权收编进主链面;teammate 派生面剔除写板四件套、
    // 注入只读对(get_board/get_task)
    assert.ok(h.tools.get('get_board') !== undefined, '主链面含 get_board(板读取权在 lead)');
    assert.equal(h.tools.get('get_task'), undefined, '主链面不得有 get_task');
    const face = deriveTeammateRegistry(h.tools, h.taskboard);
    assert.ok(face.get('get_board') !== undefined, 'teammate 面应含 get_board');
    assert.ok(face.get('get_task') !== undefined, 'teammate 面应含 get_task');
    assert.equal(face.get('spawn'), undefined, 'teammate 面不得再生子代');
    assert.equal(face.get('create_task'), undefined, 'teammate 面不得碰板面写操作');
    assert.equal(face.get('create_teammate'), undefined, 'teammate 面不得再建成员(lead-only)');
    // fork 子面剔除 send_message / create_teammate(消息身份与建成员属 lead)
    assert.equal(h.runner.deriveChildRegistry({}).get('send_message'), undefined, 'fork 子面缺省派生不得含 send_message');
    assert.equal(h.runner.deriveChildRegistry({}).get('create_teammate'), undefined, 'fork 子面不得含 create_teammate');
    assert.equal(h.runner.deriveChildRegistry({ tools: ['send_message', 'create_teammate', 'read'] }).get('send_message'), undefined, '显式 allowlist 亦恒剔除 send_message');
    assert.equal(h.runner.deriveChildRegistry({ tools: ['send_message', 'create_teammate', 'read'] }).get('create_teammate'), undefined, '显式 allowlist 亦恒剔除 create_teammate');
    const created = h.taskboard.create({ teamId: TEAM_ID, title: 'A', spec: 'do A stuff' });
    assert.ok(created.ok);
    const aId = created.value.taskId;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const status = h.taskboard.snapshot().tasks[aId]!.status;
    const boardOut = (await face.get('get_board')!.executor({})) as { stdout: string };
    assert.ok(boardOut.stdout.includes(`${aId} [${status}] A`), 'get_board 应回板摘要行');
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

test('create_teammate 带 agent_id:目录注册角色的 frontmatter 成为队友框定(name=agent_id)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tm-spawn-2-'));
  const restore = seedTeam(tmp);
  let h: Harness | undefined;
  try {
    fs.mkdirSync(path.join(tmp, 'agents', 'ee'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'agents', 'ee', 'agent.md'),
      '---\nname: EE\ndescription: x\nexecutor: internal-team\n---\nYou are the reviewer.\n',
      'utf8',
    );
    const model = new ScriptedAdapter([
      JSON.stringify({ tool: 'create_teammate', input: { teamId: TEAM_ID, name: 'ee', agent_id: 'ee' } }),
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true);
    const obs = r.steps.map((s) => s.observation).join('\n');
    assert.ok(obs.includes('teammate "ee" started') || obs.includes('teammate ee started'), `create_teammate 应建 teammate ee,实际:${obs}`);
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
