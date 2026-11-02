import { describe, it, expect } from 'vitest';
import { collapsedHiddenKeys } from './use-chat-fold';
import type { ChatEntry } from '../../chat-reducer';

const e = (key: string, kind: ChatEntry['kind']): ChatEntry => ({ key, kind, md: '', ts: 0, seq: 0 } as unknown as ChatEntry);

describe('collapsedHiddenKeys 折叠区间边界', () => {
  it('user 条起新段:其后工具行不折进上一轮折叠区(2026-10-31「/compact 三态行不显示」钉)', () => {
    // 新开场后下一帧必先 model-start(=r2);前瞻见 run 即判定非轮内插入
    const entries = [e('r1', 'run'), e('t1', 'tool'), e('a1', 'assistant'), e('u2', 'user'), e('r2', 'run'), e('t2', 'tool')];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('t1')).toBe(true); // 上一轮工具行按折叠隐藏
    expect(hidden.has('u2')).toBe(false); // 终答后的新开场用户条可见
    expect(hidden.has('t2')).toBe(false); // 新 run 未折叠→其后工具可见
  });
  it('斜杠命令行=系统提示行,即便落在折叠区内也不隐藏(2026-10-31 裁定「不受工具折叠影响」)', () => {
    const cmd = { ...e('cmd', 'tool'), name: '/compact' } as ChatEntry;
    const hidden = collapsedHiddenKeys([e('r1', 'run'), e('t1', 'tool'), cmd], new Set(['r1']));
    expect(hidden.has('t1')).toBe(true);
    expect(hidden.has('cmd')).toBe(false);
  });
  it('轮内插入不上折叠行且不复位 hide:其后工具/成员消息仍折;终答后新开场不折', () => {
    const insert = e('u-ins', 'user');
    const peer = { ...e('msg', 'notice'), md: '[w1 → lead] 做完了' } as ChatEntry;
    const other = { ...e('n1', 'notice'), md: 'hello' } as ChatEntry;
    const entries = [
      e('r1', 'run'),
      e('t1', 'tool'),
      insert,
      peer,
      other,
      e('t2', 'tool'),
      e('a1', 'assistant'),
      e('u2', 'user'),
    ];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('t1')).toBe(true);
    expect(hidden.has('u-ins')).toBe(false); // 插入可见、不进折叠行
    expect(hidden.has('msg')).toBe(true); // 插入后成员消息仍折
    expect(hidden.has('n1')).toBe(false); // 普通旁白保留
    expect(hidden.has('t2')).toBe(true); // 插入后工具仍折(不因插入复位 hide)
    expect(hidden.has('u2')).toBe(false);
  });
  it('记忆/技能沉淀旁白随工具进折叠行;普通 notice 保留', () => {
    const mem = { ...e('m1', 'notice'), md: '[memory] saved: foo-bar' } as ChatEntry;
    const skill = { ...e('s1', 'notice'), md: '[skills] learned: baz' } as ChatEntry;
    const memUp = { ...e('m2', 'notice'), md: '[memory] updated: foo-bar, qux' } as ChatEntry;
    const plain = { ...e('n1', 'notice'), md: 'hello' } as ChatEntry;
    const entries = [e('r1', 'run'), e('t1', 'tool'), mem, skill, memUp, plain, e('a1', 'assistant')];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('m1')).toBe(true);
    expect(hidden.has('s1')).toBe(true);
    expect(hidden.has('m2')).toBe(true);
    expect(hidden.has('n1')).toBe(false);
    expect(hidden.has('t1')).toBe(true);
  });
  it('正文后轮内插入:前瞻见后续工具→不上折叠行且后续工具仍折', () => {
    const entries = [
      e('r1', 'run'),
      e('t1', 'tool'),
      e('a1', 'assistant'),
      e('u-ins', 'user'),
      e('think', 'thinking'),
      e('t2', 'tool'),
      e('a2', 'assistant'),
    ];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('u-ins')).toBe(false);
    expect(hidden.has('t1')).toBe(true);
    expect(hidden.has('think')).toBe(true);
    expect(hidden.has('t2')).toBe(true);
    expect(hidden.has('a1')).toBe(true); // 中间正文随折
    expect(hidden.has('a2')).toBe(false); // 末条终答保留
  });
});
