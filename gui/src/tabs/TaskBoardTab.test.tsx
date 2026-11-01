import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaskBoardTab } from './TaskBoardTab';
import type { BoardTask, TaskBoardState } from '../projection';

const task = (id: string, over: Partial<BoardTask> = {}): BoardTask => ({
  id,
  title: `任务${id}`,
  spec: '',
  status: 'pending',
  teamId: 'alpha',
  dependsOn: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const boardOf = (tasks: BoardTask[]): TaskBoardState => ({
  tasks: Object.fromEntries(tasks.map((item) => [item.id, item])),
  seq: tasks.length,
});

const teams = [
  { teamId: 'alpha', name: 'Alpha Squad', createdAt: 1 },
  { teamId: 'beta', name: 'Beta Squad', createdAt: 2 },
];

describe('TaskBoardTab 队卡', () => {
  it('按 teamId 分卡，卡头是快照团队名', () => {
    const { container } = render(
      <TaskBoardTab
        board={boardOf([
          task('t1', { teamId: 'alpha', title: '甲' }),
          task('t2', { teamId: 'beta', title: '乙', createdAt: 2 }),
        ])}
        delegations={[]}
        teams={teams}
      />,
    );
    const cards = [...container.querySelectorAll('.tb-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('.tb-team-name')?.textContent).toBe('Beta Squad');
    expect(cards[0]?.textContent).toContain('乙');
    expect(cards[1]?.querySelector('.tb-team-name')?.textContent).toBe('Alpha Squad');
    expect(cards[1]?.textContent).toContain('甲');
    expect(screen.queryByText('(no turn input)')).toBeNull();
    expect(screen.queryByText('(未关联轮次输入)')).toBeNull();
  });

  it('三分栏默认任务；成员|任务|编排可切换；成员行 click 触发 onOpenAgent', () => {
    const onOpenAgent = vi.fn();
    render(
      <TaskBoardTab
        board={boardOf([task('t1', { teamId: 'alpha', title: '甲' })])}
        delegations={[]}
        teams={[{ teamId: 'alpha', name: 'Alpha Squad', createdAt: 1 }]}
        members={[
          { name: 'w1', busy: false, teamId: 'alpha' },
          { name: 'w2', busy: true, teamId: 'beta' },
        ]}
        onOpenAgent={onOpenAgent}
      />,
    );
    const toggle = screen.getByRole('group', { name: 'task card view' });
    expect(toggle.querySelector('button.active')?.textContent).toMatch(/Tasks|任务/);
    expect(screen.getByRole('list', { name: 'task list' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Members|成员/ }));
    expect(screen.getByRole('list', { name: 'member list' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'w1' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /w2/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'w1' }));
    expect(onOpenAgent).toHaveBeenCalledWith('w1', 'w1');

    fireEvent.click(screen.getByRole('button', { name: /Orchestration|编排/ }));
    expect(document.querySelector('.tb-dag-wrap')).not.toBeNull();
  });

  it('成员空态「暂无成员」', () => {
    render(
      <TaskBoardTab
        board={boardOf([task('t1', { teamId: 'alpha', title: '甲' })])}
        delegations={[]}
        teams={[{ teamId: 'alpha', name: 'Alpha Squad', createdAt: 1 }]}
        members={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Members|成员/ }));
    expect(screen.getByText(/^No members|暂无成员$/)).toBeDefined();
  });

  it('失败任务无文字徽标，也无 Approve/Deny', () => {
    render(
      <TaskBoardTab
        board={boardOf([task('t1', { status: 'failed', title: '炸掉' })])}
        delegations={[]}
        teams={teams}
      />,
    );
    expect(screen.queryByText('failed')).toBeNull();
    expect(screen.queryByText('失败')).toBeNull();
    expect(screen.queryByText('cancelled')).toBeNull();
    expect(screen.queryByText('已取消')).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Deny/ })).toBeNull();
    expect(document.querySelector('.tb-status-dot.task-status-failed')).not.toBeNull();
  });

  it('cancelled 标题带划线 class', () => {
    render(
      <TaskBoardTab
        board={boardOf([task('t1', { status: 'cancelled', title: '停掉' })])}
        delegations={[]}
        teams={teams}
      />,
    );
    expect(screen.getByText('停掉').className).toContain('tb-struck');
    expect(document.querySelector('.tb-status-dot.task-status-cancelled')).not.toBeNull();
  });

  it('pending 与 running 有停钮并上抛 onStopTask；终态无停钮', () => {
    const onStopTask = vi.fn();
    render(
      <TaskBoardTab
        board={boardOf([
          task('t1', { status: 'pending', title: '等' }),
          task('t2', { status: 'running', title: '跑', createdAt: 2 }),
          task('t3', { status: 'success', title: '成', createdAt: 3 }),
        ])}
        delegations={[]}
        teams={teams}
        onStopTask={onStopTask}
      />,
    );
    expect(document.querySelector('.tb-status-dot.task-status-running')).not.toBeNull();
    expect(document.querySelector('.tb-status-dot.task-status-success')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop t1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop t2' }));
    expect(onStopTask.mock.calls).toEqual([['t1'], ['t2']]);
    expect(screen.queryByRole('button', { name: 'Stop t3' })).toBeNull();
  });
});

describe('智能体团队点色 class', () => {
  it('running 转圈、success 蓝点、cancelled 黄点规则挂在 task-status-* 上', () => {
    const cssPath = [resolve(process.cwd(), 'src/app.css'), resolve(process.cwd(), 'gui/src/app.css')].find((p) => {
      try { readFileSync(p); return true; } catch { return false; }
    });
    expect(cssPath, `app.css from ${process.cwd()}`).toBeDefined();
    const css = readFileSync(cssPath!, 'utf8');
    expect(css).toMatch(/\.tb-status-dot\.task-status-running\s*\{[^}]*animation:\s*sx-spin/);
    expect(css).toMatch(/\.tb-status-dot\.task-status-success\s*\{[^}]*var\(--accent\)/);
    expect(css).toMatch(/\.tb-status-dot\.task-status-cancelled\s*\{[^}]*#f5c542/);
    expect(css).toMatch(/\.tb-struck\s*\{[^}]*line-through/);
  });
});
