import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App, approvalKeyToDecision } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('approvalKeyToDecision：y/a/n 三键映射，其余键不裁决', () => {
  assert.equal(approvalKeyToDecision('y'), 'allow');
  assert.equal(approvalKeyToDecision('a'), 'always');
  assert.equal(approvalKeyToDecision('n'), 'deny');
  assert.equal(approvalKeyToDecision('x'), undefined);
});

test('App：manual 审批流终态渲染（消息流/工具卡/助手答复/状态栏）', async () => {
  // 环境边界：ink@3 + React 18 的增量刷帧在本测试环境不可依赖（探针证实节流器不落增量帧），
  // 测试策略为先经控制器驱动至终态再渲染，断言首帧全量映射；实时增量刷新由真实终端承载
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-app1-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"a.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    const p = ctrl.submit('写个文件');
    await waitFor(() => ctrl.getState().status === 'awaiting-approval');
    assert.equal(ctrl.getState().approval?.subject, 'a.txt');
    await ctrl.resolveApproval('allow');
    await p;
    await ctrl.waitIdle();
    assert.equal(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8'), 'hi', '批准后 write 应真实落盘');

    const { lastFrame, allOutput, unmount } = render(<App controller={ctrl} />);
    const all = allOutput();
    assert.match(all, /写个文件/);        // 用户消息（整行底色带，无 [你] 标签）
    assert.match(all, /● \[WRITE\] a\.txt/); // 工具调用行（英文动词 + 方括号高亮）
    assert.match(all, /✓/);              // 工具结果行（成功）
    assert.match(all, /ok/);             // 助手裸文本答复
    const frame = lastFrame() ?? '';
    assert.match(frame, /空闲/);           // 状态栏状态词
    assert.ok(!all.includes('[你]'), '不得出现 [你] 角色标签');
    assert.ok(!all.includes('[助手]'), '助手答复应为裸文本');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：dontAsk 任务终态渲染（无审批卡）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-app2-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"done-reply"}']) });
    await ctrl.submit('直接完成');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().approval, undefined, 'dontAsk 模式不应产生审批挂起');

    const { lastFrame, allOutput, unmount } = render(<App controller={ctrl} />);
    assert.match(allOutput(), /done-reply/);
    assert.match(lastFrame() ?? '', /空闲/);
    assert.ok(!allOutput().includes('[助手]'), '助手答复应为裸文本');
    assert.ok(!allOutput().includes('审批'), 'dontAsk 不应出现审批模态');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：键盘驱动回车提交（斜杠命令与自然语言任务均触达控制器）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-app3-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"kb-reply"}']) });
    const { write, unmount } = render(<App controller={ctrl} />);
    await new Promise((r) => setTimeout(r, 200)); // 等挂载：ink 未接管 stdin 时首段输入会丢失
    write('/help');
    await new Promise((r) => setTimeout(r, 150)); // 文本与回车须分事件且留刷新间隙（探针实证 150ms 稳定）；同块连发会让 key.return 读到未刷新的旧 buffer
    write('\r');
    await waitFor(() => ctrl.getState().messages.some((m) => m.text.includes('/new 新会话')), 5000);
    write('跑个任务');
    await new Promise((r) => setTimeout(r, 150));
    write('\r');
    await ctrl.waitIdle();
    assert.ok(ctrl.getState().messages.some((m) => m.role === 'assistant' && m.text.includes('kb-reply')), '回车提交的任务应执行并产出答复');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：键盘 y 在审批卡上裁决放行（write 真实落盘）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-app4-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"kb.txt","content":"kb"},"done":false}',
        '{"done":true,"reply":"kb-ok"}',
      ]),
    });
    const { write, unmount } = render(<App controller={ctrl} />);
    await new Promise((r) => setTimeout(r, 200));
    write('写个文件');
    await new Promise((r) => setTimeout(r, 150));
    write('\r');
    await waitFor(() => ctrl.getState().approval !== undefined, 5000);
    await new Promise((r) => setTimeout(r, 150)); // 等重渲染：审批态分支的 handler 闭包就位
    write('y'); // 审批态拦截输入，按键即裁决、无需回车
    await ctrl.waitIdle();
    assert.equal(fs.readFileSync(path.join(tmp, 'kb.txt'), 'utf8'), 'kb', '键盘 y 放行后 write 应真实落盘');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：键盘 y 在计划卡上确认执行（待办全勾）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-app5-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. 步甲\\n2. 步乙"}',
        '{"done":true,"reply":"步甲完成"}',
        '{"done":true,"reply":"步乙完成"}',
      ]),
    });
    const { write, unmount } = render(<App controller={ctrl} />);
    await new Promise((r) => setTimeout(r, 200));
    write('/plan 演练');
    await new Promise((r) => setTimeout(r, 150));
    write('\r');
    await waitFor(() => ctrl.getState().status === 'awaiting-plan', 5000);
    await new Promise((r) => setTimeout(r, 150)); // 等重渲染：计划态分支的 handler 闭包就位
    write('y');
    await ctrl.waitIdle(15000);
    const st = ctrl.getState();
    assert.ok(st.todos.length === 2 && st.todos.every((t) => t.done), '键盘 y 确认后计划应逐项执行并全勾');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
