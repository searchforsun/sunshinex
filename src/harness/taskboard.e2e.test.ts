// lead 建队建任务+依赖 → 自动派发(fork)→ 回写 success → task_wait(null) 拉模式唤醒。
//
// 卡序:create_team → create_task A → fork A done(派发发生在 create_task 执行器内)→
// create_task B(A 已 success 才派发)→ fork B 耗时 exec → 主链 task_wait → fork B done → 主链收尾。
// 板 id 不透明:卡 thunk 在消费时刻读 task-created 事件里的真实 id。
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

test('e2e:依赖链顺序执行、强制回写、task_wait 拉模式唤醒、review 闭环', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbe2e-'));
  try {
    // id 捕获:task-created 事件在建任务执行器内同步发射,后续卡的Thunk即可读真实板 id 装配依赖/裁决
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
    // 消费顺序见文件头。fork 牌夹在主链派发牌与下一张主链牌之间。
    const tc = (step: number, tool: string, input: unknown) => ({
      finish: 'tool_calls' as const,
      content: '',
      toolCalls: [{ id: `call_${step}`, name: tool, argsJson: JSON.stringify(input) }],
    });
    const doneCard = (reply: string) => ({ finish: 'stop' as const, content: reply, toolCalls: [] });
    let h: Harness;
    const taskInput = (title: string, spec: string, dependsOn: string[] | null) => ({
      teamId: h.agentTeams.list()[0]!.teamId,
      title,
      spec,
      dependsOn,
      assignee: null,
      executor: null,
      retryOf: null,
    });
    const cards: Array<() => ReturnType<typeof tc> | ReturnType<typeof doneCard>> = [
      () => tc(0, 'create_team', { name: 'alpha' }),
      () => tc(1, 'create_task', taskInput('A', 'produce A report', null)),
      () => doneCard('A report done'),
      () => tc(2, 'create_task', taskInput('B', 'produce B report', [ids.A!])),
      () => tc(3, 'exec', { command: 'node -e "setTimeout(()=>{},400)"', background: null }),
      () => tc(4, 'task_wait', { taskIds: null, timeoutSeconds: 30 }),
      () => doneCard('B report done'),
      () => doneCard('board closed'),
    ];
    let step = 0;
    const model = {
      provider: 'openai',
      capabilities: { chat: true },
      chat: async () => cards[step++]!(),
    } as unknown as ModelAdapter;
    h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false, onEvent });
    const r = await h.reactor.run({ goal: '完成板上任务并收尾' }, { maxSteps: 12 });
    assert.equal(r.done, true);
    assert.equal(r.reply, 'board closed');
    assert.ok(ids.A !== undefined && ids.B !== undefined, '两任务 id 已自事件捕获');
    const s = h.taskboard.snapshot();
    assert.equal(s.tasks[ids.A!]!.status, 'success');
    assert.equal(s.tasks[ids.B!]!.status, 'success');
    // 拉模式唤醒:主链 task_wait 真实阻塞后被 B 台账终态唤醒(回执为「全部完成」而非「无在跑任务」)
    assert.ok(
      r.steps.some((st) => st.observation.includes('all target tasks finished')),
      `task_wait 应以「全部完成」回执唤醒,实际步骤观察:${r.steps.map((st) => st.observation.slice(0, 80)).join(' | ')}`,
    );
    // 终态回写:success 事件在场
    for (const id of [ids.A!, ids.B!]) {
      assert.ok(
        events.some((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.taskId === id && (e.payload as Record<string, unknown>)?.status === 'success'),
        `task ${id} 应有回写 success 事件`,
      );
    }
    // 执行顺序:B 的委派事件必在 A 终态之后
    const idx = (pred: (e: SessionEvent) => boolean) => events.findIndex(pred);
    const aEnded = idx((e) => e.type === 'delegation-ended' && (e.payload as Record<string, unknown>)?.delegationId === ids.A);
    const bStarted = idx((e) => e.type === 'delegation-started' && (e.payload as Record<string, unknown>)?.delegationId === ids.B);
    assert.ok(aEnded >= 0 && bStarted > aEnded, `B 派发晚于 A 终态(${aEnded} < ${bStarted})`);
    // 委派载荷口径:kind 'subagent' + label=委派标签(dispatchTag(板 id),task_wait 可按板 id 归一命中)
    const bDel = events.find((e) => e.type === 'delegation-started' && (e.payload as Record<string, unknown>)?.delegationId === ids.B);
    assert.equal((bDel!.payload as Record<string, unknown>)?.kind, 'subagent');
    assert.equal((bDel!.payload as Record<string, unknown>)?.label, ids.B);
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
    const child = h.runner.deriveChildRegistry({});
    for (const n of TASKBOARD_TOOL_NAMES) {
      assert.ok(child.get(n) === undefined, `fork 子面不应见 ${n}`);
    }
    assert.ok(child.get('spawn') === undefined, 'fork 子面不应见 spawn');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
