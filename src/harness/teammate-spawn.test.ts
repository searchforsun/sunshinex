/** T3(spawn 双通道 + teammate 工具面):mode:'team' / frontmatter executor:internal-team → TeamRegistry
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

const TEAM_ENVELOPE = JSON.stringify({ tool: 'spawn', input: { prompt: 'review stuff', label: 'w1', mode: 'team' } });

test('spawn mode:team:teammate 建成(aliveNames 含 w1),回执 teammate w1 started,主链面零污染、teammate 面含 get_board/get_task,task_stop 可停', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tm-spawn-1-'));
  let h: Harness | undefined;
  try {
    const model = new ScriptedAdapter([
      TEAM_ENVELOPE,
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true, '主链应正常收束');
    const obs = r.steps.map((s) => s.observation).join('\n');
    assert.ok(obs.includes('teammate w1 started'), `spawn 观察应含 teammate w1 started,实际:${obs}`);
    // 长驻体登记:TeamRegistry 活名 + 台账 subagent 任务(task_stop 目标,stop 句柄已接)
    assert.ok(h.team.aliveNames().includes('w1'), 'w1 应为活 teammate');
    const ledgerTask = h.tasks.list().find((t) => t.label === 'w1' && t.kind === 'teammate');
    assert.ok(ledgerTask, 'teammate 应登记进任务账本(task_stop 目标)');
    assert.equal(ledgerTask!.status, 'running');
    assert.equal(typeof ledgerTask!.stop, 'function', 'stop 句柄应已接线');
    ledgerTask!.stop!();
    assert.equal(h.team.get('w1')!.stopped, true, '台账 stop 应停 teammate');
    // 面隔离:主链面无 get_board/get_task;teammate 派生面有,且剔除 spawn/taskboard 五件套
    assert.equal(h.tools.get('get_board'), undefined, '主链面不得有 get_board');
    assert.equal(h.tools.get('get_task'), undefined, '主链面不得有 get_task');
    const face = deriveTeammateRegistry(h.tools, h.taskboard);
    assert.ok(face.get('get_board') !== undefined, 'teammate 面应含 get_board');
    assert.ok(face.get('get_task') !== undefined, 'teammate 面应含 get_task');
    assert.equal(face.get('spawn'), undefined, 'teammate 面不得再生子代');
    assert.equal(face.get('create_task'), undefined, 'teammate 面不得碰板面写操作');
    // fork 子面剔除 send_message(L2 agent-message T3,评审附带 1):消息身份属 lead+具名 teammate,
    // fork 子面不发——缺省派生与显式 allowlist 两分支都不得透出
    assert.equal(h.runner.deriveChildRegistry({}).get('send_message'), undefined, 'fork 子面缺省派生不得含 send_message');
    assert.equal(h.runner.deriveChildRegistry({ tools: ['send_message', 'read'] }).get('send_message'), undefined, '显式 allowlist 亦恒剔除 send_message');
    // 只读板工具回执:gated 任务不派发,直接消费执行体验证摘要口径
    const created = h.taskboard.create({ title: 'A', spec: 'do A stuff', gated: true });
    assert.ok(created.ok);
    const boardOut = (await face.get('get_board')!.executor({})) as { stdout: string };
    assert.match(boardOut.stdout, /t1 \[pending\] \[gated\] A/, 'get_board 应回板摘要行');
    const taskOut = (await face.get('get_task')!.executor({ taskId: 't1' })) as { stdout: string };
    assert.match(taskOut.stdout, /id: t1/);
    assert.match(taskOut.stdout, /status: pending/);
    assert.match(taskOut.stdout, /spec: do A stuff/);
    await assert.rejects(
      face.get('get_task')!.executor({ taskId: 'zz' }),
      (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG',
      '未知 taskId 应 INVALID_ARG',
    );
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('frontmatter executor:internal-team:spawn 无 mode 也建 teammate(name=agent_id)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tm-spawn-2-'));
  let h: Harness | undefined;
  try {
    fs.mkdirSync(path.join(tmp, 'agents', 'ee'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'agents', 'ee', 'agent.md'),
      '---\nname: EE\ndescription: x\nexecutor: internal-team\n---\nYou are the reviewer.\n',
      'utf8',
    );
    const model = new ScriptedAdapter([
      JSON.stringify({ tool: 'spawn', input: { agent_id: 'ee', prompt: 'go' } }),
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true);
    const obs = r.steps.map((s) => s.observation).join('\n');
    assert.ok(obs.includes('teammate ee started'), `frontmatter 通道应建 teammate ee,实际:${obs}`);
    assert.ok(h.team.aliveNames().includes('ee'));
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mode 缺席 + 无 frontmatter executor:普通 fork 路径原样(team 零登记)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tm-spawn-3-'));
  let h: Harness | undefined;
  try {
    h = new Harness({ root: tmp, mode: 'dontAsk', model: new ScriptedAdapter([]), learnSkills: false });
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
