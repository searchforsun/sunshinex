// P1 端到端验收(spec §13):lead 建任务+依赖 → 自动派发(fork 顶替)→ harness 强制回写 →
// task_wait(null) 拉模式唤醒 → review 裁决闭环。零产品码——装配正确性的行为证明。
//
// ScriptedAdapter 消费序确定性依据(装配时序实测口径,位序按此排布):
// 1) fork 的首次模型调用发生在派发触发的工具执行器内(create_task/review_task 的 executor 里,
//    board.kick → drain → runSubagent → child.run → chat 同步链)——即必然夹在主链「派发牌」与
//    「下一张牌」两个模型位之间,与微任务跳数无关(主链 runBatch 不完不进下一轮);
// 2) dispatchable 要求依赖全 done(model.ts):t2 只在 review 关单 t1 之后才派发——
//    主链 review_task(t1) 的执行器内同步派发 t2,fork B 的首张牌紧随其后;
// 3) 主链阻塞在 task_wait 工具执行器内时不发起模型调用,fork B 的第二张牌(done)独占脚本队列;
//    fork B 的首张牌是带真实耗时的 exec(node setTimeout 400ms),保证主链 task_wait(null) 快照时
//    task-t2 台账尚在 running(拉模式等待真实发生,而非空回执即回)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { ScriptedAdapter } from '../model/adapter';
import { SessionEvent } from '../types';
import { TASKBOARD_TOOL_NAMES } from './tools/taskboard-tools';

test('e2e:依赖链 t1→t2 顺序执行、强制回写、task_wait 拉模式唤醒、review 闭环', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbe2e-'));
  try {
    // 数组位序(消费顺序):0 主链建 t1 → [1] fork A 出报告(done 单张牌,微任务链在主链下一张牌前收口:
    // 回写 in-review + 台账 finish)→ 2 主链建 t2(依赖 t1,此时未派发)→ 3 主链裁决 t1(执行器内同步
    // 派发 t2)→ [4] fork B 真实耗时 exec → 5 主链 task_wait(null) 阻塞等待 task-t2 台账 →
    // [6] fork B done(主链阻塞期间独占队列)→ 7 主链裁决 t2 → 8 主链收尾。
    const model = new ScriptedAdapter([
      JSON.stringify({ tool: 'create_task', input: { title: 'A', spec: 'produce A report', dependsOn: null, assignee: null } }),
      JSON.stringify({ done: true, reply: 'A report done' }),
      JSON.stringify({ tool: 'create_task', input: { title: 'B', spec: 'produce B report', dependsOn: ['t1'], assignee: null } }),
      JSON.stringify({ tool: 'review_task', input: { taskId: 't1', approved: true, note: null } }),
      JSON.stringify({ tool: 'exec', input: { command: 'node -e "setTimeout(()=>{},400)"', background: null } }),
      JSON.stringify({ tool: 'task_wait', input: { taskIds: null, timeoutSeconds: 30 } }),
      JSON.stringify({ done: true, reply: 'B report done' }),
      JSON.stringify({ tool: 'review_task', input: { taskId: 't2', approved: true, note: null } }),
      JSON.stringify({ done: true, reply: 'board closed' }),
    ]);
    const events: SessionEvent[] = [];
    const h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false, onEvent: (e) => events.push(e) });
    const r = await h.reactor.run({ goal: '完成板上任务并收尾' }, { maxSteps: 12 });
    assert.equal(r.done, true);
    assert.equal(r.reply, 'board closed');
    const s = h.taskboard.snapshot();
    assert.equal(s.tasks['t1']!.status, 'done');
    assert.equal(s.tasks['t2']!.status, 'done');
    // 拉模式唤醒:主链 task_wait 真实阻塞后被 task-t2 台账终态唤醒(回执为「全部完成」而非「无在跑任务」)
    assert.ok(
      r.steps.some((st) => st.observation.includes('all target tasks finished')),
      `task_wait 应以「全部完成」回执唤醒,实际步骤观察:${r.steps.map((st) => st.observation.slice(0, 80)).join(' | ')}`,
    );
    // 强制回写(§5.4):claimed → in-review 的事件证据(不依赖模型自觉)
    for (const id of ['t1', 't2']) {
      assert.ok(
        events.some((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.taskId === id && (e.payload as Record<string, unknown>)?.status === 'in-review'),
        `task ${id} 应有强制回写 claimed→in-review 事件`,
      );
    }
    // 执行顺序:t2 的委派事件必在 t1 终态之后
    const idx = (pred: (e: SessionEvent) => boolean) => events.findIndex(pred);
    const t1Ended = idx((e) => e.type === 'delegation-ended' && (e.payload as Record<string, unknown>)?.delegationId === 'task-t1');
    const t2Started = idx((e) => e.type === 'delegation-started' && (e.payload as Record<string, unknown>)?.delegationId === 'task-t2');
    assert.ok(t1Ended >= 0 && t2Started > t1Ended, `t2 派发晚于 t1 终态(${t1Ended} < ${t2Started})`);
    // 委派载荷口径:kind 'subagent' + label task-<id>(task_wait(null) 可等的台账登记形态)
    const t2Del = events.find((e) => e.type === 'delegation-started' && (e.payload as Record<string, unknown>)?.delegationId === 'task-t2');
    assert.equal((t2Del!.payload as Record<string, unknown>)?.kind, 'subagent');
    assert.equal((t2Del!.payload as Record<string, unknown>)?.label, 'task-t2');
    assert.ok(events.some((e) => e.type === 'task-created' && (e.payload as Record<string, unknown>)?.taskId === 't1'));
    assert.ok(events.some((e) => e.type === 'task-unlocked'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('e2e:lead-only 不变量——主链面五件套在场,SubagentRunner 派生子面剔除', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbe2e-lead-'));
  try {
    const h = new Harness({ root: tmp, mode: 'dontAsk', model: new ScriptedAdapter([]), learnSkills: false });
    // 主链注册面与全量克隆面均持有五件套
    assert.ok(TASKBOARD_TOOL_NAMES.every((n) => h.tools.get(n) !== undefined), '主链工具面应持有 taskboard 五件套');
    const fullClone = h.tools.derive({ exclude: [] });
    assert.ok(TASKBOARD_TOOL_NAMES.every((n) => fullClone.get(n) !== undefined), '全量克隆面应含 taskboard 五件套');
    // harness 装配的同一 registry 经 SubagentRunner 派生子面(fork 工具面)剔除五件套 + spawn(既有不变量顺带钉)
    const child = h.runner.deriveChildRegistry({});
    for (const n of TASKBOARD_TOOL_NAMES) {
      assert.ok(child.get(n) === undefined, `fork 子面不应见 ${n}`);
    }
    assert.ok(child.get('spawn') === undefined, 'fork 子面不应见 spawn');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
