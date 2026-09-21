import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { initialRetained } from '../ui-state';
import { ScriptedAdapter } from '../../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 终态会话：两条已归档 SPAWN 调用行（detail 含转录） */
async function settledCtrl(tmp: string): Promise<SessionController> {
  const ctrl = new SessionController({
    root: tmp,
    model: new ScriptedAdapter([
      '{"tools":[{"tool":"spawn","input":{"prompt":"a","label":"rv"}},{"tool":"spawn","input":{"prompt":"b","label":"wr"}}],"done":false}',
      '{"done":true,"reply":"ok"}',
    ]),
  });
  // 子代理事件流经测试接缝注入（先于主链 tool-result 归档锚点），确保归档命中并携带 detail
  ctrl.onEventForTest({ type: 'token', text: 'rv 线\n', payload: { subagent: 'rv' } } as never);
  ctrl.onEventForTest({ type: 'done', text: 'rv 结论', payload: { subagent: 'rv' } } as never);
  ctrl.onEventForTest({ type: 'token', text: 'wr 线\n', payload: { subagent: 'wr' } } as never);
  ctrl.onEventForTest({ type: 'done', text: 'wr 结论', payload: { subagent: 'wr' } } as never);
  const p = ctrl.submit('跑两个子代理');
  await p;
  await ctrl.waitIdle();
  return ctrl;
}

test('App：Ctrl+B 浏览模式（进入/Enter 展开/Esc 退出）', async () => {
  const tmp = tmpdir('sunshinex-app-browse-');
  try {
    const ctrl = await settledCtrl(tmp);
    const calls = ctrl.getState().messages.filter((m) => m.kind === 'call');
    assert.ok(calls.length >= 2 && calls.every((m) => m.detail), '前置：两条 SPAWN 调用行已归档');

    const spawnSeqs = calls.map((m) => m.seq);
    const retain = { ...initialRetained() };
    const repaints: number[] = [];
    const { write, lastFrame, unmount } = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} retain={retain} onRequestRepaint={() => repaints.push(repaints.length + 1)} />,
    );
    await new Promise((r) => setTimeout(r, 200)); // 等挂载：ink 未接管 stdin 时首段输入会丢失
    assert.doesNotMatch(lastFrame() ?? '', /subagent browse/, '缺省非浏览模式无提示行');

    write('\u0002'); // Ctrl+B 进入
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /subagent browse · ↑↓ move · Enter toggle · Esc exit/, '提示行出现');
    assert.equal(repaints.length, 1, '进入浏览模式触发整屏重绘请求');
    write('\r'); // Enter 翻转展开（光标缺省落最近一条）
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(retain.spawnExpanded, [spawnSeqs[spawnSeqs.length - 1]], '最近一条入展开集合');
    assert.equal(repaints.length, 2, '展开集合变更触发重绘（Static 重放通道）');

    write('\u001b[A'); // ↑ 移动光标到上一条 SPAWN 行
    await new Promise((r) => setTimeout(r, 150));
    write('\r'); // 翻转上一条
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(retain.spawnExpanded, [spawnSeqs[spawnSeqs.length - 1], spawnSeqs[0]], '上一条也入展开集合');

    // 边界钳制：光标已在末行，↓ 不移动（钳制），Enter 仍作用于末行 → 末行由展开转折叠
    write('\u001b[B');
    await new Promise((r) => setTimeout(r, 150));
    write('\r');
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(retain.spawnExpanded, [spawnSeqs[0]], '末行 ↓ 钳制不移动，Enter 收拢末行');

    write('\u001b'); // Esc 退出
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(lastFrame() ?? '', /subagent browse/, '退出后提示行消失');
    unmount();

    // Static 不可变：展开态经卸载→重挂整屏重放（与 Tab 同路径），重放帧应含 ▾ 头行与转录
    const replay = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} retain={retain} />,
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.match(replay.allOutput(), /▾ \[SPAWN\]/, '重挂重放保留逐行展开态');
    assert.match(replay.allOutput(), /rv 结论/, '命中行转录重放');
    replay.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：运行中 Ctrl+B 不进入浏览模式', async () => {
  const tmp = tmpdir('sunshinex-app-browse2-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"sleep 1"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    const p = ctrl.submit('长任务');
    await new Promise((r) => setTimeout(r, 120)); // 等进入 running
    assert.equal(ctrl.getState().status, 'running');
    const { write, lastFrame, unmount } = render(<App controller={ctrl} />);
    await new Promise((r) => setTimeout(r, 200));
    write('\u0002');
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(lastFrame() ?? '', /subagent browse/, '运行中不进入');
    await p;
    await ctrl.waitIdle();
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
