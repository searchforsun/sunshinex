import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render, type TestRenderResult } from '../test-ink';
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

test('App：Ctrl+B 浏览模式（进入/Enter 全屏回看/Esc 退出，规格 §3.2）', async () => {
  const tmp = tmpdir('sunshinex-app-browse-');
  try {
    const ctrl = await settledCtrl(tmp);
    const calls = ctrl.getState().messages.filter((m) => m.kind === 'call');
    assert.ok(calls.length >= 2 && calls.every((m) => m.detail), '前置：两条 SPAWN 调用行已归档');

    const { write, lastFrame, unmount } = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />,
    );
    await new Promise((r) => setTimeout(r, 200)); // 等挂载：ink 未接管 stdin 时首段输入会丢失
    assert.doesNotMatch(lastFrame() ?? '', /subagent browse/, '缺省非浏览模式无提示行');

    write('\u0002'); // Ctrl+B 进入
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /subagent browse · ↑↓ move · Enter inspect · Esc exit/, '提示行出现');
    write('\r'); // Enter 全屏回看（光标缺省落最近一条归档行，规格 §3.2 替代原行内展开）
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /subagent view/, '全屏查看视图接管整页');
    assert.match(lastFrame() ?? '', /wr 结论/, '最近归档行转录呈现');
    write('\u001b'); // Esc 退出全屏回主界面
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(lastFrame() ?? '', /subagent view/, '退出后全屏视图消失');

    write('\u0002'); // 再进浏览
    await new Promise((r) => setTimeout(r, 150));
    write('\u001b[A'); // ↑ 移动光标到上一条归档行
    await new Promise((r) => setTimeout(r, 150));
    write('\r'); // Enter 回看上一条
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /rv 结论/, '上一条归档行转录呈现');
    write('\u001b'); // Esc 退出
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(lastFrame() ?? '', /subagent view/, '退出后全屏视图消失');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：浏览模式经整屏重绘（卸载→同 retain 重挂，生产 repaint 路径）后保留', async () => {
  // 回归：browseMode/browseCursor 曾进了 repaint effect 依赖（高亮需 Static 重放）却不在 retain 现场——
  // Ctrl+B 进入即触发卸载→重挂，重挂后浏览态整体丢失（提示行闪现即逝），真机上即「按 Ctrl+B 挂死」观感。
  // 生产同构：App 调 onRequestRepaint()（=tui-loop 的卸载），循环体以同一 retain renderOnce 重挂
  const tmp = tmpdir('sunshinex-app-browse3-');
  try {
    const ctrl = await settledCtrl(tmp);
    const retain = initialRetained();
    let current: TestRenderResult | undefined;
    const props = { controller: ctrl, banner: { version: '1.0.0', model: 'm', root: tmp }, retain, onRequestRepaint: () => current?.unmount() };
    const one = render(<App {...props} />);
    current = one;
    await new Promise((r) => setTimeout(r, 200));
    one.write('\u0002'); // Ctrl+B 进入浏览：App 的 repaint effect 将触发 onRequestRepaint → 卸载
    await new Promise((r) => setTimeout(r, 150));
    assert.match(one.lastFrame() ?? '', /subagent browse/, '前置：浏览模式已进入');
    const two = render(<App {...props} banner={props.banner} />);
    await new Promise((r) => setTimeout(r, 200));
    assert.match(two.lastFrame() ?? '', /subagent browse/, '重挂后浏览模式保留（retain 现场）');
    two.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：运行中无子代理且无归档时 Ctrl+B 不进入浏览模式', async () => {
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
