import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function flushKey(_term: ReturnType<typeof render>): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function messageTexts(ctrl: SessionController): string {
  return ctrl.getState().messages.map((m) => m.text).join('\n');
}

test('App：审批卡选择器——↓+Enter=本会话放行（always），同主体后续操作不再询问', async () => {
  const tmp = tmpDir('sunshinex-appsel1-');
  let term: ReturnType<typeof render> | undefined;
  try {
    // 行为变更①：manual 档 path 写已下放安全链直放、不再弹审批卡——选择器机制改用仍会 guard 层 ask 的
    // 非只读 Bash 命令（mkdir）触发；写落盘经第二个 Bash 任务承载
    const ctrl = new SessionController({
      root: tmp,
      mode: 'acceptEdits',
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"mkdir sub"},"done":false}',
        '{"done":true,"reply":"first ok"}',
        '{"tool":"exec","input":{"command":"mkdir sub2"},"done":false}',
        '{"done":true,"reply":"second ok"}',
      ]),
    });
    const p1 = ctrl.submit('第一个命令任务');
    await waitFor(() => ctrl.getState().status === 'awaiting-approval');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('Approve once'), 3000);
    term.write('\u001B[B'); // ↓ → Allow for session
    await flushKey(term);
    term.write('\r');
    await p1;
    assert.ok(fs.existsSync(path.join(tmp, 'sub')), '选择器路径应放行并执行');
    await ctrl.submit('第二个命令任务');
    await ctrl.waitIdle();
    assert.ok(fs.existsSync(path.join(tmp, 'sub2')), 'always 后同族命令不再询问');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：审批卡 y/a/n 单键快捷并存——y 即放行一次（回归钉）', async () => {
  const tmp = tmpDir('sunshinex-appsel2-');
  let term: ReturnType<typeof render> | undefined;
  try {
    // 行为变更①：write 已不弹审批卡——单键快捷机制改用非只读 Bash 命令（mkdir）触发
    const ctrl = new SessionController({
      root: tmp,
      mode: 'acceptEdits',
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"mkdir q-dir"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    const p = ctrl.submit('跑个命令');
    await waitFor(() => ctrl.getState().status === 'awaiting-approval');
    term = render(<App controller={ctrl} />);
    term.write('y');
    await p;
    assert.ok(fs.existsSync(path.join(tmp, 'q-dir')), 'y 快捷键路径保持不变');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：plan 确认选择器——Enter（首项）执行计划', async () => {
  const tmp = tmpDir('sunshinex-appsel3-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. write greeting to p.txt"}',
        '{"tool":"write","input":{"path":"p.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"step done"}',
      ]),
    });
    const p = ctrl.submit('/plan make greeting');
    await waitFor(() => ctrl.getState().status === 'awaiting-plan');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('Execute plan'), 3000);
    term.write('\r'); // 首项 = Execute plan
    await p;
    await ctrl.waitIdle();
    assert.equal(fs.readFileSync(path.join(tmp, 'p.txt'), 'utf8'), 'hi', 'Enter 首项应执行计划');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：plan 确认 n=进入反馈输入态（键让位 composer）,Esc 中断流程回 idle（spec §4.2-4.4 回归钉）', async () => {
  const tmp = tmpDir('sunshinex-appsel4-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"1. step one"}', '{"done":true,"reply":"done"}']),
    });
    const p = ctrl.submit('/plan anything');
    await waitFor(() => ctrl.getState().status === 'awaiting-plan');
    term = render(<App controller={ctrl} />);
    term.write('n'); // 不再直接放弃：进入反馈输入态
    await flushKey(term);
    assert.equal(ctrl.getState().status, 'awaiting-plan', 'n 进入反馈态,流程仍在途');
    term.write('make it shorter'); // 键面让位 composer:文本落输入缓冲
    await flushKey(term);
    assert.ok((term?.lastFrame() ?? '').includes('make it shorter'), '反馈态键入应落入 composer 缓冲');
    term.write('\u001B'); // Esc=全局中断位→approval 拦截转 confirmPlan(false)→中止信号收尾
    await p;
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle', '中断后回输入态');
    assert.ok(messageTexts(ctrl).includes('Planning interrupted'), '中断回执上屏（不走旧式放弃回执）');
    assert.equal(ctrl.getState().todos.length, 0, '中断不执行不建待办');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
