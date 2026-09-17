import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { Harness } from '../harness';
import { RunOutcome, TuiRuntime } from './runtime';

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
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('Queued:')), '运行中提交应提示排队');
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
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('Ledger:')), '/status 应含账本摘要');
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
        '{"tool":"write","input":{"path":' + JSON.stringify(path.join(tmp, 'SUNSHINE.md')) + ',"content":"# 项目名称\\ndemo-app\\n"},"done":false}',
        '{"done":true,"reply":"已新建 SUNSHINE.md，写入分区：项目名称"}',
      ]),
    });
    await ctrl.submit('/init');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.ok(fs.existsSync(path.join(tmp, 'SUNSHINE.md')), '模型应经 write 工具写入 SUNSHINE.md');
    assert.ok(
      s.messages.filter((m) => m.role === 'user').every((m) => m.text === '/init'),
      'goal 提示词属内部实现不上屏；用户斜杠输入本身应回显',
    );
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('/init: analyzing project, generating')), '应只有一行启动提示');
    assert.ok(
      s.messages.some((m) => m.role === 'system' && m.text.includes('SUNSHINE.md written (created)')),
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
        '{"tool":"write","input":{"path":' + JSON.stringify(path.join(tmp, 'SUNSHINE.md')) + ',"content":"# 项目名称\\n既有项目\\n\\n# 编码规范\\n- 既有规则保持不动\\n\\n# 架构原则\\n- 补充分层说明\\n"},"done":false}',
        '{"done":true,"reply":"已完善 SUNSHINE.md，新增分区：架构原则"}',
      ]),
    });
    await ctrl.submit('/init');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.ok(
      s.messages.filter((m) => m.role === 'user').every((m) => m.text === '/init'),
      'goal 提示词属内部实现不上屏；用户斜杠输入本身应回显',
    );
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('/init: analyzing project, updating')), '已存在时应进入完善流程');
    assert.ok(
      s.messages.some((m) => m.role === 'system' && m.text.includes('SUNSHINE.md written (updated)')),
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
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text.includes('Soft reset:')), '应提示软重置');
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

test('会话控制器：done 步携带 phase → 不落阶段行（答复正文不被打断）', async () => {
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
    assert.equal(steps.length, 0, '终稿步骤不透传 phase：阶段行不得插入答复正文');
    const replies = s.messages.filter((m) => m.role === 'assistant');
    assert.ok(replies.some((m) => m.text.includes('完成。')), '答复正文完整');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：/model 查询与切换（档位 run 级常量，对后续任务生效）', async () => {
  const tmp = tmpdir('sunshinex-sess-model-');
  try {
    const harness = new Harness({ root: tmp, mode: 'dontAsk' });
    const seen: Array<string | undefined> = [];
    const base: RunOutcome = { done: true, reply: 'ok', tokensUsed: 0, stopReason: 'done' };
    const fake: TuiRuntime = {
      harness,
      runTask: async (_goal, o) => {
        seen.push(o?.tier);
        return base;
      },
    runLoop: async () => { throw new Error('runLoop not exercised in this suite'); },
    };
    const ctrl = new SessionController({ root: tmp, runtime: fake });
    await ctrl.submit('/model');
    await ctrl.submit('/model huge');
    await ctrl.submit('/model large');
    await ctrl.submit('做件事');
    await ctrl.waitIdle();
    await ctrl.submit('/model');
    const texts = ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
    assert.match(texts, /default \(SUNSHINEX_MODEL\)/, '无档位时查询显示缺省来源');
    assert.match(texts, /Usage: \/model small\|medium\|large/, '非法档位回用法提示');
    assert.match(texts, /Model tier set to large/, '切换有回执');
    assert.match(texts, /Current model tier: large/, '再次查询显示当前档位');
    assert.deepEqual(seen, ['large'], '切换后的任务应携带用户档位，切换前不得携带');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：装配级 tier 作为初始档位并下传任务', async () => {
  const tmp = tmpdir('sunshinex-sess-tier0-');
  try {
    const harness = new Harness({ root: tmp, mode: 'dontAsk' });
    const seen: Array<string | undefined> = [];
    const fake: TuiRuntime = {
      harness,
      runTask: async (_goal, o) => {
        seen.push(o?.tier);
        return { done: true, reply: 'ok', tokensUsed: 0, stopReason: 'done' };
      },
    runLoop: async () => { throw new Error('runLoop not exercised in this suite'); },
    };
    const ctrl = new SessionController({ root: tmp, runtime: fake, tier: 'medium' });
    assert.equal(ctrl.getState().model, 'medium', '装配档位进入会话状态');
    await ctrl.submit('做事');
    await ctrl.waitIdle();
    assert.deepEqual(seen, ['medium'], '任务应携带装配档位');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('普通任务走链：指令行 + 结论行入链', async () => {
  const tmp = tmpdir('sunshinex-sess-chain-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([JSON.stringify({ done: true, reply: 'A 完成' })]) });
    await ctrl.submit('任务A');
    await ctrl.waitIdle();
    const chain = ctrl.context.chainView();
    assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('任务A')), '当前指令行入链');
    assert.ok(chain.some((s) => s.action === 'reply' && s.observation === 'A 完成'), '结论行入链');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/new 清空会话链与压缩块', async () => {
  const tmp = tmpdir('sunshinex-sess-new-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([JSON.stringify({ done: true, reply: 'x' })]) });
    await ctrl.submit('任务A');
    await ctrl.waitIdle();
    assert.ok(ctrl.context.chainView().length > 0, '前置：链上应有内容');
    await ctrl.submit('/new');
    await ctrl.waitIdle();
    assert.equal(ctrl.context.chainView().length, 0, '/new 后会话链应清空');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ---------- 子代理显示数据面（payload.subagent 分流 + spawn 归档） ---------- */

test('子代理事件分流：payload.subagent 存在 → 进 children，主链 messages/live 零污染', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-child1-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'token', text: '子代理', payload: { subagent: 'w' } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'read', payload: { input: { path: 'a.ts' }, subagent: 'w' } } as never);
    const s = ctrl.getState();
    assert.equal(s.children.length, 1);
    assert.equal(s.children[0].label, 'w');
    assert.ok(s.children[0].tail.length >= 1 && s.children[0].tail.length <= 3, 'tail ≤3 行（含未成行）');
    assert.equal(s.messages.length, 0, '主链零污染');
    assert.equal(s.live, undefined, '主链 live 零污染');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('spawn 全链归档：children 移除 + 调用行 detail 附转录（恰好一次）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-child2-'));
  try {
    // gate 挂起子代理模型轮（scripted 适配器无真实异步，不挂起则整链先于断言跑完）：
    // calls 1 = 主链 spawn 信封，calls 2 = 子代理轮（挂起，留出真实时序窗口喂事件），calls 3 = 主链 done
    let gateResolve!: () => void;
    const gate = new Promise<void>((res) => {
      gateResolve = res;
    });
    let calls = 0;
    const model: ModelAdapter = {
      provider: 'probe',
      complete: async () => {
        calls++;
        if (calls === 1) return JSON.stringify({ tool: 'spawn', input: { prompt: '子任务', label: 'w' }, done: false });
        if (calls === 2) {
          await gate;
          return JSON.stringify({ done: true, reply: '子任务报告' });
        }
        return JSON.stringify({ done: true, reply: '主链完成' });
      },
    } as ModelAdapter;
    const ctrl = new SessionController({ root: tmp, model });
    const p = ctrl.submit('主任务');
    await waitFor(() => ctrl.getState().messages.some((m) => m.role === 'tool' && m.kind === 'call'));
    // 子代理挂起窗口：喂合成 token（真实子代理事件经 Harness 装配 onEvent 同通道自动到达）
    ctrl.onEventForTest({ type: 'token', text: '分析中…\n', payload: { subagent: 'w' } } as never);
    assert.equal(ctrl.getState().children.length, 1, '运行中面板应在场（规格 G2）');
    gateResolve();
    await p;
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.equal(s.children.length, 0, '归档后 children 清空');
    const call = s.messages.find((m) => m.role === 'tool' && m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call, 'spawn 调用行应上屏（SPAWN w）');
    assert.ok(call!.detail && call!.detail.includes('分析中'), '调用行 detail 应含子代理转录');
    assert.ok(s.messages.some((m) => m.kind === 'result' && (m.text ?? '').includes('子任务报告')), '结果行上屏');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('同名并发归档：前缀匹配 #N 子代理各归档一次（规格 §9④）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-child3-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'token', text: 'A 线\n', payload: { subagent: 'w' } } as never);
    ctrl.onEventForTest({ type: 'token', text: 'B 线\n', payload: { subagent: 'w#2' } } as never);
    // 模拟 Task 1 消歧后的两条同名 spawn 结果流：先压调用（基名均为 w），逐条结果归档
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p1', label: 'w' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: '子完成', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p2', label: 'w' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: '子完成', payload: { tool: 'spawn', ok: true } } as never);
    const s = ctrl.getState();
    assert.equal(s.children.length, 0, '两条同名子代理应恰好各归档一次');
    const details = s.messages.filter((m) => m.kind === 'call').map((m) => m.detail ?? '');
    assert.equal(details.filter((d) => d.includes('A 线')).length, 1, 'A 线转录恰好归档一次');
    assert.equal(details.filter((d) => d.includes('B 线')).length, 1, '#2 子代理按前缀匹配归档一次');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：/compact 补链参与，链折叠且摘要来自会话模型', async () => {
  const tmp = tmpdir('sunshinex-sess-compact-');
  try {
    const SUMMARY = '## Goal\n压缩演示\n## Constraints\n只读\n## Progress\n已折叠\n## Verified\n回执一致\n## Open\n无\n## Rationale\n会话模型路径';
    const harness = new Harness({
      root: tmp,
      mode: 'dontAsk',
      model: { provider: 'openai', complete: async (p) => (p.includes('handoff summary') ? SUMMARY : '{"done":true,"reply":"ok"}') },
    });
    harness.context.appendChain([
      { action: 'read', observation: 'Y'.repeat(2000) },
      { action: 'read', observation: 'Z'.repeat(2000) },
    ]);
    const fake: TuiRuntime = {
      harness,
      runTask: async () => ({ done: true, reply: 'ok', tokensUsed: 0, stopReason: 'done' }),
      runLoop: async () => { throw new Error('runLoop not exercised in this suite'); },
    };
    const ctrl = new SessionController({ root: tmp, runtime: fake });
    await ctrl.submit('/compact');
    const texts = ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
    assert.match(texts, /Compressed: \d+ summary chunks re-injected/, '压缩回执上屏');
    assert.equal(harness.context.chainView().length, 0, '链前缀已折叠（/compact 补链语义）');
    const sum = harness.context.assemble().find((i) => i.content.startsWith('[Compacted summary'));
    assert.ok(sum && sum.content.includes('## Rationale'), '压缩块正文为模型六节摘要');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：/compact 非真实模型通道走确定性压缩（门禁关闭）', async () => {
  const tmp = tmpdir('sunshinex-sess-compact2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const ctx = ctrl.runtime.harness.context;
    ctx.appendChain([{ action: 'read', observation: 'Y'.repeat(2000) }]);
    await ctrl.submit('/compact');
    assert.equal(ctx.chainView().length, 0, '链前缀已折叠');
    const sum = ctx.assemble().find((i) => i.content.startsWith('[Compacted summary'));
    assert.ok(sum && sum.content.includes('- [history] 1: read -> '), '确定性 join 回退');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** usage 计数桩：逐请求回传预设 (cache, prompt, reply)，驱动缓存口径用例 */
function usageModel(frames: Array<{ cache: number; prompt: number; reply: string }>): ModelAdapter {
  let i = 0;
  return {
    provider: 'usage-session-script',
    complete: async (
      _p: string,
      hooks?: { onUsage?: (t: number) => void; onCache?: (t: number) => void; onPrompt?: (t: number) => void },
    ) => {
      const f = frames[Math.min(i++, frames.length - 1)];
      hooks?.onPrompt?.(f.prompt);
      hooks?.onCache?.(f.cache);
      hooks?.onUsage?.(50);
      return f.reply;
    },
  };
}

test('会话控制器：缓存命中率为会话累计口径——跨任务不清零，轮首 miss 只稀释不砸零', async () => {
  const tmp = tmpdir('sunshinex-sess-cache-');
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: usageModel([
        { cache: 0, prompt: 1000, reply: '{"done":true,"reply":"ok"}' }, // 任务一：单请求轮全量 miss（TTL 形态）
        { cache: 0, prompt: 29_000, reply: '{"tool":"read","input":{"path":"a.txt"}}' }, // 任务二轮首：miss 后调用工具
        { cache: 29_000, prompt: 29_500, reply: '{"done":true,"reply":"ok"}' }, // 任务二次帧：前缀命中
      ]),
    });
    await ctrl.submit('任务一');
    await ctrl.waitIdle();
    let m = ctrl.getState().metrics;
    assert.equal(m.sessionPromptTokens, 1000, '任务一计入会话分母');
    assert.equal(m.sessionCacheTokens, 0, '任务一零命中计入分子');

    await ctrl.submit('任务二');
    await ctrl.waitIdle();
    m = ctrl.getState().metrics;
    assert.equal(m.sessionPromptTokens, 59_500, '会话累计跨任务不清零（1000+29000+29500）');
    assert.equal(m.sessionCacheTokens, 29_000);
    assert.ok(
      Math.abs(m.sessionCacheTokens / m.sessionPromptTokens - 29_000 / 59_500) < 1e-9,
      '会话命中率 = Σcached/Σprompt（≈48.7%），轮首 miss 只稀释不再主导',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：/new 归零会话缓存累计（会话级口径的软重置边界）', async () => {
  const tmp = tmpdir('sunshinex-sess-cache2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: usageModel([{ cache: 900, prompt: 1000, reply: '{"done":true,"reply":"ok"}' }]) });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().metrics.sessionPromptTokens, 1000);
    await ctrl.submit('/new');
    const m = ctrl.getState().metrics;
    assert.equal(m.sessionCacheTokens, 0, '/new 归零会话缓存分子');
    assert.equal(m.sessionPromptTokens, 0, '/new 归零会话缓存分母');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：turns/steps 会话累计——跨任务累加、done 帧不计步、/new 归零', async () => {
  const tmp = tmpdir('sunshinex-sess-turns-');
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'y');
  try {
    const ctrl = new SessionController({
      root: tmp,
      mode: 'dontAsk',
      model: usageModel([
        { cache: 900, prompt: 1000, reply: '{"done":true,"reply":"ok"}' }, // 任务一：直答，零工具步
        { cache: 900, prompt: 1000, reply: '{"tool":"read","input":{"path":"b.txt"}}' }, // 任务二步 1：读工具
        { cache: 900, prompt: 1000, reply: '{"done":true,"reply":"ok"}' }, // 任务二收尾帧（不计步）
      ]),
    });
    await ctrl.submit('任务一');
    await ctrl.waitIdle();
    let m = ctrl.getState().metrics;
    assert.equal(m.sessionTurns, 1, '任务一计 1 轮');
    assert.equal(m.sessionSteps, 0, '无工具动作不计步（done 帧不计）');

    await ctrl.submit('任务二');
    await ctrl.waitIdle();
    m = ctrl.getState().metrics;
    assert.equal(m.sessionTurns, 2, '轮次跨任务累加');
    assert.equal(m.sessionSteps, 1, '工具步计 1、done 收尾帧不计');

    await ctrl.submit('/new');
    m = ctrl.getState().metrics;
    assert.equal(m.sessionTurns, 0, '/new 归零轮次');
    assert.equal(m.sessionSteps, 0, '/new 归零步数');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
