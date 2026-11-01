import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render, type TestRenderResult } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** App 集成：Ctrl+T 任务视图——板投影行（符号 title ← deps @assignee）、
 *  ↑↓ 光标、Esc 退出；board 与 browse 互斥（判定序保证，断言 board 在场方向） */
test('App：Ctrl+T 任务视图——行投影/↑↓/Esc 退出，与 browse 互斥', async () => {
  const tmp = tmpdir('sunshinex-app-board-');
  let term: TestRenderResult | undefined;
  try {
    // 真控制器（ScriptedAdapter one-shot：本用例不提交任务，模型面不可达）
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    });
    // 板投影播种：t1 普通任务；t2 依赖 t1 + assignee w1
    ctrl.onEventForTest({ type: 'task-created', ts: 100, payload: { taskId: 't1', title: 'A', dependsOn: [] } } as never);
    ctrl.onEventForTest({ type: 'task-created', ts: 101, payload: { taskId: 't2', title: 'B', dependsOn: ['t1'] } } as never);
    ctrl.onEventForTest({ type: 'task-assigned', ts: 102, payload: { taskId: 't2', assignee: 'w1' } } as never);
    ctrl.onEventForTest({ type: 'delegation-started', ts: 104, payload: { delegationId: 'rv', kind: 'subagent', label: 'rv' } } as never);

    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    const { write, lastFrame } = term;
    await new Promise((r) => setTimeout(r, 200)); // 等挂载：ink 未接管 stdin 时首段输入会丢失
    assert.match(lastFrame() ?? '', /[✻✽✶✱✢] \[rv\]/, '常态 ChildPanel 承载运行中行（五帧全集锚定）');
    assert.doesNotMatch(lastFrame() ?? '', /○ A/, '缺省非任务视图（板不进动态区）');

    write('\u0014'); // Ctrl+T 进入任务视图
    await new Promise((r) => setTimeout(r, 200));
    const entered = lastFrame() ?? '';
    assert.match(entered, /○ A/, '任务板行进动态区：`<符号> ${label}`（符号制,boardRows 单点映射;id 不上屏）');
    assert.match(entered, /○ B ← t1 @w1/, '依赖箭头 ← + 指派后缀 @');
    assert.match(entered, /❯ ○/, '光标缺省落首行（id 数值序最小）');
    assert.doesNotMatch(entered, /[✻✽✶✱✢] \[rv\]/, '任务视图在场 ChildPanel 让位（同 browse 语义；五帧全集锚定）');

    // 互斥（判定序保证，断言 board 在场方向）：Ctrl+B 有可进列表仍被吞——browse hook 整体让位
    write('\u0002'); // Ctrl+B
    await new Promise((r) => setTimeout(r, 150));
    const afterB = lastFrame() ?? '';
    assert.match(afterB, /○ A/, '仍在任务视图（Ctrl+B 未切走）');
    assert.doesNotMatch(afterB, /Enter inspect/, 'browse 未进入（board 在场吞键，互斥）');

    write('\u001b[B'); // ↓ 光标移到第二行
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ ○ B/, '↓ 光标移到第二行');

    write('\u001b'); // Esc 退出任务视图回主界面
    await new Promise((r) => setTimeout(r, 150));
    const exited = lastFrame() ?? '';
    assert.doesNotMatch(exited, /○ A/, '任务视图退出');
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
    // 无任何 task 事件（空板投影，真实生产形态：lead 未走 create_agent_team_task 直接派 teammate）
    write('\u0014'); // Ctrl+T 进入任务视图
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /agent teams empty/, '空板提示框在场（非静默吞键；t() 测试环境走英文缺省）');
    write('\u001b'); // Esc 退出
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(lastFrame() ?? '', /agent teams empty/, 'Esc 退出空板视图');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('browseRows：闲置 teammate 行(跑完后 Ctrl+B 仍可浏览,2026-10-06 用户实机静默修复)——与运行中委派行去重', async () => {
  const { browseRows } = await import('./use-browse-keys');
  const st = {
    delegations: [
      { id: 'task-t1', kind: 'subagent', label: 'w1', title: '干活中', status: 'running', startedAt: 1 },
    ],
    children: [
      { label: 'w1', startedAt: 1, transcript: [] },   // 工作中:委派行已承载,不双显
      { label: 'w2', startedAt: 2, transcript: [] },   // 闲置:无委派行 → 补行
      { label: 'fork1', startedAt: 3, done: true, transcript: [] }, // 已归档 fork:走 SPAWN 归档段
    ],
    messages: [],
  } as never;
  const rows = browseRows(st);
  assert.deepEqual(rows.map((r) => r.label), ['w1 · 干活中', 'w2'], '工作中带任务后缀;闲置 teammate 补行;done 不列');
  assert.deepEqual(rows.map((r) => r.childLabel), ['w1', 'w2'], 'child join 键=委派原名(全屏视图按名 join 转录,2026-10-09 修空白病根)');
});

test('App：Ctrl+B → Enter 进 team 子智能体全屏视图——委派行展示带任务后缀、child 按原名 join（2026-10-09 修「team 子智能体视图整页空白」）', async () => {
  const tmp = tmpdir('sunshinex-app-browse-team-inspect-');
  let term: TestRenderResult | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    });
    // 运行中 team 委派行（label=w1 + 任务 title，「名 · 任务」展示形态，teammate.execute 生产同构）
    // + 同名 child 转录（payload.subagent 打标复用 ChildPanel 通道）
    ctrl.onEventForTest({ type: 'delegation-started', ts: Date.now(), payload: { delegationId: 'task-t1', kind: 'subagent', label: 'w1', title: '元数据分析' } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'read', payload: { subagent: 'w1', input: { path: 'a.md' } } } as never);

    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    const { write, lastFrame, allOutput } = term;
    await new Promise((r) => setTimeout(r, 200)); // 等挂载
    write('\u0002'); // Ctrl+B 进入浏览（唯一行=运行中委派行,光标落 0）
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /w1 · 元数据分析/, '浏览行显「名 · 任务」拼接形态');
    write('\r'); // Enter → 全屏实时视图（child join 键须为原名 w1）
    await new Promise((r) => setTimeout(r, 150));
    const frame = lastFrame() ?? '';
    assert.match(frame, /\[w1\] subagent/, '头部 label=原名 w1（病根形态是 `[] subagent view` 空白整页）');
    assert.doesNotMatch(frame, /\[\] subagent/, '不再出现空 label 全屏视图');
    assert.match(allOutput(), /\[READ\] a\.md/, '转录按原名 join 呈现（Static 时间线入滚动缓冲,allOutput 断言）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
