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

test('会话控制器：/init 走模型任务生成 SUNSHINE.md（新建）', async () => {
  const tmp = tmpdir('sunshinex-sess-init-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"' + path.join(tmp, 'SUNSHINE.md') + '","content":"# 项目名称\\ndemo-app\\n"},"done":false}',
        '{"done":true,"reply":"已新建 SUNSHINE.md，写入分区：项目名称"}',
      ]),
    });
    await ctrl.submit('/init');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.ok(fs.existsSync(path.join(tmp, 'SUNSHINE.md')), '模型应经 write 工具写入 SUNSHINE.md');
    assert.ok(!s.messages.some((m) => m.role === 'user'), 'goal 提示词属内部实现，不应上屏');
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('/init：分析项目，生成')), '应只有一行启动提示');
    assert.ok(
      s.messages.some((m) => m.role === 'system' && m.text.includes('已写入 SUNSHINE.md（新建）')),
      '完成应提示新建落盘',
    );
    assert.ok(s.messages.some((m) => m.role === 'assistant' && m.text.includes('项目名称')), '模型汇报应上屏');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：/init 已有 SUNSHINE.md 走完善语义且不覆盖原始内容', async () => {
  const tmp = tmpdir('sunshinex-sess-init-');
  try {
    const original = '# 项目名称\n既有项目\n\n# 编码规范\n- 既有规则保持不动\n';
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), original);
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"read","input":{"path":"SUNSHINE.md"},"done":false}',
        '{"tool":"write","input":{"path":"' + path.join(tmp, 'SUNSHINE.md') + '","content":"# 项目名称\\n既有项目\\n\\n# 编码规范\\n- 既有规则保持不动\\n\\n# 架构原则\\n- 补充分层说明\\n"},"done":false}',
        '{"done":true,"reply":"已完善 SUNSHINE.md，新增分区：架构原则"}',
      ]),
    });
    await ctrl.submit('/init');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.ok(!s.messages.some((m) => m.role === 'user'), 'goal 提示词属内部实现，不应上屏');
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('/init：分析项目，完善')), '已存在时应进入完善流程');
    assert.ok(
      s.messages.some((m) => m.role === 'system' && m.text.includes('已写入 SUNSHINE.md（完善）')),
      '完成应提示完善落盘',
    );
    const after = fs.readFileSync(path.join(tmp, 'SUNSHINE.md'), 'utf8');
    assert.ok(after.includes('既有规则保持不动'), '用户既有内容应保留');
    assert.ok(after.includes('架构原则'), '缺失分区应被补全');
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

test('会话控制器：流式答复安全点切块增量入档，done 尾段补齐且拼接无损', async () => {
  const tmp = tmpdir('sunshinex-sess8-');
  try {
    const reply = '第一段。\n\n```json\n{"a": 1}\n```\n\n收尾段。';
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([JSON.stringify({ done: true, reply })]),
    });
    const run = ctrl.submit('写点东西');
    // 运行中途即应出现首块入档（不等 done）
    await waitFor(() => ctrl.getState().messages.filter((m) => m.role === 'assistant').length >= 1, 3000);
    const midLive = ctrl.getState().live;
    assert.ok(midLive === undefined || (midLive.committedLen ?? 0) > 0, '预览水位应排除已入档前缀');
    await run;
    await ctrl.waitIdle();
    const s = ctrl.getState();
    const chunks = s.messages.filter((m) => m.role === 'assistant').map((m) => m.text);
    assert.ok(chunks.length >= 2, `长答复应分块入档（got ${chunks.length} 块）`);
    assert.equal(chunks.join(''), reply, '分块 + 尾段拼接应无损等于终稿（无重复无丢失）');
    assert.equal(s.status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：done 步携带 phase → step 阶段行上屏且先于答复', async () => {
  const tmp = tmpdir('sunshinex-sess-phase-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"完成。","phase":"正在汇总结论"}']),
    });
    await ctrl.submit('做个任务');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    const steps = s.messages.filter((m) => m.role === 'step');
    assert.equal(steps.length, 1, 'phase 阶段行应上屏');
    assert.equal(steps[0]?.text, '正在汇总结论');
    const stepIdx = s.messages.findIndex((m) => m.role === 'step');
    const replyIdx = s.messages.findIndex((m) => m.role === 'assistant');
    assert.ok(stepIdx >= 0 && replyIdx > stepIdx, '阶段行应先于答复入档');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
