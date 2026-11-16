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
    expect(run?.artifacts).toEqual([{ kind: 'file', path: 'docs/report.md', source: 'write', callId: 'c1' }]);

    const s2 = fold([ev('model-start'), ev('done', 'x'), ev('runmeta', undefined, { seconds: 1 })]);
    expect(s2.entries.find((e) => e.kind === 'run')?.artifacts).toBeUndefined();
  });

  it('跨轮声明遮蔽(2026-11-16 用户实测同文件声明卡+自动卡并存,裁定「主动注册的应该大于解析出来的」):落盘轮自动卡+声明轮声明卡同 key 并存→自动卡隐去,声明轮显声明版', () => {
    const s = fold([
      ev('model-start'),
      ev('done', 'a'),
      ev('runmeta', undefined, { seconds: 5, artifacts: [{ kind: 'file', path: 'analysis/01-x.md', source: 'bash' }] }),
      ev('model-start'),
      ev('done', 'b'),
      ev('runmeta', undefined, { seconds: 3, artifacts: [{ kind: 'file', path: 'analysis/01-x.md', source: 'tool', title: '分析报告', desc: '只读分析报告。' }] }),
    ]);
    const runs = s.entries.filter((e) => e.kind === 'run');
    expect(runs).toHaveLength(2);
    expect(runs[0]?.artifacts).toBeUndefined(); // 落盘轮自动卡被声明遮蔽→整卡隐去(该轮无其余产物=无卡区)
    expect(runs[1]?.artifacts).toEqual([{ kind: 'file', path: 'analysis/01-x.md', source: 'tool', title: '分析报告', desc: '只读分析报告。' }]);
  });

  it('遮蔽与轮序无关:声明轮在前、落盘轮在后→后轮同 key 自动卡同样隐去;不同 key 互不波及', () => {
    const s = fold([
      ev('model-start'),
      ev('done', 'a'),
      ev('runmeta', undefined, { seconds: 2, artifacts: [{ kind: 'file', path: 'docs/a.md', source: 'tool', title: 'A' }] }),
      ev('model-start'),
      ev('done', 'b'),
      ev('runmeta', undefined, { seconds: 4, artifacts: [
        { kind: 'file', path: 'docs/a.md', source: 'write' }, // 同 key 自动卡→遮
        { kind: 'file', path: 'docs/b.md', source: 'bash' }, // 不同 key→留
      ] }),
    ]);
    const runs = s.entries.filter((e) => e.kind === 'run');
    expect(runs[0]?.artifacts).toEqual([{ kind: 'file', path: 'docs/a.md', source: 'tool', title: 'A' }]);
    expect(runs[1]?.artifacts).toEqual([{ kind: 'file', path: 'docs/b.md', source: 'bash' }]);
  });
});
