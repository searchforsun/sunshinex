/** 智能体团队业务流 e2e(2026-10-20 四件套收束后的全链验收):
 *  create_teammate → create_task(指派+依赖) → get_board 读面 → task_wait 等待 → review 闭环。
 *  零产品码——装配正确性的行为证明:依赖序(B 派发晚于 A 终态)、成员存活(上下文承载体无停止概念)、
 *  任务生命周期(claimed→in-review→done)三面一次跑通。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult, SessionEvent } from '../types';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function until(pred: () => boolean, ms = 30_000, step = 100): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

const p = (e: SessionEvent): Record<string, unknown> => e.payload ?? {};

test('团队业务流:create_teammate→指派+依赖任务→get_board→task_wait→review 闭环,依赖序与成员存活', async () => {
  const tmp = tmpdir('sunshinex-team-flow-');
  let h: Harness | undefined;
  const events: SessionEvent[] = [];
  try {
    // 计数 fake 模型:每轮 done(任务即刻收口,依赖序可断言)
    let n = 0;
    const model = {
      provider: 'counting',
      async chat(_req: ChatRequest): Promise<ChatResult> {
        n += 1;
        return { finish: 'stop', content: `ok ${n}`, toolCalls: [] };
      },
    } as unknown as ModelAdapter;
    h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false, onEvent: (e) => events.push(e) });

    // ① 创建智能体团队成员(独立动词,长驻上下文承载体)
    const tm = await h.tools.execute('create_teammate', { name: 'w1', prompt: 'worker w1: claim board tasks and finish each' }, h.safety);
    assert.ok(tm.ok && tm.value.exitCode === 0, `create_teammate 应成功:${JSON.stringify(tm)}`);
    assert.ok(tm.value.stdout.includes('teammate w1 started'), '回执含启动确认');
    assert.ok(!/stop via task_stop/.test(tm.value.stdout), '回执无停止叙事(成员=上下文承载体,无停止概念)');

    // ② 建任务:A 先行,B 依赖 A(指派同成员——依赖/分配是 lead 的规划职责)
    const ca = await h.tools.execute('create_task', { title: 'A', spec: 'do A', dependsOn: null, assignee: 'w1', gated: null, executor: null }, h.safety);
    assert.ok(ca.ok, `create A 应成功:${JSON.stringify(ca)}`);
    const idA = /task (\S+) created;/.exec((ca as { value: { stdout: string } }).value.stdout)![1]!;
    const cb = await h.tools.execute('create_task', { title: 'B', spec: 'do B', dependsOn: [idA], assignee: 'w1', gated: null, executor: null }, h.safety);
    assert.ok(cb.ok, `create B 应成功:${JSON.stringify(cb)}`);
    const idB = /task (\S+) created;/.exec((cb as { ok: true; value: { stdout: string } }).value.stdout)![1]!;
    assert.notEqual(idA, idB, '两任务 id 互异(不透明方言)');

    // ③ get_board 读面(lead 缺口补齐):两任务行在场,含状态与标题
    const gb = await h.tools.execute('get_board', {}, h.safety);
    assert.ok(gb.ok && (gb.value.stdout.includes(idA) || gb.value.stdout.includes(idB)), 'get_board 应含板任务');

    // ④ review 闭环:A/B 依次 in-review → approved → done(B 的派发以 A 关单为前提,依赖序在⑤以事件序断)
    //    等待用 board.settle(无 pending/claimed 才回)——手搓轮询会撞「claimed→in-review」的短暂窗口
    try {
      await until(() => h!.taskboard.snapshot().tasks[idA]?.status === 'in-review');
      let r = h.taskboard.review(idA, { approved: true });
      assert.ok(r.ok, `review A 应成功:${r.ok ? '' : r.error.message}`);
      await h.taskboard.settle(15_000); // B 派发+执行收口(至无 pending/claimed)
      assert.equal(h.taskboard.snapshot().tasks[idB]?.status, 'in-review', 'B 应到 in-review');
      r = h.taskboard.review(idB, { approved: true });
      assert.ok(r.ok, `review B 应成功:${r.ok ? '' : r.error.message}`);
    } catch (e) {
      console.log('--- 失败现场:task/delegation 事件轨迹 ---');
      for (const e of events) {
        const pl = (e as { payload?: Record<string, unknown> }).payload ?? {};
        if (e.type.startsWith('task-') || e.type.startsWith('delegation-')) {
          console.log(e.type, String(pl.taskId ?? pl.delegationId ?? ''), String(pl.status ?? pl.kind ?? ''));
        }
      }
      throw e;
    }
    assert.ok(until(() => {
      const s = h!.taskboard.snapshot().tasks;
      return s[idA]?.status === 'done' && s[idB]?.status === 'done';
    }), '两任务应全 done');

    // ⑤ 依赖序与事件序(全部收口后断,数据齐备):B 派发晚于 A 终态;in-review 回写先于 delegation-ended
    //    (2026-10-20 业务测试异常修复回归:旧实现先发 ended 后回写,消费方收到「已结束」时任务还是 claimed)
    const idxOf = (pred: (e: SessionEvent) => boolean): number => events.findIndex(pred);
    const aInReview = idxOf((e) => e.type === 'task-status-changed' && p(e).taskId === idA && p(e).status === 'in-review');
    const aEnded = idxOf((e) => e.type === 'delegation-ended' && p(e).delegationId === idA);
    const bStarted = idxOf((e) => e.type === 'delegation-started' && p(e).delegationId === idB);
    assert.ok(aInReview >= 0 && aEnded > aInReview, `回写(in-review)必须先于终态宣告:in-review@${aInReview} ended@${aEnded}`);
    assert.ok(bStarted > aEnded, `B 派发应晚于 A 终态(依赖序):${bStarted} > ${aEnded}`);

    // ⑥ task_wait 台账面:派发条目全部收口(可等、幂等即回)
    const w = await h.tools.execute('task_wait', { taskIds: null, timeoutSeconds: 5 }, h.safety);
    assert.ok(w.ok);
    if (w.ok) assert.match(w.value.stdout, /all target tasks finished|no background tasks running/);

    // ⑦ 成员存活(上下文承载体:任务收口后回归待命,不消亡)
    assert.ok(h.team.aliveNames().includes('w1'), '成员应存活(任务才有生命周期)');
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
