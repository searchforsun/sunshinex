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

/** 2026-09-28 真机三症状回归：碎片行撕裂、done 终稿与流式正文重复、归档留存与精简 detail */

test('流式碎片不撕裂：工具边界不冲半行，长成完整行后一次入档', () => {
  const tmp = tmpdir('sunshinex-sess-frag-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p', label: 'f' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'started', payload: { tool: 'spawn', ok: true } } as never);
    // 无换行半行（真机碎片「im」「import com.yupi.」病根：工具边界把半行撕成独立 text 行）
    ctrl.onEventForTest({ type: 'token', text: 'import com.', payload: { subagent: 'f' } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'READ', payload: { input: { path: 'a' }, subagent: 'f' } } as never);
    const child = ctrl.getState().children.find((c) => c.label === 'f');
    assert.ok(child, '面板态在');
    assert.equal(child!.transcript.filter((l) => l.kind === 'text').length, 0, '工具边界不产生半行碎片 text 行');
    // 半行继续增长，到换行才行化：恰一条完整行
    ctrl.onEventForTest({ type: 'tool-result', text: 'ok', payload: { ok: true, subagent: 'f' } } as never);
    ctrl.onEventForTest({ type: 'token', text: 'x.y.Z;\n', payload: { subagent: 'f' } } as never);
    const texts = ctrl.getState().children.find((c) => c.label === 'f')!.transcript.filter((l) => l.kind === 'text');
    assert.deepEqual(texts.map((l) => l.text), ['import com.x.y.Z;'], '半行长成完整行后恰一条入档');
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

test('归档即离场：归档后面板移除，detail 精简为委派+结论+统计（不折入全文转录）', () => {
  const tmp = tmpdir('sunshinex-sess-keep-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '调研前端目录', label: 'k' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'token', text: 'READ package.json\n读取配置完成\n', payload: { subagent: 'k' } } as never);
    ctrl.onEventForTest({ type: 'done', text: '前端结论：结构清晰', payload: { subagent: 'k' } } as never);
    assert.equal(ctrl.getState().children.filter((c) => c.label === 'k').length, 0, '归档即从面板离场（2026-09-28 用户裁决：动态区只显运行中，回看走历史区）');
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call?.detail?.includes('调研前端目录'), 'detail 含委派提示词（输入）');
    assert.ok(call!.detail!.includes('前端结论：结构清晰'), 'detail 含结论（输出）');
    assert.ok(/steps/.test(call!.detail ?? ''), 'detail 含统计行');
    assert.ok(!call!.detail!.includes('READ package.json'), 'detail 不折入全文转录（中间过程行不进历史区展开）');
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
