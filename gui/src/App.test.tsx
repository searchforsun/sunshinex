import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ReactElement } from 'react';
import { App } from './App';
import type { SnapshotResponse } from './connection';

/** 假 snapshot（形态对齐 T1 /snapshot 载荷）：三类转录条目 + 三个任务（t10 验数值序） */
const fake: SnapshotResponse = {
  messages: [
    { seq: 1, ts: 1000, kind: 'user', md: '> build the widget' },
    { seq: 2, ts: 2000, kind: 'tool', md: '● read\n⎿ ok' },
    { seq: 3, ts: 3000, kind: 'assistant', md: 'widget built' },
  ],
  board: {
    tasks: {
      t10: { id: 't10', title: 'Ten', spec: '', status: 'done', dependsOn: [], createdAt: 1, updatedAt: 1 },
      t2: { id: 't2', title: 'Beta', spec: '', status: 'claimed', dependsOn: ['t1'], createdAt: 1, updatedAt: 1 },
      t1: { id: 't1', title: 'Alpha', spec: '', status: 'pending', dependsOn: [], createdAt: 1, updatedAt: 1 },
    },
    seq: 10,
  },
  delegations: [],
  status: 'running',
};

function ui(): ReturnType<typeof render> {
  return render(<App snapshot={fake} /> as ReactElement);
}

describe('gui App（纯 snapshot 渲染骨架）', () => {
  it('顶栏渲染 status 圆点与文字', () => {
    ui();
    expect(screen.getByText('running')).toBeDefined();
    expect(screen.getByLabelText('status: running')).toBeDefined();
  });

  it('转录列表渲染三类条目行（[user]/[tool]/[assistant] 纯文本）', () => {
    ui();
    expect(screen.getByText('[user] > build the widget')).toBeDefined();
    // testing-library 默认 normalizer 将换行折叠为单空格，故以空格形态断言多行 md
    expect(screen.getByText('[tool] ● read ⎿ ok')).toBeDefined();
    expect(screen.getByText('[assistant] widget built')).toBeDefined();
  });

  it('板列表渲染 id [status] title 行且按数值序（t1, t2, t10）', () => {
    const { container } = ui();
    const board = within(screen.getByLabelText('board'));
    expect(board.getByText('t1 [pending] Alpha')).toBeDefined();
    expect(board.getByText('t2 [claimed] Beta')).toBeDefined();
    expect(board.getByText('t10 [done] Ten')).toBeDefined();
    const rows = Array.from(container.querySelectorAll('.board .task')).map((el) => el.textContent);
    expect(rows).toEqual(['t1 [pending] Alpha', 't2 [claimed] Beta', 't10 [done] Ten']);
  });
});
