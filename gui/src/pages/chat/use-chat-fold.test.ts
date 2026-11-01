import { describe, it, expect } from 'vitest';
import { collapsedHiddenKeys } from './use-chat-fold';
import type { ChatEntry } from '../../chat-reducer';

const e = (key: string, kind: ChatEntry['kind']): ChatEntry => ({ key, kind, md: '', ts: 0, seq: 0 } as unknown as ChatEntry);

describe('collapsedHiddenKeys 折叠区间边界', () => {
  it('user 条起新段:其后工具行不折进上一轮折叠区(2026-10-31「/compact 三态行不显示」钉)', () => {
    const entries = [e('r1', 'run'), e('t1', 'tool'), e('a1', 'assistant'), e('u2', 'user'), e('cmd', 'tool')];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('t1')).toBe(true); // 上一轮工具行按折叠隐藏
    expect(hidden.has('u2')).toBe(false); // 终答后的新开场用户条可见
    expect(hidden.has('cmd')).toBe(false); // 命令三态行(user 后)可见
  });
  it('斜杠命令行=系统提示行,即便落在折叠区内也不隐藏(2026-10-31 裁定「不受工具折叠影响」)', () => {
    const cmd = { ...e('cmd', 'tool'), name: '/compact' } as ChatEntry;
    const hidden = collapsedHiddenKeys([e('r1', 'run'), e('t1', 'tool'), cmd], new Set(['r1']));
    expect(hidden.has('t1')).toBe(true);
    expect(hidden.has('cmd')).toBe(false);
  });
  it('轮内插入用户条与成员消息随工具同行折叠;终答后新开场不折', () => {
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
    expect(hidden.has('u-ins')).toBe(true);
    expect(hidden.has('msg')).toBe(true);
    expect(hidden.has('n1')).toBe(false); // 普通旁白保留
    expect(hidden.has('t2')).toBe(true);
    expect(hidden.has('u2')).toBe(false);
  });
});
