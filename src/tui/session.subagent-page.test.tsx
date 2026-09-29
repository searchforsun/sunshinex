import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 2026-09-28 真机三症状回归（碎片口径 2026-09-30 保序修订）：工具边界时序、done 终稿与流式正文重复、归档留存与精简 detail */

test('结构边界冲刷半行保序：正文先于其后的工具行入档，不再跨工具行滞留沉底（2026-09-30 真机「工具/阶段说明集中最后」病根）', () => {
  const tmp = tmpdir('sunshinex-sess-frag-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p', label: 'f' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'started', payload: { tool: 'spawn', ok: true } } as never);
    // 未换行正文半行碰上工具调用：半行先行入档再落 call 行——时间线保序（对齐 CC：正文片段先于其后的工具块；
    // 相邻片段在全屏视图 md 段自动拼段，不显碎片）
    ctrl.onEventForTest({ type: 'token', text: 'import com.', payload: { subagent: 'f' } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'READ', payload: { input: { path: 'a' }, subagent: 'f' } } as never);
    const child = ctrl.getState().children.find((c) => c.label === 'f');
    assert.ok(child, '面板态在');
    assert.deepEqual(child!.transcript.map((l) => l.kind), ['text', 'call'], '半行先于工具行入档（时序保序）');
    assert.equal(child!.transcript[0]!.text, 'import com.', '半行内容完整先行入档');
    // 工具行后的续接正文独立成行（行尾 \n 的空段是 pop 出的续接 buf，非空行不入档；
    // 空行仅出现在「内容之间的空行」——2026-09-29 空行保留口径：段落边界随转录入档）
    ctrl.onEventForTest({ type: 'tool-result', text: 'ok', payload: { ok: true, subagent: 'f' } } as never);
    ctrl.onEventForTest({ type: 'token', text: 'x.y.Z;\n', payload: { subagent: 'f' } } as never);
    const seq = ctrl.getState().children.find((c) => c.label === 'f')!.transcript.map((l) => `${l.kind}:${l.text}`);
    assert.equal(seq[3], 'text:x.y.Z;', '续接正文随行化入档');
    assert.ok(seq[0]!.startsWith('text:') && seq[1]!.startsWith('call:') && seq[2]!.startsWith('result:'), '全程保序（text → call → result → text）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('思考流独立分流：reasoning 独立缓冲实时预览，非 reasoning 事件收束为 ✻ 摘要行（detail 全文）', () => {
  const tmp = tmpdir('sunshinex-sess-think-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p', label: 't' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'started', payload: { tool: 'spawn', ok: true } } as never);
    // reasoning 增量 → bufThink 实时预览（不与正文混流）
    ctrl.onEventForTest({ type: 'reasoning', text: '先想第一步\n再想', payload: { subagent: 't' } } as never);
    const streaming = ctrl.getState().children.find((c) => c.label === 't')!;
    assert.equal(streaming!.bufThink, '先想第一步\n再想', 'reasoning 增量独立累积（流式预览消费）');
    assert.equal(streaming!.transcript.length, 0, '思考未收束不产生转录行');
    // token 到达 → 思考收束 ✻ 摘要行 + 正文照常行化
    ctrl.onEventForTest({ type: 'token', text: '正文开始\n', payload: { subagent: 't' } } as never);
    const closed = ctrl.getState().children.find((c) => c.label === 't')!;
    assert.equal(closed!.transcript[0]?.kind, 'thinking', '思考收束为 thinking 摘要行');
    assert.match(closed!.transcript[0]!.text, /^Thought for \d+s$/, '摘要行对标主 agent closeLive 口径');
    assert.equal(closed!.transcript[0]!.detail, '先想第一步\n再想', 'detail 承载思考全文');
    assert.equal(closed!.transcript[1]?.kind, 'text', '思考收束后正文照常入档');
    // done → 归档 detail 序化 ✻ 摘要 + 4 空格缩进 detail 续行（ChildInspector archived 分流互为镜像）
    ctrl.onEventForTest({ type: 'done', text: '正文开始', payload: { subagent: 't' } } as never);
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call!.detail?.includes('✻ Thought for'), '归档 detail 含思考摘要行');
    assert.ok(call!.detail?.includes('    先想第一步'), '思考全文以 4 空格缩进续行折入 detail');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('done 终稿不与流式正文重复入档', () => {
  const tmp = tmpdir('sunshinex-sess-dup-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p', label: 'd' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'token', text: '正文第一段\n正文第二段', payload: { subagent: 'd' } } as never);
    // 终稿与流式正文逐字相同（真机大段重复病根）→ 不再追加；done 即归档离场，重复口径经归档 detail 锁定
    ctrl.onEventForTest({ type: 'done', text: '正文第一段\n正文第二段', payload: { subagent: 'd' } } as never);
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.equal((call!.detail ?? '').split('正文第二段').length - 1, 1, '终稿与流式逐字重复时 detail 中正文恰出现一次');
    // 终稿含流式未覆盖的新内容（后台两段式/无流式）→ 照常入档
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p', label: 'e' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'done', text: '纯终稿结论', payload: { subagent: 'e' } } as never);
    const callE = ctrl.getState().messages.filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN'))[1];
    assert.ok(callE!.detail?.includes('纯终稿结论'), '无流式正文时终稿照常入档（可见性兜底）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('归档即离场：归档后面板移除，detail 折入完整时间线（委派+转录+结论+统计，2026-09-28 用户裁决：归档与运行中/主 agent 同构）', () => {
  const tmp = tmpdir('sunshinex-sess-keep-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '调研前端目录', label: 'k' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'token', text: 'READ package.json\n读取配置完成\n', payload: { subagent: 'k' } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: '42 lines', payload: { subagent: 'k', ok: true } } as never);
    ctrl.onEventForTest({ type: 'done', text: '前端结论：结构清晰', payload: { subagent: 'k' } } as never);
    assert.equal(ctrl.getState().children.filter((c) => c.label === 'k').length, 0, '归档即从面板离场（动态区只显运行中，回看走历史区）');
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call?.detail?.includes('调研前端目录'), 'detail 含委派提示词（输入）');
    assert.ok(call!.detail!.includes('READ package.json'), 'detail 折入完整时间线（工具调用行）');
    assert.ok(call!.detail!.includes('⎿ ✓ 42 lines'), 'detail 折入结果行（⎿ ✓/✗ 形态，ChildInspector 分流还原）');
    assert.ok(call!.detail!.includes('前端结论：结构清晰'), 'detail 含结论（输出）');
    assert.ok(/steps/.test(call!.detail ?? ''), 'detail 含统计行');
    assert.equal(call!.detail!.split('前端结论：结构清晰').length - 1, 1, '结论恰出现一次（终稿与流式正文重复时不双份）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('归档后 Ctrl+B 浏览面承载回看：SPAWN 调用行 detail 在位可浏览', () => {
  const tmp = tmpdir('sunshinex-sess-sweep-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p', label: 's' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'done', text: '结论', payload: { subagent: 's' } } as never);
    const st = ctrl.getState();
    assert.equal(st.children.filter((c) => !c.done).length, 0, '面板只余运行中（零运行中即面板消失）');
    const archived = st.messages.filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.detail);
    assert.equal(archived.length, 1, '已完成 spawn 归档为历史区 SPAWN 行（Ctrl+B 浏览器直接浏览全部已完成）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
