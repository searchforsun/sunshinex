import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { render } from './test-ink';
import { ChildPanel } from './components/ChildPanel';
import { ChildLiveState } from './session';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ---------- Phase 1 红灯：并行子代理先结束者应显完成态，不等兄弟全部归档 ---------- */

test('子代理 done 事件 → 面板置完成态（不随 done 丢弃）', () => {
  const tmp = tmpdir('sunshinex-sess-child-done1-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'token', text: '分析中…\n', payload: { subagent: 'w' } } as never);
    assert.equal(ctrl.getState().children[0]?.done, false, '运行中未完成');
    ctrl.onEventForTest({ type: 'done', text: '子任务报告', payload: { subagent: 'w', stopReason: 'done' } } as never);
    const child = ctrl.getState().children[0];
    assert.ok(child, '归档前面板仍在场');
    assert.equal(child!.done, true, 'done 事件应置完成态（当前被 default 分支丢弃 → 红灯）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ChildPanel：完成态面板显示 ✓ 完成行，不再渲染 Spinner，帧高恒 4 行', () => {
  const running = render(
    <ChildPanel childrenState={[child()]} columns={80} />,
  );
  const rf = running.lastFrame() ?? '';
  assert.ok(!rf.includes('✓'), '运行中不显完成标');
  running.unmount();

  const runningFrame = rf.replace(/\n$/, '').split('\n').length;
  const finished = render(
    <ChildPanel childrenState={[child({ done: true })]} columns={80} />,
  );
  const ff = finished.lastFrame() ?? '';
  assert.match(ff, /✓/, '完成态应显 ✓');
  assert.ok(!/✻|✽|✶|✱|✢/.test(ff), '完成态不再渲染 Spinner 动画帧');
  assert.equal(
    ff.replace(/\n$/, '').split('\n').length,
    runningFrame,
    '完成态与运行态帧高一致（恒 4 行不变量）',
  );
  finished.unmount();
});

test('并行 spawn 归档精准配对：先完成者的转录归先 spawn 调用行，不 FIFO 误摘', () => {
  const tmp = tmpdir('sunshinex-sess-child-done2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    // 两条异名并行子代理（同批并发：完成序 = 结果到达序，与调用序无关）
    ctrl.onEventForTest({ type: 'token', text: 'A 线\n', payload: { subagent: 'a' } } as never);
    ctrl.onEventForTest({ type: 'token', text: 'B 线\n', payload: { subagent: 'b' } } as never);
    // 完成序 b 先于 a（并行批真实时序），各自 tool-call/result 成对按序发射
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p2', label: 'b' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'b 完成', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p1', label: 'a' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'a 完成', payload: { tool: 'spawn', ok: true } } as never);
    const s = ctrl.getState();
    assert.equal(s.children.length, 0, '全部归档');
    const calls = s.messages.filter((m) => m.kind === 'call');
    const callB = calls[0];
    const callA = calls[1];
    assert.ok(callB!.detail?.includes('B 线'), 'b 调用行归 b 转录（当前 FIFO 兜底按列表序误摘 → 红灯）');
    assert.ok(callA!.detail?.includes('A 线'), 'a 调用行归 a 转录');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function child(over: Partial<ChildLiveState> = {}): ChildLiveState {
  return {
    label: 'w',
    startedAt: Date.now(),
    steps: 2,
    tokens: 1200,
    transcript: ['READ a.ts', '4 matches', '分析结论'],
    tail: ['READ a.ts', '4 matches', '分析结论'],
    ...over,
  } as ChildLiveState;
}
