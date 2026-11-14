import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionEvent } from '../../src/types';
import { applyChatEvent, initialChatState } from './chat-reducer';
import { setLanguage } from './i18n';

/** D37 家族先例(App.test):产品面 t() 化后钉 en 防跨文件/前序用例语言泄漏——固定头语言面用例显式翻语言 */
beforeEach(() => setLanguage('en'));

/** runmeta.artifacts 摄入(2026-11-12 spec §4.4):内核 runmeta 帧透传→run 条直映;空/缺省不落字段 */

let ts = 0;
function ev(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent {
  return { type, text, payload, ts: ++ts };
}
function fold(events: SessionEvent[], start = initialChatState()) {
  return events.reduce(applyChatEvent, start);
}

describe('runmeta.artifacts 摄入', () => {
  it('artifacts 直映 run 条;缺省不落字段', () => {
    const s = fold([
      ev('model-start'),
      ev('token', 'hi'),
      ev('done', 'hi'),
      ev('runmeta', undefined, { seconds: 2, artifacts: [{ path: 'docs/report.md', source: 'write', callId: 'c1' }] }),
    ]);
    const run = s.entries.find((e) => e.kind === 'run');
    expect(run?.artifacts).toEqual([{ path: 'docs/report.md', source: 'write', callId: 'c1' }]);

    const s2 = fold([ev('model-start'), ev('done', 'x'), ev('runmeta', undefined, { seconds: 1 })]);
    expect(s2.entries.find((e) => e.kind === 'run')?.artifacts).toBeUndefined();
  });
});
