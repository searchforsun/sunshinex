/** T2(P2 spec §5/Ruling 3):agent-message 事件 → 消息区 system 行 `[from → to] text` 即时呈现
 *  (lead 投递轨 = 事件即时呈现 + FileInbox 落档);两条序保持;板/委派投影零波及。 */
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

test('agent-message 事件:消息区末 system 行含 [w1 → lead] hi;两条保持序;板/委派投影零变化', () => {
  const tmp = tmpdir('sunshinex-sess-msg-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const boardBefore = ctrl.getState().board;
    const delegBefore = ctrl.getState().delegations;
    ctrl.onEventForTest({ type: 'agent-message', ts: 100, payload: { messageId: 'm1', from: 'w1', to: 'lead', text: 'hi' } });
    ctrl.onEventForTest({ type: 'agent-message', ts: 101, payload: { messageId: 'm2', from: 'lead', to: 'w2', text: 'go' } });
    const st = ctrl.getState();
    const systemLines = st.messages.filter((m) => m.role === 'system').map((m) => m.text);
    const msgLines = systemLines.filter((l) => l.includes('[w1 → lead] hi') || l.includes('[lead → w2] go'));
    assert.deepEqual(msgLines, ['[w1 → lead] hi', '[lead → w2] go'], '两条 agent-message 各成一行且保持投递序');
    assert.ok(systemLines[systemLines.length - 1]!.includes('[lead → w2] go'), '末条消息区 system 行为最新 agent-message');
    // 纯呈现事件:板/委派投影零变化(引用同一对象——分流未触达投影)
    assert.equal(st.board, boardBefore, 'agent-message 不影响板投影');
    assert.equal(st.delegations, delegBefore, 'agent-message 不影响委派投影');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
