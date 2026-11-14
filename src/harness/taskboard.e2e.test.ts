// lead 建队 → create_agent_teammate → create_agent_team_task(依赖链) → 队友认领回写 → agent_team_task_wait 拉模式唤醒。
// 板 id 不透明:自 task-created 事件捕获。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { SessionEvent } from '../types';
import { TASKBOARD_TOOL_NAMES } from './tools/taskboard-tools';

const drain = () => new Promise((r) => setImmediate(r));

async function until(pred: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return pred();
}

test('e2e:依赖链顺序执行、强制回写、task_wait 拉模式唤醒、review 闭环', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbe2e-'));
  try {
    const events: SessionEvent[] = [];
    const ids: Record<'A' | 'B', string | undefined> = { A: undefined, B: undefined };
    const onEvent = (e: SessionEvent): void => {
      events.push(e);
      if (e.type === 'task-created') {
        const p = e.payload as Record<string, unknown>;
        if (p.title === 'A') ids.A = p.taskId as string;
        if (p.title === 'B') ids.B = p.taskId as string;
      }
    };
    // 队友 Reactor 共用此模型:每任务一拍 stop 收口
    const model = {
      provider: 'openai',
      capabilities: { chat: true },
      chat: async () => ({ finish: 'stop' as const, content: 'task done', toolCalls: [] }),
    } as unknown as ModelAdapter;
    const h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false, onEvent });
    const safety = h.safety;

    const team = await h.tools.execute('create_agent_team', { name: 'alpha' }, safety);
    assert.ok(team.ok && team.value.exitCode === 0, `create_agent_team: ${JSON.stringify(team)}`);
    const teamId = h.agentTeams.list()[0]!.teamId;

    const tm = await h.tools.execute(
      'create_agent_teammate',
      { teamId, name: 'worker', prompt: 'claim board tasks and finish each', agent_id: null },
      safety,
    );
    assert.ok(tm.ok && tm.value.exitCode === 0, `create_agent_teammate: ${JSON.stringify(tm)}`);

    const ca = await h.tools.execute(
      'create_agent_team_task',
      { teamId, title: 'A', spec: 'produce A report', dependsOn: null, assignee: null, executor: null, retryOf: null },
      safety,
    );
    assert.ok(ca.ok && ca.value.exitCode === 0, `create_agent_team_task A: ${JSON.stringify(ca)}`);
    await drain();
    assert.ok(await until(() => ids.A !== undefined && h.taskboard.snapshot().tasks[ids.A!]?.status === 'success'));

    const cb = await h.tools.execute(
      'create_agent_team_task',
      { teamId, title: 'B', spec: 'produce B report', dependsOn: [ids.A!], assignee: null, executor: null, retryOf: null },
      safety,
    );
    assert.ok(cb.ok && cb.value.exitCode === 0, `create_agent_team_task B: ${JSON.stringify(cb)}`);
    await drain();
    assert.ok(await until(() => ids.B !== undefined && h.taskboard.snapshot().tasks[ids.B!]?.status === 'success'));

    assert.ok(ids.A !== undefined && ids.B !== undefined, '两任务 id 已自事件捕获');
    // 显式 id:终态幂等回执(null=仅等「当前在跑」,已全部 success 时会报 no background tasks)
    const wait = await h.tools.execute('agent_team_task_wait', { taskIds: [ids.A!, ids.B!], timeoutSeconds: 30 }, safety);
    assert.ok(wait.ok && wait.value.exitCode === 0, `agent_team_task_wait: ${JSON.stringify(wait)}`);
    assert.ok(
      wait.value.stdout.includes('all target tasks finished') || /status=success/.test(wait.value.stdout),
      `agent_team_task_wait 应回执两任务终态,实际:${wait.value.stdout.slice(0, 240)}`,
    );

    const s = h.taskboard.snapshot();
    assert.equal(s.tasks[ids.A!]!.status, 'success');
    assert.equal(s.tasks[ids.B!]!.status, 'success');

    for (const id of [ids.A!, ids.B!]) {
      assert.ok(
        events.some((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.taskId === id && (e.payload as Record<string, unknown>)?.status === 'success'),
        `task ${id} 应有回写 success 事件`,
      );
    }
    const idx = (pred: (e: SessionEvent) => boolean) => events.findIndex(pred);
    const aEnded = idx((e) => e.type === 'delegation-ended' && (e.payload as Record<string, unknown>)?.delegationId === ids.A);
    const bStarted = idx((e) => e.type === 'delegation-started' && (e.payload as Record<string, unknown>)?.delegationId === ids.B);
    assert.ok(aEnded >= 0 && bStarted > aEnded, `B 派发晚于 A 终态(${aEnded} < ${bStarted})`);
    // 队友委派:kind subagent + label=队友名(非 task id)
    const bDel = events.find((e) => e.type === 'delegation-started' && (e.payload as Record<string, unknown>)?.delegationId === ids.B);
    assert.equal((bDel!.payload as Record<string, unknown>)?.kind, 'subagent');
    assert.equal((bDel!.payload as Record<string, unknown>)?.label, 'worker');
    assert.ok(events.some((e) => e.type === 'task-created' && (e.payload as Record<string, unknown>)?.taskId === ids.A));
    assert.ok(events.some((e) => e.type === 'task-unlocked'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('e2e:lead-only 不变量——主链面持有 TASKBOARD_TOOL_NAMES,SubagentRunner 派生子面剔除', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbe2e-lead-'));
  try {
    const h = new Harness({ root: tmp, mode: 'full-access', model: new ScriptedAdapter([]), learnSkills: false });
    assert.ok(TASKBOARD_TOOL_NAMES.every((n) => h.tools.get(n) !== undefined), '主链工具面应持有 taskboard 工具');
    const fullClone = h.tools.derive({ exclude: [] });
    assert.ok(TASKBOARD_TOOL_NAMES.every((n) => fullClone.get(n) !== undefined), '全量克隆面应含 taskboard 工具');
    const child = h.runner.deriveChildRegistry();
    for (const n of TASKBOARD_TOOL_NAMES) {
      assert.ok(child.get(n) === undefined, `fork 子面不应见 ${n}`);
    }
    assert.ok(child.get('spawn') === undefined, 'fork 子面不应见 spawn');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
