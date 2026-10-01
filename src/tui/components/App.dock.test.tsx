import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render, type TestRenderResult } from '../test-ink';
import { App } from './App';
import { MessageList, mdPreviewBlock } from './MessageList';
import { SessionController, type ChatItem, type LiveBlock } from '../session';
import { initialRetained } from '../ui-state';
import { ScriptedAdapter } from '../../model/adapter';
import type { ModelAdapter } from '../../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 帧高口径：log-update 单写整帧（擦除前缀 + 帧行 + 尾 \n），test-ink 剥 ANSI 后 lastFrame 即整帧文本——
 *  行数 = split('\n') - 1（尾换行的空尾元）。贴底垫层的铁律：帧高恒 rows-1（假 stdout 无 rows → App 兜底 24） */
function frameLineCount(term: TestRenderResult): number {
  const frame = term.lastFrame() ?? '';
  return frame.split('\n').length - 1;
}

/** 终态会话：一轮普通问答（历史非空 = dock 激活前提） */
async function settledCtrl(tmp: string): Promise<SessionController> {
  const ctrl = new SessionController({
    root: tmp,
    model: new ScriptedAdapter(['{"done":true,"reply":"第一轮回答"}']),
  });
  const p = ctrl.submit('第一轮提问');
  await p;
  await ctrl.waitIdle();
  return ctrl;
}

test('App：贴底垫层——有历史时空闲帧高恒 rows-1、状态栏贴帧底（2026-10-01「正文流式跳到中间」根治）', async () => {
  const tmp = tmpdir('sunshinex-app-dock-idle-');
  let term: TestRenderResult | undefined;
  try {
    const ctrl = await settledCtrl(tmp);
    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} retain={initialRetained()} />);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(frameLineCount(term), 23, '动态帧恒高 rows-1（24 行视口留 1 行光标行）');
    const lines = (term.lastFrame() ?? '').split('\n');
    assert.match(lines[lines.length - 2] ?? '', /idle/, '状态栏是帧的最后一个非空行（贴底）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：贴底垫层——回合收束后帧高不变（todo 展开由垫层差额吸收，输入框不跳）', async () => {
  const tmp = tmpdir('sunshinex-app-dock-settle-');
  let term: TestRenderResult | undefined;
  try {
    const ctrl = await settledCtrl(tmp);
    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} retain={initialRetained()} />);
    await new Promise((r) => setTimeout(r, 200));
    const before = frameLineCount(term);
    const p = ctrl.submit('第二轮提问');
    await p;
    await ctrl.waitIdle();
    await new Promise((r) => setTimeout(r, 600)); // 越过段锚点防抖
    assert.equal(frameLineCount(term), before, '回合前后帧高恒等（rows-1），运行中流式与收束态无高度跃变');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：贴底垫层——纵向命令面板在场帧高不变（输入框被菜单顶起即「跳」，垫层差额吸收）', async () => {
  const tmp = tmpdir('sunshinex-app-dock-menu-');
  let term: TestRenderResult | undefined;
  try {
    const ctrl = await settledCtrl(tmp);
    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} retain={initialRetained()} />);
    const { write } = term;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(frameLineCount(term), 23, '前置：贴底态');
    write('/');
    await new Promise((r) => setTimeout(r, 150));
    assert.match(term.lastFrame() ?? '', /\/help/, '命令面板在场');
    assert.equal(frameLineCount(term), 23, '菜单出现帧高不变（菜单行入 chrome 实账、垫层同帧收缩）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：贴底垫层——首轮无消息不垫（横幅+输入顶锚首屏，启动观感不回退）', async () => {
  const tmp = tmpdir('sunshinex-app-dock-fresh-');
  let term: TestRenderResult | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    });
    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} retain={initialRetained()} />);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(frameLineCount(term), 4, '无历史不垫：输入框 3 行 + 状态栏 1 行顶锚（不把横幅顶出首屏）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：贴底垫层——正文流式过程中帧恒 rows-1（历史短于视口时最新行贴底不悬中，真机「跳到中间」回归钉）', async () => {
  const tmp = tmpdir('sunshinex-app-dock-stream-');
  let term: TestRenderResult | undefined;
  try {
    // 节拍流式适配器：逐 delta 间隔到达，撑出可断言的 running 窗口（ScriptedAdapter 微任务级流完抓不到中间帧）
    const deltas = Array.from({ length: 10 }, (_, i) => `第${i + 1}段：流式正文段落。\n\n`);
    const paced: ModelAdapter = {
      provider: 'paced',
      async chat() {
        return { finish: 'stop', content: deltas.join(''), toolCalls: [] };
      },
      async chatStream(_req, onDelta) {
        for (const d of deltas) {
          onDelta(d);
          await new Promise((r) => setTimeout(r, 60));
        }
        return { finish: 'stop', content: '', toolCalls: [] };
      },
    };
    const ctrl = new SessionController({ root: tmp, model: paced });
    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} retain={initialRetained()} />);
    await new Promise((r) => setTimeout(r, 200));
    void ctrl.submit('写一篇长文');
    // 流式中段（首个 delta 已入档、live 尾窗在场）：帧高必须恒 23——历史只有几行也贴底，不再悬中
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ctrl.getState().status, 'running', '前置：节拍流式仍在运行');
    assert.equal(frameLineCount(term), 23, '流式期间帧恒高 rows-1（最新行+输入框贴底）');
    const lines = (term.lastFrame() ?? '').split('\n');
    assert.match(lines[lines.length - 2] ?? '', /idle|running/, '状态栏贴帧底');
    await ctrl.waitIdle();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(frameLineCount(term), 23, '收束后帧高不变（无收束跳变）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MessageList：贴底垫层按预览实高收缩——dockRegion 预算恒占满（纯装配钉）', () => {
  const userItem: ChatItem = { role: 'user', text: 'hi', ts: 0, seq: 1 };
  const live: LiveBlock = { kind: 'reply', text: '段落正文', startedAt: 0, tailStart: 0 };
  const cap = 5;
  const block = mdPreviewBlock(live, 100, cap);
  assert.ok(block, '前置：非空尾段有预览');
  const previewRows = block.lines.length + (block.truncated ? 1 : 0) + 1;
  let term: TestRenderResult | undefined;
  try {
    term = render(
      <MessageList
        messages={[userItem]}
        live={live}
        columns={100}
        rows={24}
        banner={{ version: '1.0.0', model: 'm', root: '.' }}
        expandAll={true}
        latestFull={false}
        dockRegion={10}
        previewCap={cap}
      />,
    );
    assert.equal(frameLineCount(term), 10, '帧高恒等于 dockRegion（垫层 = 预算 − 预览实高）');
    assert.ok(previewRows >= 2 && previewRows <= 6, '前置 sanity：预览实高含 marginBottom');
  } finally {
    term?.unmount();
  }
});
