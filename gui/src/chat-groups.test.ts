import { describe, it, expect } from 'vitest';
import { groupEntriesByDay } from './chat-groups';
import type { ChatEntry } from './chat-reducer';

const e = (key: string, ts?: number): ChatEntry => ({ key, kind: 'assistant', md: key, ...(ts !== undefined ? { ts } : {}) });
const NOW = new Date(2026, 9, 8, 12); // 2026-10-08
const d = (month: number, day: number, year = NOW.getFullYear()): number => new Date(year, month - 1, day, 10).getTime();

describe('groupEntriesByDay 日期分组', () => {
  it('同日条目归组,标签「M月D日周X」', () => {
    const g = groupEntriesByDay([e('a', d(10, 8)), e('b', d(10, 8))], NOW);
    expect(g).toHaveLength(1);
    expect(g[0]!.entries.map((x) => x.key)).toEqual(['a', 'b']);
    expect(g[0]!.label).toMatch(/10月8日周/);
  });

  it('跨日切组;无 ts 条目贴前组(首条无 ts 入无标组)', () => {
    const g = groupEntriesByDay([e('x', d(10, 7)), e('y'), e('z', d(10, 8))], NOW);
    expect(g).toHaveLength(2);
    expect(g[0]!.entries.map((x) => x.key)).toEqual(['x', 'y']);
    expect(g[0]!.label).toMatch(/10月7日周/);
  });

  it('跨年条目标签含年份', () => {
    const g = groupEntriesByDay([e('a', d(1, 10, NOW.getFullYear() - 1))], NOW);
    expect(g[0]!.label).toContain(`${NOW.getFullYear() - 1}年1月10日`);
  });

  it('全部无 ts:单一无标组(不渲染分隔行)', () => {
    const g = groupEntriesByDay([e('a'), e('b')], NOW);
    expect(g).toHaveLength(1);
    expect(g[0]!.label).toBe('');
  });
});
