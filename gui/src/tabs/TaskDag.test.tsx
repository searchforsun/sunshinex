import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { layoutTaskDag, default as TaskDag } from './TaskDag';
import type { BoardTask } from '../projection';
import { t } from '../i18n';

/**
 * 任务卡 DAG 组件测(React Flow/dagre 开源渲染,G14.2xx):
 * - layoutTaskDag 纯函数:LR 分层序(依赖在左)、START/END 起止边、缺依赖边忽略、环不炸、
 *   agent 有无的节点高差(布局步进)
 * - 组件面:节点=状态 aria-label `${id} [${status}] ${title}`(列表行同钩子)+🤖子智能体名;
 *   点击仅「有执行子智能体」的节点上抛 onTaskOpen(等待态不跳),START/END 无动作
 */

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

  it('dependsOn 实线；retryOf 虚线标重试且排在前驱之后', () => {
    const tasks = [
      task('t1', { status: 'failed' }),
      task('t2', { dependsOn: ['t1'] }),
      task('t3', { status: 'pending', retryOf: 't1' }),
    ];
    const { nodes, edges } = layoutTaskDag(tasks, () => '');
    const dep = edges.find((e) => e.source === 't1' && e.target === 't2');
    expect(dep?.className).toBe('tb-dag-dep');
    expect(dep?.animated).toBe(false);
    expect((dep?.style as { strokeDasharray?: string } | undefined)?.strokeDasharray).toBeUndefined();
    const retry = edges.find((e) => e.className === 'tb-dag-retry');
    expect(retry).toMatchObject({ source: 't1', target: 't3', label: t('Retry', '重试') });
    expect((retry?.style as { strokeDasharray?: string }).strokeDasharray).toBe('6 4');
    const pos = new Map(nodes.map((n) => [n.id, n.position.x]));
    expect(pos.get('t1')!).toBeLessThan(pos.get('t3')!);
    expect(edges.some((e) => e.source === '__start' && e.target === 't3')).toBe(false);
  });
});

describe('TaskDag 组件面', () => {
  const tasks = [
    task('t1', { title: '设计规格', status: 'running' }),
    task('t2', { title: '实现', status: 'pending', dependsOn: ['t1'] }),
    task('t3', { title: '评审', status: 'success', dependsOn: ['t2'] }),
  ];

  it('节点渲染:aria-label `${id} [${status}] ${title}` + 执行子智能体名；running/pending 有停钮', () => {
    render(<TaskDag tasks={tasks} agentOf={(id) => (id === 't1' ? 'w1' : '')} />);
    expect(screen.getByLabelText('t1 [running] 设计规格')).not.toBeNull();
    expect(screen.getByLabelText('t2 [pending] 实现')).not.toBeNull();
    expect(screen.getByLabelText('t3 [success] 评审')).not.toBeNull();
    expect(screen.getByText('w1')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Stop t1' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Stop t2' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop t3' })).toBeNull();
    expect(screen.queryByRole('img', { name: 'gate waiting' })).toBeNull();
  });

  it('点击:有子智能体的节点上抛 onTaskOpen;等待态(无代理)与 START/END 不上抛', () => {
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

  it('停钮上抛 onStopTask，不打开节点；cancelled 标题划线', () => {
    const onStopTask = vi.fn();
    const onTaskOpen = vi.fn();
    render(
      <TaskDag
        tasks={[
          task('t1', { title: '跑', status: 'running' }),
          task('t9', { title: '停了', status: 'cancelled' }),
        ]}
        agentOf={(id) => (id === 't1' ? 'w1' : '')}
        onTaskOpen={onTaskOpen}
        onStopTask={onStopTask}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop t1' }));
    expect(onStopTask).toHaveBeenCalledWith('t1');
    expect(onTaskOpen).not.toHaveBeenCalled();
    expect(screen.getByText('停了').className).toContain('tb-struck');
  });
});
