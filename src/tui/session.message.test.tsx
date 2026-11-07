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

test('agent-message 事件:投递 lead 上屏;队友互发/lead 外发不上主会话;板/委派投影零变化', () => {
  const tmp = tmpdir('sunshinex-sess-msg-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const boardBefore = ctrl.getState().board;
    const delegBefore = ctrl.getState().delegations;
    ctrl.onEventForTest({ type: 'agent-message', ts: 100, payload: { messageId: 'm1', from: 'w1', to: 'leader', text: 'hi' } });
    ctrl.onEventForTest({ type: 'agent-message', ts: 101, payload: { messageId: 'm2', from: 'leader', to: 'w2', text: 'go' } });
    ctrl.onEventForTest({ type: 'agent-message', ts: 102, payload: { messageId: 'm3', from: 'w1', to: 'w2', text: 'peer' } });
    const st = ctrl.getState();
    const systemLines = st.messages.filter((m) => m.role === 'system').map((m) => m.text);
    const msgLines = systemLines.filter((l) => /\[.* → .*\]/.test(l));
    assert.deepEqual(msgLines, ['[w1 → leader] hi'], '仅投递 lead 的 agent-message 入主会话');
    // 纯呈现事件:板/委派投影零变化(引用同一对象——分流未触达投影)
    assert.equal(st.board, boardBefore, 'agent-message 不影响板投影');
    assert.equal(st.delegations, delegBefore, 'agent-message 不影响委派投影');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
