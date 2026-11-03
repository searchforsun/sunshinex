import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TodoCardsTab } from './TodoCardsTab';
import type { TodoBatch } from '../pages/Chat';
import type { Connection } from '../connection';

/** 待办卡主名字定位(2026-11-03):点 goal=定位回调(不触发折叠 toggle);无 userKey 不可点;
 *  头部其余区域点击仍走展开/折叠。 */
const connStub = (() => ({})) as unknown as Connection;

const batch = (over: Partial<TodoBatch>): TodoBatch => ({
  key: 'k3', ts: 1, goal: '测试一下电脑操作',
  items: [{ text: '只读巡览', status: 'completed' }], ...over,
});

describe('TodoCardsTab 主名字定位', () => {
  it('点主名字 → onLocate(批次),且不触发折叠 toggle;头部其余区域仍 toggle', () => {
    const onLocate = vi.fn();
    const { container } = render(
      <TodoCardsTab batches={[batch({ key: 'k3', userKey: 'k1' })]} conn={connStub} sessionId="s1" onLocate={onLocate} />,
    );
    const goal = container.querySelector<HTMLElement>('.todo-card-goal.todo-card-goal-link')!;
    expect(goal).not.toBeNull();
    expect(goal.textContent).toContain('测试一下电脑操作');
    fireEvent.click(goal);
    expect(onLocate).toHaveBeenCalledWith(expect.objectContaining({ userKey: 'k1', goal: '测试一下电脑操作' }));
    // 定位点击不折叠(展开态保持;首批缺省展开)
    expect(container.querySelector('.todo-card-list')).not.toBeNull();
    // 头部 chevron 区(非 goal)点击 → 折叠
    fireEvent.click(container.querySelector('.todo-card-head')!);
    expect(container.querySelector('.todo-card-list')).toBeNull();
  });

  it('旧投影无 userKey:主名字不带定位态,点击不回调', () => {
    const onLocate = vi.fn();
    const { container } = render(<TodoCardsTab batches={[batch({})]} conn={connStub} sessionId="s1" onLocate={onLocate} />);
    expect(container.querySelector('.todo-card-goal-link')).toBeNull();
    fireEvent.click(container.querySelector('.todo-card-goal')!);
    expect(onLocate).not.toHaveBeenCalled();
  });
});
