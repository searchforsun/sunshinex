import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('会话控制器：自然语言任务 → token 拼接 assistant 消息 → done 收束 idle', async () => {
  const tmp = tmpdir('sunshinex-sess1-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"任务完成"}']) });
    await ctrl.submit('做个任务');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.equal(s.status, 'idle');
    assert.equal(s.messages[0]?.role, 'user');
    const assistant = s.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('');
    assert.ok(assistant.includes('任务完成'), 'assistant 消息应含最终答复（token 拼接）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：运行中 submit 进入 FIFO 队列并依序执行', async () => {
  const tmp = tmpdir('sunshinex-sess2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([
      '{"done":true,"reply":"第一件事完成"}',
      '{"done":true,"reply":"第二件事完成"}',
    ]) });
    const p1 = ctrl.submit('第一件事');
    const p2 = ctrl.submit('第二件事');
    await Promise.all([p1, p2]);
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.equal(s.status, 'idle');
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('已排队')), '运行中提交应提示排队');
    const assistant = s.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('|');
    assert.ok(assistant.includes('第一件事完成') && assistant.includes('第二件事完成'), '两笔任务都应执行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：manual 审批挂起可观测，resolveApproval 放行后继续执行', async () => {
  const tmp = tmpdir('sunshinex-sess3-');
  try {
    // 不注入外部 asker：走键盘裁决路径，awaiting-approval 持续到 resolveApproval 回填（即时 asker 的挂起窗口微秒级，轮询不可观测）
    const ctrl = new SessionController({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"touch s-ok.txt"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    const p = ctrl.submit('跑个命令');
    await waitFor(() => ctrl.getState().status === 'awaiting-approval');
    assert.equal(ctrl.getState().approval?.kind, 'command');
    assert.equal(ctrl.getState().approval?.subject, 'touch s-ok.txt');
    await ctrl.resolveApproval('allow');
    await p;
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle');
    assert.equal(ctrl.getState().approval, undefined, '裁决后审批卡清空');
    assert.ok(ctrl.getState().messages.some((m) => m.role === 'tool'), '工具消息应上屏');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：斜杠命令 /help /status 产出 system 消息且不触发 run', async () => {
  const tmp = tmpdir('sunshinex-sess4-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const runsBefore = ctrl.runtime.harness.ledger.summary().runs;
    await ctrl.submit('/help');
    await ctrl.submit('/status');
    const s = ctrl.getState();
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('/new')), '/help 应列命令清单');
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('账本')), '/status 应含账本摘要');
    assert.equal(ctrl.runtime.harness.ledger.summary().runs, runsBefore, '斜杠命令不应落 run 账');
    assert.equal(s.status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：/init 生成 SUNSHINE.md 骨架，再次调用提示已存在且不落 run 账', async () => {
  const tmp = tmpdir('sunshinex-sess-init-');
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo-app' }));
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const runsBefore = ctrl.runtime.harness.ledger.summary().runs;
    await ctrl.submit('/init');
    await ctrl.submit('/init');
    const s = ctrl.getState();
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('已生成')), '首次 /init 应提示生成');
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('已存在')), '再次 /init 应提示已存在');
    assert.ok(fs.existsSync(path.join(tmp, 'SUNSHINE.md')), 'SUNSHINE.md 应已写入项目根');
    assert.equal(ctrl.runtime.harness.ledger.summary().runs, runsBefore, '/init 不消耗模型调用，不应落 run 账');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：/new 软重置清空消息与待办并清会话级审批登记', async () => {
  const tmp = tmpdir('sunshinex-sess5-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('产生一些消息');
    await ctrl.waitIdle();
    await ctrl.submit('/new');
    const s = ctrl.getState();
    assert.ok(!s.messages.some((m) => m.role === 'user'), '用户消息应被清空');
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('软重置')), '应提示软重置');
    assert.equal(s.todos.length, 0);
    assert.equal(s.status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
