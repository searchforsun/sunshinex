import { describe, it, expect } from 'vitest';
import { collapsedHiddenKeys } from './use-chat-fold';
import type { ChatEntry } from '../../chat-reducer';

const e = (key: string, kind: ChatEntry['kind']): ChatEntry => ({ key, kind, md: '', ts: 0, seq: 0 } as unknown as ChatEntry);

describe('collapsedHiddenKeys 折叠区间边界', () => {
  it('user 条起新段:其后工具行不折进上一轮折叠区(2026-10-31「/compact 三态行不显示」钉)', () => {
    const entries = [e('r1', 'run'), e('t1', 'tool'), e('a1', 'assistant'), e('u2', 'user'), e('cmd', 'tool')];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('t1')).toBe(true); // 上一轮工具行按折叠隐藏
    expect(hidden.has('cmd')).toBe(false); // 命令三态行(user 后)可见
  });
});
