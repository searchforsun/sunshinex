import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import type { ChatRequest, ChatResult } from '../types';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';
import { stripAnsi } from './md-ansi';
import { replyPreviewWindow } from './components/MessageList';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 钩子适配器：reasoning/usage 可注入，token 逐字流式（验证会话归约对三类增量事件的消费） */
class HookAdapter implements ModelAdapter {
  readonly provider = 'hooks';
  constructor(
    private readonly text: string,
    private readonly opts: { reasoning?: string[]; usage?: number } = {},
  ) {}
  async chat(_req: ChatRequest, _hooks?: UsageHooks): Promise<ChatResult> {
    return { finish: 'stop', content: this.text, toolCalls: [] };
  }
  async chatStream(_req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult> {
    for (const r of this.opts.reasoning ?? []) hooks?.onReasoning?.(r);
    for (const ch of this.text) onDelta(ch);
    if (this.opts.usage) hooks?.onUsage?.(this.opts.usage);
    return { finish: 'stop', content: this.text, toolCalls: [] };
  }
}

test('会话归约：token 增量进 live.reply（协议骨架不上屏），done 以终稿收束且不重复', async () => {
  const tmp = tmpdir('sunshinex-stream1-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"流式答复"}']) });
    const snapshots: string[] = [];
    ctrl.onState((s) => {
      if (s.live?.kind === 'reply') snapshots.push(s.live.text);
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.equal(s.live, undefined, 'done 后实时区清空');
    assert.ok(snapshots.length > 0, '应观测到流式增量');
    assert.ok(
      snapshots.some((t) => t.length > 0 && t.length < '流式答复'.length),
      '应存在中间增量（非整段一次性）',
    );
    const assistant = s.messages.filter((m) => m.role === 'assistant').map((m) => m.text);
    assert.deepEqual(
      assistant.map((t) => stripAnsi(t).replace(/\n+$/, '')),
      ['流式答复'],
      '终稿取 done 载荷且仅一条（ansi 条目承载，尾随单换行为流式规范）',
    );
    assert.ok(!s.messages.some((m) => stripAnsi(m.text).includes('"reply"')), '协议骨架不得泄漏进消息区');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：reasoning 实时区折叠为 Thought 摘要行', async () => {
  const tmp = tmpdir('sunshinex-stream2-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"答复"}', { reasoning: ['先想', '再想'] }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    const thinking = s.messages.filter((m) => m.role === 'thinking');
    assert.equal(thinking.length, 1, '思考实时区收束为一条摘要行');
    assert.match(thinking[0].text, /^Thought for \d+s$/);
    assert.equal(s.live, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：usage 事件驱动本轮 tokens（turnTotal 累计）', async () => {
  const tmp = tmpdir('sunshinex-stream3-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"ok"}', { usage: 7 }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().metrics.turnTokens, 7, '本轮 tokens 应取 usage.turnTotal');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：工具调用/结果两行形态（英文动词 + ✓/✗）', async () => {
  const tmp = tmpdir('sunshinex-stream4-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"a.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"写完"}',
      ]),
    });
    await ctrl.submit('写文件');
    await ctrl.waitIdle();
    const msgs = ctrl.getState().messages;
    const call = msgs.find((m) => m.role === 'tool' && m.kind === 'call');
    assert.equal(call?.text, 'WRITE a.txt', '工具调用行应为英文动词 + 路径');
    const result = msgs.find((m) => m.role === 'tool' && m.kind === 'result');
    assert.equal(result?.ok, true, 'write 成功结果应标记 ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：/plan 逐项执行落 Step 步骤行', async () => {
  const tmp = tmpdir('sunshinex-stream5-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. 建 a\\n2. 建 b"}',
        '{"done":true,"reply":"a 完成"}',
        '{"done":true,"reply":"b 完成"}',
      ]),
    });
    await ctrl.submit('/plan 建两个文件');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const steps = ctrl.getState().messages.filter((m) => m.role === 'step').map((m) => m.text);
    assert.deepEqual(steps, ['Step 1/2 — 建 a', 'Step 2/2 — 建 b']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：工具边界旁白封口——无空行结尾的叙述段先于工具行定格为 assistant 消息（2026-09-30 phase 通道退役配套：旁白唯一承载是正文，旧 closeLive 丢弃即蒸发；CC 交错形态）', async () => {
  const tmp = tmpdir('sunshinex-sess-seal-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: {
        provider: 'seal-stub',
        chat: async () => ({ finish: 'stop' as const, content: '', toolCalls: [] }),
        chatStream: async (_req: ChatRequest, _onDelta: (t: string) => void) => {
          return { finish: 'stop' as const, content: '', toolCalls: [] };
        },
      } as never,
    });
    const fire = (e: { type: string; text?: string; payload?: Record<string, unknown> }): void =>
      (ctrl as unknown as { onEventForTest(e: never): void }).onEventForTest(e as never);
    // 首轮：旁白 delta（无空行、无尾随换行）→ 出工具牌
    fire({ type: 'token', text: '先核对配置层再读仓库结构。' });
    fire({ type: 'tool-call', text: 'READ', payload: { callId: 'c1', input: { path: 'a.ts' } } });
    fire({ type: 'tool-result', text: '42 lines', payload: { ok: true, callId: 'c1' } });
    // 旁白已封口为 assistant ansi 消息，且先于工具行（条目 text 为渲染态：剥 ANSI 后比对文案）
    const msgs = ctrl.getState().messages;
    const narrIdx = msgs.findIndex((m) => m.role === 'assistant' && stripAnsi(m.text).replace(/\n+$/, '') === '先核对配置层再读仓库结构。');
    const callIdx = msgs.findIndex((m) => m.kind === 'call');
    assert.ok(narrIdx >= 0, '无空行旁白在工具边界封口入档（不再被 closeLive 丢弃）');
    assert.ok(callIdx > narrIdx, '旁白先于其后的工具行（CC 交错形态）');
    // 次轮终稿：done 收口照旧，且封口过的旁白不重复（pushMsg 不可变替换数组，须重取状态）
    fire({ type: 'token', text: '核对完成。' });
    fire({ type: 'done', text: '核对完成。', payload: {} });
    const assistant = ctrl.getState().messages.filter((m) => m.role === 'assistant').map((m) => stripAnsi(m.text).replace(/\n+$/, ''));
    assert.ok(assistant.includes('核对完成。'), '终稿照常入档');
    assert.equal(assistant.filter((t) => t === '先核对配置层再读仓库结构。').length, 1, '封口旁白恰一份');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：块边界提交帧零位移（2026-10-02「纯正文流式输入框反复跳中」真凶钉）——水位镜像先于入档通知，提交帧预览为空（不得重演已入档块）', async () => {
  const tmp = tmpdir('sunshinex-sess-stalewm-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: {
        provider: 'stalewm-stub',
        chat: async () => ({ finish: 'stop' as const, content: '', toolCalls: [] }),
        chatStream: async (_req: ChatRequest, _onDelta: (t: string) => void) => {
          return { finish: 'stop' as const, content: '', toolCalls: [] };
        },
      } as never,
    });
    const fire = (e: { type: string; text?: string; payload?: Record<string, unknown> }): void =>
      (ctrl as unknown as { onEventForTest(e: never): void }).onEventForTest(e as never);
    let checked = false;
    const unsub = ctrl.onState((s) => {
      if (checked) return;
      if (!s.messages.some((m) => m.ansi && stripAnsi(m.text).includes('第二行'))) return;
      checked = true;
      // 提交通知的同步时刻：旧实现 state.live.tailStart 仍是旧值（指向刚提交的块首）——MdBufferPreview
      // 在同一提交帧里把整块再演一遍（「静态+预览」双份超高帧滚动），80ms 后水位落定（mdConsume 末尾
      // 镜像）帧再塌回去：输入框每段落一跳（跳到中部、随下一段预览重新往下长）。镜像须先于 pushMsg→notify
      assert.ok(s.live?.kind === 'reply', '提交时刻 live 仍在（reply 流式中）');
      assert.equal(s.live.tailStart, undefined, '提交时刻水位已复位（mdFlushHold 镜像先于入档通知）');
      assert.deepEqual(replyPreviewWindow(s.live, 80, 18), [], '提交帧预览为空（零位移交换：静态 p+1 行 + 空预览）');
    });
    fire({ type: 'token', text: '第一段行一。\n第二行。\n\n' });
    unsub();
    assert.ok(checked, '已观测到提交通知');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：正文→思考交错零位移收口（2026-10-02「流式输入框跳到中间」病根钉）——尾段在交错点成块入档 + md 通道复位坐标同步（防预览恒空）', async () => {
  const tmp = tmpdir('sunshinex-sess-interleave-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: {
        provider: 'interleave-stub',
        chat: async () => ({ finish: 'stop' as const, content: '', toolCalls: [] }),
        chatStream: async (_req: ChatRequest, _onDelta: (t: string) => void) => {
          return { finish: 'stop' as const, content: '', toolCalls: [] };
        },
      } as never,
    });
    const fire = (e: { type: string; text?: string; payload?: Record<string, unknown> }): void =>
      (ctrl as unknown as { onEventForTest(e: never): void }).onEventForTest(e as never);
    // 第一段：闭合块入档（建立深层水位）+ 未闭合尾段（MdBufferPreview 正在显示的形态）
    fire({ type: 'token', text: '第一段行一\n第一段行二\n\n' });
    fire({ type: 'token', text: '第二段行一\n第二段行二\n第二段行三\n' });
    const before = ctrl.getState().live;
    assert.ok(before?.kind === 'reply' && typeof before.tailStart === 'number' && before.tailStart > 0, '前置：深层水位（第二段未闭合，tailStart 指向段首）');
    // 交错点：reasoning 增量到达（无 tool-call/seal——GLM 深度思考模型的段间思考形态）
    fire({ type: 'reasoning', text: '段间思考' });
    const st = ctrl.getState();
    assert.equal(st.live?.kind, 'thinking', '交错后 live 切思考窗');
    // 钉 1（零位移交换）：未闭合尾段必须已在交错点成块入档——旧路径 closeLive 只丢 live 块，
    // MdBufferPreview 整段塌掉零静态补偿，动态帧瞬矮 p+1 行、帧底输入框被抬到屏幕中部
    const sealed = st.messages.filter((m) => m.ansi).map((m) => stripAnsi(m.text));
    assert.ok(sealed.some((t) => t.includes('第二段行三')), '未闭合尾段在交错点封口入档（预览 p 行 → 静态 p+1 行）');
    // 钉 2（坐标复位）：思考后新正文与 md 水位同坐标系——旧路径 mdSource 跨块存续、live.text 重起算，
    // tailStart 越界即 replyPreviewWindow 恒空（正文隐形流式、输入框悬在中部直到块边界砸回）
    fire({ type: 'token', text: '第三段行一\n第三段行二\n' });
    const live = ctrl.getState().live;
    assert.ok(live?.kind === 'reply', '思考后正文恢复');
    assert.ok(
      live.tailStart === undefined || live.tailStart <= live.text.length,
      `tailStart(${live.tailStart}) ≤ live.text 长(${live.text.length})——通道复位后坐标同步`,
    );
    // 收口：三段内容无丢失无重复
    fire({ type: 'done', text: '', payload: {} });
    const plain = ctrl.getState().messages.filter((m) => m.ansi).map((m) => stripAnsi(m.text)).join('\n');
    for (const seg of ['第一段行二', '第二段行三', '第三段行二']) {
      assert.equal(plain.split(seg).length - 1, 1, `${seg} 恰一份（无丢失无重复）`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：列表 run 整块入档（正文行距律）——9 项问题清单单条 ansi、项间紧排', async () => {
  const tmp = tmpdir('sunshinex-stream-listrun-');
  try {
    const body = ['1. 线程池泄漏：描述甲', '2. 质检失败：描述乙', '3. 输出护栏：描述丙', '', '四、后续章节'].join('\n');
    const ctrl = new SessionController({ root: tmp, model: new HookAdapter(body) });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const items = ctrl.getState().messages.filter((m) => m.role === 'assistant' && m.ansi);
    const listItem = items.find((m) => m.text.includes('线程池泄漏'));
    assert.ok(listItem, '列表块入档');
    assert.ok(listItem!.text.includes('输出护栏'), '三项同块（run 整块发射，非逐行三块）');
    const para = items.find((m) => m.text.includes('后续章节'));
    assert.ok(para && para !== listItem, '空行后的章节独立成块');
    const plain = stripAnsi(listItem!.text);
    assert.match(plain, /1\. 线程池泄漏：描述甲\n2\. 质检失败：描述乙\n3\. 输出护栏：描述丙\n$/, '有序项与无序项同档紧排（列表项一律聚拢成组）');
    assert.ok(items.every((m) => !m.text.includes('\n\n\n')), '无 3+ 连续换行（行距档位不叠块界）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：逐行入档打字机（markdansi）——行级块为 ansi 条目、源内容经 stripAnsi 可寻、无丢无重', async () => {
  const tmp = tmpdir('sunshinex-stream-cont-');
  try {
    // 三行流式：行1、行2、空行、第二段——逐行切块入档（空行片段由条目 margin 承载、不入档）
    const ctrl = new SessionController({ root: tmp, model: new HookAdapter('第一行\n第二行\n\n第二段') });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const items = ctrl.getState().messages.filter((m) => m.role === 'assistant');
    assert.ok(items.length >= 2, `逐行/收口多块入档（got ${items.length} 块）`);
    assert.ok(items.every((m) => m.ansi === true), '流式条目全部 ansi');
    const joined = items.map((m) => stripAnsi(m.text)).join('');
    for (const probe of ['第一行', '第二行', '第二段']) assert.ok(joined.includes(probe), `内容不丢：${probe}`);
    assert.equal(joined.replace(/\n+$/, ''), '第一行 第二行\n第二段', '剥 ANSI 拼接与源一致：同段软换行并段（空格相连）；块间空行由渲染层 margin 承载、不在文本（无丢无重）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：流式正文 markdansi 行级入档——散文行即发、表格缓冲至闭合整块（ansi 条目）', async () => {
  const tmp = tmpdir('sunshinex-stream-md-');
  try {
    const text = '第一行\n第二行\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n收尾。';
    const ctrl = new SessionController({ root: tmp, model: new HookAdapter(text) });
    const ansiSeen: string[] = [];
    ctrl.onState((s) => {
      for (const m of s.messages) if (m.role === 'assistant' && m.ansi && !ansiSeen.includes(m.text)) ansiSeen.push(m.text);
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const items = ctrl.getState().messages.filter((m) => m.role === 'assistant');
    assert.ok(items.length >= 2, '行级/段级多块入档');
    assert.ok(items.every((m) => m.ansi === true), '流式条目全部 ansi');
    const table = items.find((m) => m.text.includes('│'));
    assert.ok(table, '表格块含框线（闭合后整块）');
    assert.ok(items.some((m) => m.text.includes('第一行')), '散文行入档');
    // 源不丢不重：剥 ANSI 拼接含全部内容
    const joined = items.map((m) => m.text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')).join('');
    for (const probe of ['第一行', '第二行', '收尾']) assert.ok(joined.includes(probe), `内容不丢：${probe}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：工具边界旁白封口走 finish 冲刷（未闭合围栏渲染为完整框线块）', async () => {
  const tmp = tmpdir('sunshinex-stream-md2-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        // 结构化步骤承载工具批 + 旁白正文（字符串 DSL 的 tools 形态丢弃 reply，narration 无从流式）
        { toolCalls: [{ name: 'read', args: { path: 'a.ts' } }], content: '前言\n\n```ts\ncode\nmore' },
        JSON.stringify({ done: true, reply: 'ok' }),
      ]),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const msgs = ctrl.getState().messages;
    const fence = msgs.find((m) => m.ansi && m.text.includes('┌'));
    assert.ok(fence, '未闭合围栏经 finish 冲刷为框线块（旁白封口）');
    const callIdx = msgs.findIndex((m) => m.kind === 'call');
    const fenceIdx = msgs.findIndex((m) => m === fence);
    assert.ok(fenceIdx < callIdx, '旁白先于工具行（CC 交错形态保持）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：空白行保行域达 streamer——表格经空行 flushTable 独立入档，不与后续段落粘连（N1 回归）', async () => {
  const tmp = tmpdir('sunshinex-stream-n1-');
  try {
    // 逐字流式（HookAdapter）下表格后的空行须以 '\n' 达 markdansi push：flushTable 冲刷整表、
    // 后续段落独立成条。归一吞掉尾换行（push('') no-op）即表格滞留 buffer、finish 才整块冲出 → 粘连单条
    const text = '| a | b |\n|---|---|\n| 1 | 2 |\n\n收尾段。';
    const ctrl = new SessionController({ root: tmp, model: new HookAdapter(text) });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const items = ctrl.getState().messages.filter((m) => m.role === 'assistant' && m.ansi);
    const table = items.find((m) => m.text.includes('│'));
    assert.ok(table, '表格块入档（框线成形）');
    assert.ok(!table.text.includes('收尾'), '表格独立入档——空行达 streamer 触发 flushTable，不与后续段落粘连成单条');
    assert.ok(items.some((m) => m !== table && stripAnsi(m.text).includes('收尾')), '后续段落在独立条目');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('J6 宽度源注入：SessionOpts.mdColumns 驱动流式块渲染宽度（通道与渲染层同源可注入）', async () => {
  const tmp = tmpdir('sunshinex-stream-w-');
  try {
    const line = 'w'.repeat(70);
    // 窄源注入：40 列下 70 字符散文行必须折行——证明 mdWidth 经注入源而非 process.stdout 直读
    const narrow = new SessionController({ root: tmp, model: new ScriptedAdapter([`{"done":true,"reply":"${line}"}`]), mdColumns: () => 40 });
    await narrow.submit('任务');
    await narrow.waitIdle();
    const narrowBody = stripAnsi(narrow.getState().messages.filter((m) => m.role === 'assistant').map((m) => m.text).join(''));
    assert.ok(narrowBody.includes('\n'), '40 列注入：70 字符行折行（宽度源生效）');
    // 缺省不注入：回退 process.stdout.columns ?? 80（测试运行器非 TTY = 80），70 字符行不折——缺省行为不变
    const wide = new SessionController({ root: tmp, model: new ScriptedAdapter([`{"done":true,"reply":"${line}"}`]) });
    await wide.submit('任务');
    await wide.waitIdle();
    const wideBody = stripAnsi(wide.getState().messages.filter((m) => m.role === 'assistant').map((m) => m.text).join(''));
    assert.ok(!wideBody.replace(/\n+$/, '').includes('\n'), '缺省宽度 80：70 字符行不折（既有口径保持）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
