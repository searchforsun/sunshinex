import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ScheduleRuns } from './ScheduleRuns';
import type { Connection, ScheduleJobView, ScheduleRunStatus, ScheduleRunView } from '../connection';

/** 双语容忍正解(D37 家族):产品面 t() 化,测试环境钉 en,单语钉必脆 */
const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

const job = { id: 'j1', name: '仓库巡检', prompt: 'p', root: 'default', effort: 'high', mode: 'full-access', recurrence: { unit: 'day', every: 1, at: '09:00' }, startAt: 1, enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: 2, runCount: 2 } as ScheduleJobView;
const runs: ScheduleRunView[] = [
  { id: 'r1', trigger: 'schedule', startedAt: 1, endedAt: 2, status: 'succeeded', journalId: 'jid1', root: '/p', seconds: 3 },
  { id: 'r2', trigger: 'schedule', startedAt: 1, endedAt: 2, status: 'failed', journalId: 'jid2', root: '/p', error: '429' },
];

let seq = 0;
/** 运行行工厂:缺省成功+可跳转,单测只 patch 关心的字段 */
function makeRun(patch: Partial<ScheduleRunView> = {}): ScheduleRunView {
  seq += 1;
  return {
    id: `run-${seq}`,
    trigger: 'schedule',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_100,
    status: 'succeeded',
    journalId: `jid-${seq}`,
    root: '/p',
    seconds: 3,
    ...patch,
  };
}

function makeConn(rows: ScheduleRunView[]) {
  const scheduleRuns = vi.fn(async () => ({ runs: rows }));
  return { conn: { scheduleRuns } as unknown as Connection, scheduleRuns };
}

describe('ScheduleRuns', () => {
  it('项目状态点 + 打开会话', async () => {
    const scheduleRuns = vi.fn(async () => ({ runs }));
    const conn = { scheduleRuns } as unknown as Connection;
    const onOpenSession = vi.fn();
    const { container } = render(<ScheduleRuns conn={conn} job={job} onOpenSession={onOpenSession} />);
    await waitFor(() => expect(conn.scheduleRuns).toHaveBeenCalledWith('j1'));
    const dots = container.querySelectorAll('.tb-status-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0]!.className).toContain('task-status-success');
    expect(dots[1]!.className).toContain('task-status-failed');
    fireEvent.click(screen.getAllByRole('button', { name: /Open session|打开会话/ })[0]!);
    expect(onOpenSession).toHaveBeenCalledWith('jid1', '/p');
  });

  it('六态映射到项目 tb-status-dot 类;失败原因 err 色、中断原因灰字', async () => {
    const statuses: ScheduleRunStatus[] = ['succeeded', 'failed', 'skipped', 'interrupted', 'stopped', 'running'];
    const dotClass: Record<ScheduleRunStatus, string> = {
      succeeded: 'task-status-success',
      failed: 'task-status-failed',
      skipped: 'task-status-cancelled',
      interrupted: 'task-status-cancelled',
      stopped: 'task-status-cancelled',
      running: 'task-status-running',
    };
    const label: Record<ScheduleRunStatus, RegExp> = {
      succeeded: bi('Succeeded', '成功'),
      failed: bi('Failed', '失败'),
      skipped: bi('Skipped', '跳过'),
      interrupted: bi('Interrupted', '已中断'),
      stopped: bi('Stopped', '已停止'),
      running: bi('Running', '运行中'),
    };
    const rows = statuses.map((status) =>
      makeRun({
        status,
        ...(status === 'failed' ? { error: '429' } : {}),
        ...(status === 'interrupted' ? { error: 'interrupted by stop' } : {}),
      }),
    );
    const { conn } = makeConn(rows);
    const { container } = render(<ScheduleRuns conn={conn} job={job} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(container.querySelectorAll('.tb-status-dot')).toHaveLength(6));
    const dots = Array.from(container.querySelectorAll('.tb-status-dot'));
    statuses.forEach((status, i) => {
      expect(dots[i]!.className).toContain(dotClass[status]);
      expect(screen.getByText(label[status])).toBeDefined();
    });
    expect(screen.getByText('429').className).toContain('sx-schedule-err');
    expect(screen.getByText('interrupted by stop').className).toContain('sx-schedule-note');
  });

  it('触发方式三值中英标签', async () => {
    const rows = [
      makeRun({ trigger: 'schedule' }),
      makeRun({ trigger: 'catch-up' }),
      makeRun({ trigger: 'manual' }),
    ];
    const { conn } = makeConn(rows);
    render(<ScheduleRuns conn={conn} job={job} onOpenSession={vi.fn()} />);
    expect(await screen.findByText(bi('Schedule', '定时'))).toBeDefined();
    expect(screen.getByText(bi('Catch-up', '补跑'))).toBeDefined();
    expect(screen.getByText(bi('Manual', '手动'))).toBeDefined();
    // 表头 Scheduled 不得被触发方式的短词误配
    expect(screen.getByText(bi('Scheduled', '计划时间'))).toBeDefined();
  });

  it('无 journalId 的行不出打开钮,会话格为 —', async () => {
    const { conn, scheduleRuns } = makeConn([makeRun({ journalId: undefined })]);
    const { container } = render(<ScheduleRuns conn={conn} job={job} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(scheduleRuns).toHaveBeenCalledWith('j1'));
    expect(screen.queryByRole('button', { name: /Open session|打开会话/ })).toBeNull();
    const cells = container.querySelectorAll('tbody tr td');
    expect(cells[cells.length - 1]!.textContent).toBe('—');
  });

  it('耗时按时分秒显示：222 秒→3 分 42 秒，整时带时，不足分钟只出秒', async () => {
    const { conn } = makeConn([
      makeRun({ seconds: 222 }),
      makeRun({ seconds: 3725 }),
      makeRun({ seconds: 3 }),
    ]);
    render(<ScheduleRuns conn={conn} job={job} onOpenSession={vi.fn()} />);
    expect(await screen.findByText(bi('3 min 42 s', '3 分 42 秒'))).toBeDefined();
    expect(screen.getByText(bi('1 h 2 min 5 s', '1 时 2 分 5 秒'))).toBeDefined();
    expect(screen.getByText(bi('3 s', '3 秒'))).toBeDefined();
  });

  it('补跑延迟 >60s 显示灰色延迟注记,未延迟不显示', async () => {
    const scheduledAt = 1_700_000_000_000;
    const rows = [
      makeRun({ trigger: 'catch-up', scheduledAt, startedAt: scheduledAt + 5 * 60_000, endedAt: scheduledAt + 6 * 60_000 }),
      makeRun({ scheduledAt, startedAt: scheduledAt + 30_000, endedAt: scheduledAt + 40_000 }),
    ];
    const { conn } = makeConn(rows);
    const { container } = render(<ScheduleRuns conn={conn} job={job} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(container.querySelectorAll('.sx-schedule-note')).toHaveLength(1));
    const note = container.querySelector('.sx-schedule-note')!;
    expect(note.textContent).toMatch(/Late 5 min|延迟 5 分钟/);
  });

  it('加载中文案 → 空态文案', async () => {
    const { conn } = makeConn([]);
    const { container } = render(<ScheduleRuns conn={conn} job={job} onOpenSession={vi.fn()} />);
    expect(screen.getByText(bi('Loading…', '加载中…'))).toBeDefined();
    expect(await screen.findByText(bi('No runs yet', '暂无执行记录'))).toBeDefined();
    expect(container.querySelector('table')).toBeNull();
  });

  it('取数失败:role=alert 内联错误,不再挂加载态', async () => {
    const scheduleRuns = vi.fn(async () => {
      throw new Error('boom');
    });
    const conn = { scheduleRuns } as unknown as Connection;
    const { container } = render(<ScheduleRuns conn={conn} job={job} onOpenSession={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('boom');
    expect(screen.queryByText(bi('Loading…', '加载中…'))).toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });

  it('轮询刷新：running 行在后续 tick 转 succeeded，刷新在途保留旧行不闪加载态', async () => {
    let release!: (v: { runs: ScheduleRunView[] }) => void;
    const scheduleRuns = vi
      .fn()
      .mockResolvedValueOnce({ runs: [makeRun({ status: 'running' })] })
      .mockImplementationOnce(() => new Promise<{ runs: ScheduleRunView[] }>((r) => { release = r; }));
    const conn = { scheduleRuns } as unknown as Connection;
    const { rerender } = render(<ScheduleRuns conn={conn} job={job} onOpenSession={vi.fn()} tick={0} />);
    expect(await screen.findByText(bi('Running', '运行中'))).toBeDefined();

    rerender(<ScheduleRuns conn={conn} job={job} onOpenSession={vi.fn()} tick={1} />);
    expect(screen.getByText(bi('Running', '运行中'))).toBeDefined(); // 旧行保留
    expect(screen.queryByText(bi('Loading…', '加载中…'))).toBeNull();
    expect(scheduleRuns).toHaveBeenCalledTimes(2);

    await act(async () => {
      release({ runs: [makeRun({ status: 'succeeded' })] });
    });
    expect(await screen.findByText(bi('Succeeded', '成功'))).toBeDefined();
    expect(screen.queryByText(bi('Running', '运行中'))).toBeNull();
  });

  it('未知状态/触发值：原样标签 + 灰点，不崩', async () => {
    const rows = [makeRun({ status: 'future-state' as ScheduleRunStatus, trigger: 'weird' as ScheduleRunView['trigger'] })];
    const { conn } = makeConn(rows);
    const { container } = render(<ScheduleRuns conn={conn} job={job} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(container.querySelectorAll('.tb-status-dot')).toHaveLength(1));
    const dot = container.querySelector('.tb-status-dot')!;
    expect(dot.className).toContain('task-status-cancelled');
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('future-state')).toBeDefined();
    expect(screen.getByText('weird')).toBeDefined();
  });

  it('打开钮按行传 journalId + root', async () => {
    const onOpenSession = vi.fn();
    const { conn } = makeConn([
      makeRun({ journalId: 'jid-a', root: '/w/a' }),
      makeRun({ journalId: 'jid-b', root: '/w/b' }),
    ]);
    render(<ScheduleRuns conn={conn} job={job} onOpenSession={onOpenSession} />);
    const buttons = await screen.findAllByRole('button', { name: /Open session|打开会话/ });
    fireEvent.click(buttons[1]!);
    expect(onOpenSession).toHaveBeenCalledWith('jid-b', '/w/b');
  });

  it('目标列：SUNX 记录展示类型+名字；打开会话带 kind=sunx（2026-11-21）', async () => {
    const { conn } = makeConn([
      makeRun({ target: 'sunx', targetLabel: '运维助手', journalId: 'jsx', root: 'D:/sunx-domain' }),
      makeRun({ target: 'channel', targetLabel: '飞书 · 项目群', journalId: 'jch', root: 'D:/chan-domain' }),
    ]);
    const onOpenSession = vi.fn();
    render(<ScheduleRuns conn={conn} job={job} onOpenSession={onOpenSession} />);
    expect(await screen.findByText('SUNX')).toBeDefined();
    expect(screen.getByText('运维助手')).toBeDefined();
    expect(screen.getByText('飞书 · 项目群')).toBeDefined();
    fireEvent.click(screen.getAllByRole('button', { name: /Open session|打开会话/ })[0]!);
    expect(onOpenSession).toHaveBeenCalledWith('jsx', 'D:/sunx-domain', 'sunx');
  });
});
