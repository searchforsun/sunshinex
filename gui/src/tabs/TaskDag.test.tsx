import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { layoutTaskDag, default as TaskDag } from './TaskDag';
import type { BoardTask } from '../projection';

/**
 * 任务卡 DAG 组件测(React Flow/dagre 开源渲染,G14.2xx):
 * - layoutTaskDag 纯函数:LR 分层序(依赖在左)、START/END 起止边、缺依赖边忽略、环不炸、
 *   agent 有无的节点高差(布局步进)
 * - 组件面:节点=状态 aria-label `${id} [${status}] ${title}`(列表行同钩子)+🤖子代理名;
 *   点击仅「有执行子代理」的节点上抛 onTaskOpen(等待态不跳),START/END 无动作
 */

const task = (id: string, over: Partial<BoardTask> = {}): BoardTask => ({
  id,
  title: `任务${id}`,
  spec: '',
  status: 'pending',
  dependsOn: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('layoutTaskDag(纯函数)', () => {
  it('线性链 t1→t2→t3:rank 递增(LR 分层),起止边 START→t1/t3→END', () => {
    const tasks = [
      task('t1'),
      task('t2', { dependsOn: ['t1'] }),
      task('t3', { dependsOn: ['t2'] }),
    ];
    const { nodes, edges } = layoutTaskDag(tasks, () => '');
    const posOf = new Map(nodes.map((n) => [n.id, n.position.x]));
    expect(posOf.get('t1')!).toBeLessThan(posOf.get('t2')!);
    expect(posOf.get('t2')!).toBeLessThan(posOf.get('t3')!);
    const pairs = edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toContain('__start->t1');
    expect(pairs).toContain('t1->t2');
    expect(pairs).toContain('t2->t3');
    expect(pairs).toContain('t3->__end');
    expect(pairs).toHaveLength(4);
  });

  it('并行根各接 START;缺依赖(集合外引用)的边忽略视作根;汇点各接 END', () => {
    const tasks = [task('t1'), task('t2'), task('t3', { dependsOn: ['tX'] })];
    const { edges } = layoutTaskDag(tasks, () => '');
    const pairs = edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toContain('__start->t1');
    expect(pairs).toContain('__start->t2');
    expect(pairs).toContain('__start->t3'); // tX 不在集合内 → t3 视作根
    expect(pairs).toContain('t1->__end');
    expect(pairs).toContain('t2->__end');
    expect(pairs).toContain('t3->__end');
    expect(pairs.some((p) => p.includes('tX'))).toBe(false);
  });

  it('环数据不炸不挂:环成员仍成节点(dagre 割环兜底)', () => {
    const tasks = [task('t1', { dependsOn: ['t2'] }), task('t2', { dependsOn: ['t1'] })];
    const { nodes } = layoutTaskDag(tasks, () => '');
    expect(nodes.map((n) => n.id).sort()).toEqual(['__end', '__start', 't1', 't2']);
  });

  it('agent 有无决定节点高差(有代理行高/无代理行紧凑)', () => {
    const tasks = [task('t1'), task('t2', { dependsOn: ['t1'] })];
    const { nodes } = layoutTaskDag(tasks, (id) => (id === 't1' ? 'w1' : ''));
    const hOf = new Map(nodes.map((n) => [n.id, n.height]));
    expect(hOf.get('t1')).toBeGreaterThan(hOf.get('t2')!);
  });
});

describe('TaskDag 组件面', () => {
  const tasks = [
    task('t1', { title: '设计规格', status: 'claimed' }),
    task('t2', { title: '实现', status: 'pending', dependsOn: ['t1'], gated: true }),
    task('t3', { title: '评审', status: 'done', dependsOn: ['t2'] }),
  ];

  it('节点渲染:aria-label `${id} [${status}] ${title}` + 🤖执行子代理名,gated ⚠ 在场', () => {
    render(<TaskDag tasks={tasks} agentOf={(id) => (id === 't1' ? 'w1' : '')} />);
    expect(screen.getByLabelText('t1 [claimed] 设计规格')).not.toBeNull();
    expect(screen.getByLabelText('t2 [pending] 实现')).not.toBeNull();
    expect(screen.getByLabelText('t3 [done] 评审')).not.toBeNull();
    expect(screen.getByText('w1')).not.toBeNull(); // 执行子代理名上节点
    expect(screen.getAllByRole('img', { name: 'gate waiting' }).length).toBeGreaterThan(0); // gated ⚠
  });

  it('点击:有子代理的节点上抛 onTaskOpen;等待态(无代理)与 START/END 不上抛', () => {
    const onTaskOpen = vi.fn();
    const { container } = render(
      <TaskDag tasks={tasks} agentOf={(id) => (id === 't1' ? 'w1' : '')} onTaskOpen={onTaskOpen} />,
    );
    const nodeEl = (id: string): HTMLElement =>
      container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
    fireEvent.click(nodeEl('t1'));
    expect(onTaskOpen).toHaveBeenCalledTimes(1);
    expect(onTaskOpen).toHaveBeenCalledWith('t1');
    fireEvent.click(nodeEl('t2')); // 无代理:不可点
    fireEvent.click(nodeEl('__start'));
    fireEvent.click(nodeEl('__end'));
    expect(onTaskOpen).toHaveBeenCalledTimes(1);
  });
});
