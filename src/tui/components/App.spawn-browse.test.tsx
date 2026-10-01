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

test('App：全屏态段锚点自动重绘跳过（2026-09-28 用户裁决：持续闪屏与吞 Esc 同根因，拆挂只许 Tab/Ctrl+O/进出全屏触发）', async () => {
  const tmp = tmpdir('sunshinex-app-repaint-');
  let term: TestRenderResult | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tools":[{"tool":"spawn","input":{"prompt":"a","label":"rv"}}],"done":false}',
        '{"done":true,"reply":"ok"}',
        '{"tool":"read","input":{"path":"SUNSHINE.md"},"done":false}',
        '{"done":true,"reply":"追问完成"}',
      ]),
    });
    ctrl.onEventForTest({ type: 'token', text: 'rv 线\n', payload: { subagent: 'rv' } } as never);
    ctrl.onEventForTest({ type: 'done', text: 'rv 结论', payload: { subagent: 'rv' } } as never);
    const p = ctrl.submit('跑一个子代理');
    await p;
    await ctrl.waitIdle();
    const repaints: number[] = [];
    const retain = initialRetained();
    let current: TestRenderResult | undefined;
    // 真卸载通道（生产语义）：请求重绘即卸载当前实例，测试手动以同 retain 重挂（帧面状态经重挂生效）
    const repaint = (): void => {
      repaints.push(repaints.length + 1);
      current?.unmount();
    };
    const mount = (): TestRenderResult => {
      const mounted = render(
        <App
          controller={ctrl}
          banner={{ version: '1.0.0', model: 'm', root: tmp }}
          retain={retain}
          onRequestRepaint={repaint}
        />,
      );
      current = mounted;
      return mounted;
    };
    term = mount();
    await new Promise((r) => setTimeout(r, 200));
    term.write('\u0002'); // Ctrl+B
    await new Promise((r) => setTimeout(r, 150));
    term.write('\r'); // Enter → 全屏回看（store 先写 + 请求重绘 + 卸载；进入恰 1 次重绘）
    await new Promise((r) => setTimeout(r, 200));
    const two = mount();
    term = two;
    await new Promise((r) => setTimeout(r, 200));
    assert.match(two.lastFrame() ?? '', /subagent view/, '前置：全屏视图在场');
    assert.equal(repaints.length, 1, '前置：进入全屏恰一次重绘');
    // 全屏期间主链再跑一轮带工具行的回合：段锚点落定不得触发整屏重绘（拆挂即闪屏 + 吞 Esc 空窗）
    void ctrl.submit('追问');
    await ctrl.waitIdle();
    await new Promise((r) => setTimeout(r, 900)); // 越过 400ms 段锚点防抖
    assert.equal(repaints.length, 1, '全屏态段锚点落定零整屏重绘');
    two.write('\u001b'); // Esc 退出全屏（store 先写 + 请求重绘 + 卸载）
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(repaints.length, 2, 'Esc 退出恰请求一次整屏重绘');
    current = undefined;
    const back = mount();
    term = back;
    await new Promise((r) => setTimeout(r, 200));
    assert.doesNotMatch(back.lastFrame() ?? '', /subagent view/, '重挂后全屏视图退出（retain.inspect 已清）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：Ctrl+B 浏览模式（进入/Enter 全屏回看/Esc 退出，规格 §3.2）', async () => {
  const tmp = tmpdir('sunshinex-app-browse-');
  // unmount 必须进 finally：App 内 Spinner/useSpinFrame 是自持 240ms interval，断言中途抛出跳过卸载
  // 会吊住测试进程事件循环——node --test 永等该文件，整套门禁挂死（2026-09-30 release 门禁即此形态）
  let term: TestRenderResult | undefined;
  try {
    const ctrl = await settledCtrl(tmp);
    const calls = ctrl.getState().messages.filter((m) => m.kind === 'call');
    assert.ok(calls.length >= 2 && calls.every((m) => m.detail), '前置：两条 SPAWN 调用行已归档');

    term = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />,
    );
    const { write, lastFrame, allOutput } = term;
    await new Promise((r) => setTimeout(r, 200)); // 等挂载：ink 未接管 stdin 时首段输入会丢失
    assert.doesNotMatch(lastFrame() ?? '', /subagent browse/, '缺省非浏览模式无提示行');

    write('\u0002'); // Ctrl+B 进入
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /⌨ ↑↓ move · Enter inspect · Esc exit/, '浏览键提示条出现（KeyHints emphasized 承载）');
    assert.match(lastFrame() ?? '', /❯ \[wr\]/, '浏览列表在动态区呈现已完成项（光标缺省落最近一条）');
    write('\r'); // Enter 全屏回看（光标缺省落最近一条归档行，规格 §3.2 替代原行内展开）
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /subagent view/, '全屏查看视图接管整页');
    // 归档 detail 精简形态（2026-09-28 用户裁决：输入+结论+统计）；结论取子代理真实终稿（注入事件先于真实 done 到达被覆盖），
    // 2026-09-29 Static 时间线化：统计行随 detail 进滚动缓冲（allOutput 口径），动态帧只余状态行
    // 状态行标签锚定不钉字形：头行 glyph 自 3441fb8 起为 useSpinFrame 帧动画（✻✽✶✱✢ 轮转），断言时刻落在哪一帧不 确定
    assert.match(lastFrame() ?? '', /\[wr\] subagent view/, '最近归档行全屏视图（状态行标签锚定）');
    assert.match(allOutput(), /steps · /, '精简 detail 统计行在位（Static 滚动缓冲）');
    write('\u001b'); // Esc 退出全屏回主界面
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(lastFrame() ?? '', /subagent view/, '退出后全屏视图消失');

    write('\u0002'); // 再进浏览
    await new Promise((r) => setTimeout(r, 300));
    write('\u001b[A'); // ↑ 移动光标到上一条归档行（零 repaint：摘要行动态区每帧自绘，可见移动）
    await new Promise((r) => setTimeout(r, 300));
    assert.match(lastFrame() ?? '', /❯ \[rv\]/, '↑ 后光标切到上一条已完成项（委派时间序）');
    write('\r'); // Enter 回看上一条
    await new Promise((r) => setTimeout(r, 300));
    assert.match(lastFrame() ?? '', /\[rv\] subagent view/, '上一条归档行全屏视图（标签锚定，不钉动画帧字形）');
    write('\u001b'); // Esc 退出
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(lastFrame() ?? '', /subagent view/, '退出后全屏视图消失');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：浏览模式经整屏重绘（卸载→同 retain 重挂，生产 repaint 路径）后保留', async () => {
  // 回归：browseMode/browseCursor 曾进了 repaint effect 依赖（高亮需 Static 重放）却不在 retain 现场——
  // Ctrl+B 进入即触发卸载→重挂，重挂后浏览态整体丢失（提示行闪现即逝），真机上即「按 Ctrl+B 挂死」观感。
  // 生产同构：App 调 onRequestRepaint()（=tui-loop 的卸载），循环体以同一 retain renderOnce 重挂
  const tmp = tmpdir('sunshinex-app-browse3-');
  let current: TestRenderResult | undefined;
  try {
    const ctrl = await settledCtrl(tmp);
    const retain = initialRetained();
    const props = { controller: ctrl, banner: { version: '1.0.0', model: 'm', root: tmp }, retain, onRequestRepaint: () => current?.unmount() };
    const one = render(<App {...props} />);
    current = one;
    await new Promise((r) => setTimeout(r, 200));
    one.write('\u0002'); // Ctrl+B 进入浏览：App 的 repaint effect 将触发 onRequestRepaint → 卸载
    await new Promise((r) => setTimeout(r, 150));
    assert.match(one.lastFrame() ?? '', /Enter inspect/, '前置：浏览模式已进入');
    const two = render(<App {...props} banner={props.banner} />);
    current = two;
    await new Promise((r) => setTimeout(r, 200));
    assert.match(two.lastFrame() ?? '', /Enter inspect/, '重挂后浏览模式保留（retain 现场）');
  } finally {
    current?.unmount();
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
    let term: TestRenderResult | undefined;
    try {
      await new Promise((r) => setTimeout(r, 120)); // 等进入 running
      assert.equal(ctrl.getState().status, 'running');
      term = render(<App controller={ctrl} />);
      const { write, lastFrame } = term;
      await new Promise((r) => setTimeout(r, 200));
      write('\u0002');
      await new Promise((r) => setTimeout(r, 150));
      assert.doesNotMatch(lastFrame() ?? '', /Enter inspect/, '运行中不进入');
      await p;
      await ctrl.waitIdle();
    } finally {
      term?.unmount();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 回归（2026-09-26 真机症状）：Enter 选中运行中子代理进全屏后闪一下屏回主界面——
// inspect 是本地 state 不在 retain 现场，Enter 同时 setBrowse(false) 触发整屏重挂，重挂即丢 inspect。
// 生产同构：onRequestRepaint（=tui-loop 卸载）→ 同 retain renderOnce 重挂，全屏态须跨重挂保留
test('App：全屏查看（inspect）经整屏重绘（卸载→同 retain 重挂）后保留', async () => {
  const tmp = tmpdir('sunshinex-app-inspect-retain-');
  let current: TestRenderResult | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"spawn","input":{"prompt":"a","label":"rv"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    // 已完成 spawn 造档（结果先行 → 子事件 → done 归档，detail 在位）：浏览序列只承载已完成项（2026-09-28 统一口径）
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'a', label: 'rv' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'token', text: 'rv 线\n', payload: { subagent: 'rv' } } as never);
    ctrl.onEventForTest({ type: 'done', text: 'rv 结论', payload: { subagent: 'rv' } } as never);
    const retain = initialRetained();
    const props = { controller: ctrl, banner: { version: '1.0.0', model: 'm', root: tmp }, retain, onRequestRepaint: () => current?.unmount() };
    const one = render(<App {...props} />);
    current = one;
    await new Promise((r) => setTimeout(r, 200));
    one.write('\u0002'); // Ctrl+B 进入浏览（已完成列表在位）；browseMode 变更触发 repaint effect → 本实例被卸载
    await new Promise((r) => setTimeout(r, 150));
    // 卸载后以同 retain 重挂（tui-loop 循环体），浏览态经 retain 保留
    const two = render(<App {...props} banner={props.banner} />);
    current = two;
    await new Promise((r) => setTimeout(r, 200));
    assert.match(two.lastFrame() ?? '', /Enter inspect/, '前置：重挂后浏览态保留');
    two.write('\r'); // Enter 选中已完成 spawn → 全屏回看 + 退浏览；browseMode 变更再次触发 repaint 卸载
    await new Promise((r) => setTimeout(r, 150));
    // 卸载帧有竞态不作断言（与 browse retain 用例同构），以同 retain 重挂帧验证 inspect 现场
    const three = render(<App {...props} banner={props.banner} />);
    current = three;
    await new Promise((r) => setTimeout(r, 200));
    assert.match(three.lastFrame() ?? '', /subagent view/, '重挂后全屏态保留（retain 现场）');
    three.write('\u001b'); // Esc 退出（生产路径：store 先写 + 请求重绘，帧面状态经重挂生效）
    await new Promise((r) => setTimeout(r, 150));
    const four = render(<App {...props} banner={props.banner} />);
    current = four;
    await new Promise((r) => setTimeout(r, 200));
    assert.doesNotMatch(four.lastFrame() ?? '', /subagent view/, '重挂后 Esc 退出（retain.inspect 已清）');
    four.unmount();
    current = undefined;
  } finally {
    current?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：浏览态子代理单点承载——运行中行只在统一列表，ChildPanel 隐藏（2026-09-28 双显修复）', async () => {
  const tmp = tmpdir('sunshinex-sess-dual-');
  let term: TestRenderResult | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    });
    // 单个运行中子代理（token 在途无 done）：面板态在场，无归档行——合并序列只含运行中项
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'a', label: 'rv' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'token', text: 'rv 在途\n', payload: { subagent: 'rv' } } as never);
    const retain = initialRetained();
    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} retain={retain} />);
    const one = term;
    await new Promise((r) => setTimeout(r, 200));
    assert.match(one.lastFrame() ?? '', /✻ \[rv\]/, '常态 ChildPanel 承载运行中行');
    one.write('\u0002'); // Ctrl+B 进入浏览
    await new Promise((r) => setTimeout(r, 150));
    const browse = one.lastFrame() ?? '';
    assert.match(browse, /\[rv\] running/, '浏览列表统一呈现运行中行（en 缺省语言）');
    assert.doesNotMatch(browse, /✻ \[/, '浏览态 ChildPanel 隐藏——同一子代理不再两处承载（双显修复）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
