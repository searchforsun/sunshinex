import { describe, it, expect } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { TodoCardsTab } from './TodoCardsTab';
import { mergeTodoBatches } from '../pages/chat/tool-entry-data';
import type { TodoBatch } from '../pages/Chat';
import type { Connection } from '../connection';

/** 待办页签=一个待办一卡（2026-11-25 用户裁定「一个待办可以跨多个轮次:给待办一个标题参数,
 *  代替用户输入信息」——同标题跨轮更新归并同一卡；goal/userKey 用户气泡回链退役）。 */
const connStub = (snapBatches?: TodoBatch[]) => ({
  sessionSnapshot: () => Promise.resolve({ todoBatches: snapBatches ?? [] }),
}) as unknown as Connection;

const batch = (over: Partial<TodoBatch>): TodoBatch => ({
  key: 'k3', ts: 1,
  items: [{ text: '只读巡览', status: 'completed' }, { text: '推进下一步', status: 'in_progress' }], ...over,
});

describe('mergeTodoBatches 跨轮归并', () => {
  it('同标题多批=同一待办:首写 key/ts 落定,items/updatedTs 取最新', () => {
    const merged = mergeTodoBatches([
      batch({ key: 'k1', ts: 10, updatedTs: 10, title: 'Offline flink', items: [{ text: 'A', status: 'pending' }] }),
      batch({ key: 'k2', ts: 20, updatedTs: 20, title: 'Offline flink', items: [{ text: 'A (reworded)', status: 'in_progress' }] }),
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.key).toBe('k1');
    expect(merged[0]!.ts).toBe(10);
    expect(merged[0]!.updatedTs).toBe(20);
    expect(merged[0]!.items).toEqual([{ text: 'A (reworded)', status: 'in_progress' }]);
  });

  it('不同标题=不同待办;无标题退条目签名归并;按 updatedTs 升序(末位=最近更新)', () => {
    const merged = mergeTodoBatches([
      batch({ key: 'k1', ts: 10, updatedTs: 10, title: 'One', items: [{ text: 'A', status: 'pending' }] }),
      batch({ key: 'k2', ts: 20, updatedTs: 30, title: 'Two', items: [{ text: 'B', status: 'pending' }] }),
      batch({ key: 'k3', ts: 40, updatedTs: 40, items: [{ text: 'C', status: 'pending' }] }),
      batch({ key: 'k4', ts: 50, updatedTs: 50, items: [{ text: 'C', status: 'completed' }] }),
    ]);
    expect(merged.map((b) => b.title ?? '')).toEqual(['One', 'Two', '']);
    expect(merged[2]!.items[0]!.status).toBe('completed'); // 无标题同签名更新收敛
  });
});

describe('TodoCardsTab 一待办一卡', () => {
  it('卡头显示待办标题 + 进度 chip;无用户气泡回链钮;头部点击展开/折叠', () => {
    const { container } = render(<TodoCardsTab batches={[batch({ title: 'Offline flink' })]} conn={connStub()} sessionId="s1" />);
    expect(container.querySelectorAll('.todo-card').length).toBe(1);
    expect(container.querySelector('.todo-card-count')!.textContent).toBe('1/2');
    expect(container.querySelector('.todo-card-goal')!.textContent).toContain('Offline flink');
    expect(container.querySelector('.todo-card-goal-link')).toBeNull();
    expect(container.querySelector('.todo-card-list')).not.toBeNull(); // 最新待办缺省展开
    fireEvent.click(container.querySelector('.todo-card-head')!);
    expect(container.querySelector('.todo-card-list')).toBeNull();
  });

  it('同标题跨轮多批入参 → 仍一卡（页签自身归并口径）', () => {
    const older = batch({ key: 'k1', ts: 10, updatedTs: 10, title: 'Offline flink', items: [{ text: '旧', status: 'pending' }] });
    const latest = batch({ key: 'k9', ts: 20, updatedTs: 20, title: 'Offline flink' });
    const { container } = render(<TodoCardsTab batches={[older, latest]} conn={connStub()} sessionId="s1" />);
    expect(container.querySelectorAll('.todo-card').length).toBe(1);
    expect(container.querySelector('.todo-card-goal')!.textContent).toContain('Offline flink');
  });

  it('刷新快照带同标题历史批次 → 归并为一卡（当前清单口径）', async () => {
    const older = batch({ key: 'k1', ts: 10, updatedTs: 10, title: 'Offline flink', items: [{ text: '旧批次', status: 'completed' }] });
    const latest = batch({ key: 'k9', ts: 20, updatedTs: 20, title: 'Offline flink' });
    const { container } = render(<TodoCardsTab batches={[]} conn={connStub([older, latest])} sessionId="s1" refreshNonce={1} />);
    await waitFor(() => expect(container.querySelectorAll('.todo-card').length).toBe(1));
    expect(container.querySelector('.todo-card-count')!.textContent).toBe('1/2'); // 最新批 1/2
  });

  it('无待办空态', () => {
    const { container } = render(<TodoCardsTab batches={[]} conn={connStub()} sessionId="s1" />);
    expect(container.querySelector('.todo-card')).toBeNull();
    expect(container.textContent).toMatch(/暂无待办|No todos yet/);
  });
});
