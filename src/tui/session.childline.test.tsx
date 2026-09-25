import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';

// transcript 结构化（规格 §4.1）：tool-call→call、tool-result→result(ok)、token→text
test('child transcript 结构行：三分支 kind 映射与 ok 标记', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-childline-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    const label = 'w';
    ctrl.onEventForTest({ type: 'token', text: '分析中…\n', payload: { subagent: label } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'grep', payload: { subagent: label, input: { pattern: 'x' }, callId: 's1:0' } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: '4 matches', payload: { subagent: label, ok: true, callId: 's1:0' } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'boom', payload: { subagent: label, ok: false, callId: 's1:1' } } as never);
    const child = ctrl.getState().children.find((c) => c.label === label);
    assert.ok(child, '子代理面板态应在场');
    const kinds = child!.transcript.map((l) => l.kind);
    assert.deepEqual(kinds, ['text', 'call', 'result', 'result'], `三分支按序映射，实际 ${JSON.stringify(child!.transcript)}`);
    const results = child!.transcript.filter((l) => l.kind === 'result');
    assert.deepEqual(results.map((r) => r.ok), [true, false], 'result 行携带 ok 标记');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('委派 prompt 捕获：spawn tool-call 的 input.prompt 随面板态存档', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-childprompt-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    // 主链 spawn 调用先到（无 subagent payload），子代理事件随后按 label 路由
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '调研单体链路', label: 'w' }, callId: 'm1:0' } } as never);
    ctrl.onEventForTest({ type: 'token', text: '开工\n', payload: { subagent: 'w' } } as never);
    const child = ctrl.getState().children.find((c) => c.label === 'w');
    assert.equal(child?.prompt, '调研单体链路', '委派 prompt 应随面板态存档');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
