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

    const { lastFrame, unmount } = render(<App controller={ctrl} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /\[你\] 写个文件/);
    assert.match(frame, /\[工具\] \[OK\]/);
    assert.match(frame, /\[助手\] ok/);
    assert.match(frame, /空闲/);
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

    const { lastFrame, unmount } = render(<App controller={ctrl} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /\[助手\] done-reply/);
    assert.match(frame, /空闲/);
    assert.ok(!frame.includes('审批'), 'dontAsk 不应出现审批模态');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
