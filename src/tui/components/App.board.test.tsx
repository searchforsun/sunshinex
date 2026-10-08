import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render, type TestRenderResult } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';
import type { Result } from '../../result';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** App 集成：Ctrl+T 任务视图（P2 spec §10.3）——板投影行（id [status] ⚠ title ← deps @assignee）、
 *  ↑↓ 光标、gated 行 Enter → askUser 问题卡（approve/deny）→ 裁决映射 taskboard.review、
 *  gate-resolved 事件自更新投影、Esc 退出；board 与 browse 互斥（判定序保证，断言 board 在场方向） */
test('App：Ctrl+T 任务视图——行投影/gated ⚠/↑↓/gate 行内审批问题卡映射 review/gate-resolved 自更新/Esc 退出', async () => {
  const tmp = tmpdir('sunshinex-app-board-');
  let term: TestRenderResult | undefined;
  try {
    // 真控制器（ScriptedAdapter one-shot：本用例不提交任务，模型面不可达）
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    });
    // 板投影播种（事件口径生产同构）：t1 普通任务；t2 建即 gated（task-created + gate-waiting 两条表达，
    // TaskBoard.create({gated:true}) 的发射序镜像）+ 依赖 t1 + assignee w1
    ctrl.onEventForTest({ type: 'task-created', ts: 100, payload: { taskId: 't1', title: 'A', dependsOn: [] } } as never);
    ctrl.onEventForTest({ type: 'task-created', ts: 101, payload: { taskId: 't2', title: 'B', dependsOn: ['t1'] } } as never);
    ctrl.onEventForTest({ type: 'task-assigned', ts: 102, payload: { taskId: 't2', assignee: 'w1' } } as never);
    ctrl.onEventForTest({ type: 'gate-waiting', ts: 103, payload: { taskId: 't2' } } as never);
    // 运行中委派一行（协议补齐：合成流无 Runner，运行行由 delegation 事件入投影）——常态 ChildPanel 承载，
    // 同时使 Ctrl+B 有可进列表（互斥断言的前提：browse 可进而被判定序挡下）
    ctrl.onEventForTest({ type: 'delegation-started', ts: 104, payload: { delegationId: 'rv', kind: 'subagent', label: 'rv' } } as never);

    // review 桩：捕获裁决参数。板投影是事件喂入的，harness 任务板不识 t2（真实路径里 gate-resolved 由
    // taskboard.review 发射；此处断言 UI 裁决正确映射到 review 入参，事件回环经 onEventForTest 直喂）
    const reviewCalls: Array<{ id: string; approved: boolean }> = [];
    const board = ctrl.runtime.harness.taskboard;
    const origReview = board.review.bind(board);
    board.review = (id: string, opts: { approved: boolean; note?: string }): Result<void> => {
      reviewCalls.push({ id, approved: opts.approved });
      return origReview(id, opts);
    };

    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    const { write, lastFrame } = term;
    await new Promise((r) => setTimeout(r, 200)); // 等挂载：ink 未接管 stdin 时首段输入会丢失
    assert.match(lastFrame() ?? '', /[✻✽✶✱✢] \[rv\]/, '常态 ChildPanel 承载运行中行（五帧全集锚定）');
    assert.doesNotMatch(lastFrame() ?? '', /t1 \[pending\]/, '缺省非任务视图（板不进动态区）');

    write('\u0014'); // Ctrl+T 进入任务视图
    await new Promise((r) => setTimeout(r, 200));
    const entered = lastFrame() ?? '';
    assert.match(entered, /t1 \[pending\] A/, '任务板行进动态区：`${id} [${status}] ${label}`');
    assert.match(entered, /t2 \[pending\] ⚠ B ← t1 @w1/, 'gated ⚠ 高亮 + 依赖箭头 ← + assignee 后缀 @');
    assert.match(entered, /❯ t1/, '光标缺省落首行（id 数值序最小）');
    assert.match(entered, /review gate/, '键提示条切任务视图组（Enter=审批门）');
    assert.doesNotMatch(entered, /[✻✽✶✱✢] \[rv\]/, '任务视图在场 ChildPanel 让位（同 browse 语义；五帧全集锚定）');

    // 互斥（判定序保证，断言 board 在场方向）：Ctrl+B 有可进列表仍被吞——browse hook 整体让位
    write('\u0002'); // Ctrl+B
    await new Promise((r) => setTimeout(r, 150));
    const afterB = lastFrame() ?? '';
    assert.match(afterB, /t1 \[pending\]/, '仍在任务视图（Ctrl+B 未切走）');
    assert.doesNotMatch(afterB, /Enter inspect/, 'browse 未进入（board 在场吞键，互斥）');

    write('\u001b[B'); // ↓ 光标移到 gated 行 t2
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ t2/, '↓ 光标移到 gated 行');

    write('\r'); // Enter 于 gated 行 → gate 审批问题卡（askUser 经问询管线挂起）
    await new Promise((r) => setTimeout(r, 200));
    const card = lastFrame() ?? '';
    assert.match(card, /Approve gate on t2\?/, 'gate 审批问题卡出现');
    assert.match(card, /approve/, 'approve 选项在卡（首项=光标缺省位）');

    write('\r'); // Enter 提交首项 approve（问询卡接管键盘——board 让键给问询分支）
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(reviewCalls, [{ id: 't2', approved: true }], '裁决映射 taskboard.review(t2, approved)');
    const answered = lastFrame() ?? '';
    assert.doesNotMatch(answered, /Approve gate on/, '卡裁决后收起（回 prevStatus）');
    assert.match(answered, /❯ t2/, '板态跨审批卡存续（回板视图）');

    // gate-resolved 事件自更新投影（生产由真实 taskboard 发射；直喂同构事件断言帧面恢复可派发形态）
    ctrl.onEventForTest({ type: 'gate-resolved', ts: 200, payload: { taskId: 't2', approved: true } } as never);
    await new Promise((r) => setTimeout(r, 200));
    const resolved = lastFrame() ?? '';
    assert.match(resolved, /t2 \[pending\] B ← t1 @w1/, 'gate 解锁后行恢复 pending（无 ⚠）');
    assert.doesNotMatch(resolved, /t2 \[pending\] ⚠/, '⚠ 消失（gated 离场）');

    write('\u001b'); // Esc 退出任务视图回主界面
    await new Promise((r) => setTimeout(r, 150));
    const exited = lastFrame() ?? '';
    assert.doesNotMatch(exited, /t1 \[pending\]/, '任务视图退出');
    assert.match(exited, /[✻✽✶✱✢] \[rv\]/, 'ChildPanel 回归常态承载');

    // 前提补证：Ctrl+B 本身可用（同列表可进）——上一不进入是互斥挡下，非键坏
    write('\u0002'); // Ctrl+B 进入浏览
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /Enter inspect/, '退出任务视图后 Ctrl+B 可进浏览（互斥前提成立）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：Ctrl+T 空板也进视图——「任务板为空」提示框给真实反馈（2026-10-06 用户实机：静默吞键=不起作用观感）', async () => {
  const tmp = tmpdir('sunshinex-app-board-empty-');
  let term: TestRenderResult | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    });
    term = render(<App controller={ctrl} />);
    const { write, lastFrame } = term;
    await new Promise((r) => setTimeout(r, 150));
    // 无任何 task 事件（空板投影，真实生产形态：lead 未走 create_task 直接派 teammate）
    write('\u0014'); // Ctrl+T 进入任务视图
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /task board empty/, '空板提示框在场（非静默吞键；t() 测试环境走英文缺省）');
    write('\u001b'); // Esc 退出
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(lastFrame() ?? '', /task board empty/, 'Esc 退出空板视图');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
