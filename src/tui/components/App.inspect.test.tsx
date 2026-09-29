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

// 钉短裸 ESC 拼接窗口（use-input 拆包重组默认 40ms）：本套 Esc 退出断言只等 50ms，贴边易假红
process.env.SUNSHINEX_ESC_JOIN_MS = '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// App inspect 全屏接管（规格 §3.3）：键位全序列经 test-ink write 直驱——Ctrl+B 进入浏览 → Enter 进入全屏 → Esc 退出。
// 运行中子代理经子面板事件构造（SessionController.onEventForTest 与生产 onEvent 同通道）
test('App inspect：Tab 切换折叠/完整时间线（经生产 repaint 整屏重放，2026-09-30 用户裁决回归）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inspect-tab-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    // 生产同构：onRequestRepaint=卸载当前实例，tui-loop 循环体以同一 retain 重挂（App.spawn-browse 同款）
    const retain = { ...initialRetained() };
    let current: TestRenderResult | undefined;
    const props = { controller: ctrl, banner: { version: '1.0.0', model: 'm', root: tmp }, retain, onRequestRepaint: () => current?.unmount() };
    // 思考段（含 detail 全文）+ 工具对：折叠态 detail 不可见、Tab 展开 detail 可见
    ctrl.onEventForTest({ type: 'reasoning', text: '思考全文行甲\n思考全文行乙', payload: { subagent: 'w' } } as never);
    ctrl.onEventForTest({ type: 'token', text: '正文开始\n', payload: { subagent: 'w' } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'READ', payload: { input: { path: 'a.ts' }, subagent: 'w', callId: 'c1' } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: '8 lines', payload: { ok: true, subagent: 'w', callId: 'c1' } } as never);
    const one = render(<App {...props} />);
    current = one;
    for (let i = 0; i < 40 && !(one.lastFrame() ?? '').includes('[w]'); i++) await sleep(25);
    one.write('\u0002'); // Ctrl+B
    await sleep(50);
    one.write('\r'); // Enter → 全屏（setInspectRetained 触发卸载）
    await sleep(80);
    const two = render(<App {...props} />);
    current = two;
    await sleep(80);
    assert.match(two.lastFrame() ?? '', /子代理视图|subagent view/, '全屏视图接管');
    assert.match(two.allOutput(), /Thought for/, '思考收束摘要行在档');
    assert.ok(!two.allOutput().includes('思考全文行甲'), '折叠态思考全文不呈现');
    two.write('\t'); // Tab → 展开时间线（卸载）
    await sleep(120);
    const three = render(<App {...props} />);
    current = three;
    await sleep(120);
    assert.match(three.lastFrame() ?? '', /收起时间线|collapse timeline/, 'Tab 后状态行切到展开态（提示语为「可收起」）');
    assert.match(three.allOutput(), /思考全文行甲/, 'Tab 展开后思考全文呈现（Static 整屏重放）');
    three.write('\t'); // Tab → 折叠回缺省
    await sleep(120);
    const four = render(<App {...props} />);
    current = four;
    await sleep(120);
    assert.match(four.lastFrame() ?? '', /展开时间线|expand timeline/, '再按 Tab 回到折叠态（提示语为「可展开」）');
    four.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App inspect：browse→Enter 进全屏后浏览态不残留（store 同步卸载前落盘），直接 Esc 一步退回主界面（2026-09-30 真机「须先按 Enter」病根）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inspect-browse-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    const retain = { ...initialRetained() };
    let current: TestRenderResult | undefined;
    const props = { controller: ctrl, banner: { version: '1.0.0', model: 'm', root: tmp }, retain, onRequestRepaint: () => current?.unmount() };
    ctrl.onEventForTest({ type: 'token', text: '正文\n', payload: { subagent: 'w' } } as never);
    const one = render(<App {...props} />);
    current = one;
    for (let i = 0; i < 40 && !(one.lastFrame() ?? '').includes('[w]'); i++) await sleep(25);
    one.write('\u0002'); // Ctrl+B 浏览（setBrowse(true) 同步写 store）
    await sleep(80);
    assert.equal(retain.browseMode, true, '前置：浏览态已同步进 store');
    one.write('\r'); // Enter 选行 → setInspectRetained + setBrowse(false) 均同步写 store 后卸载
    await sleep(80);
    const two = render(<App {...props} />);
    current = two;
    await sleep(80);
    assert.equal(retain.browseMode, false, '重挂后浏览态不残留（旧实现残留 true 即全屏叠加浏览态吞键）');
    assert.ok(retain.inspect, '全屏态在');
    two.write('\u001B'); // 直接 Esc（此前须先按 Enter 归位浏览态才生效）
    await sleep(80);
    const three = render(<App {...props} />);
    current = three;
    await sleep(80);
    assert.equal(retain.inspect, undefined, '直接 Esc 退出全屏');
    assert.equal(retain.browseMode, false, '回到主界面（浏览态亦为关）');
    assert.doesNotMatch(three.lastFrame() ?? '', /subagent view|subagent browse/, '主界面无全屏/浏览残留');
    three.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App inspect：运行中子代理整页接管，Esc 退出恢复主界面（ChildPanel 行回到帧内）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inspect-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    const term = render(<App controller={ctrl} />);
    ctrl.onEventForTest({ type: 'token', text: '分析中…\n', payload: { subagent: 'w' } } as never);
    for (let i = 0; i < 40 && !(term.lastFrame() ?? '').includes('[w]'); i++) await sleep(25);
    assert.ok(!(term.lastFrame() ?? '').includes('子代理视图'), '未进入前全屏视图不在场');
    term.write('\u0002'); // Ctrl+B：浏览模式（运行中行在场即允许）
    await sleep(50);
    term.write('\r'); // Enter：选中运行中子代理 → 全屏接管
    await sleep(50);
    assert.match(term.lastFrame() ?? '', /子代理视图|subagent view/, '全屏视图接管整页');
    assert.match(term.lastFrame() ?? '', /分析中…/, '子代理转录实时呈现');
    term.write('\u001B'); // Esc：退出
    await sleep(50);
    assert.ok(!(term.lastFrame() ?? '').includes('子代理视图'), '退出后全屏视图消失');
    assert.match(term.lastFrame() ?? '', /\[w\]/, '回到主界面（ChildPanel 行在场）');
    term.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
