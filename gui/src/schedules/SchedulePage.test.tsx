import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SchedulePage } from './SchedulePage';
import type { Connection, ScheduleJobView } from '../connection';

/** 双语容忍正解(D37 家族):产品面 t() 化,测试环境钉 en,单语钉必脆 */
const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

function job(over: Partial<ScheduleJobView> = {}): ScheduleJobView {
  return {
    id: 'j1', name: '仓库巡检', prompt: '检查昨天以来的提交与 CI', root: 'default', effort: 'high', mode: 'full-access',
    recurrence: { unit: 'day', every: 1, at: '09:00' }, startAt: Date.now(), enabled: true,
    createdAt: 1, updatedAt: 1, nextRunAt: Date.now() + 3_600_000, runCount: 0, ...over,
  };
}

function lastRun(status: 'running' | 'succeeded' | 'failed'): NonNullable<ScheduleJobView['lastRun']> {
  return { id: `run-${status}`, trigger: 'schedule', startedAt: 1, status, root: 'default' };
}

/** 页面 conn 桩:列表 read 面+开关/删除/立即执行/记录四写面+配置页回源(workspaces/预览/建改)。
 *  写面返回具名 mock,断言 read 面零强转。 */
function makeConn(jobs: ScheduleJobView[]) {
  const schedules = vi.fn(async () => ({ now: Date.now(), defaultModel: 'DeepSeek', jobs }));
  const setScheduleEnabled = vi.fn(async (id: string, enabled: boolean) => ({
    ...job({ id }),
    enabled,
    nextRunAt: enabled ? Date.now() + 60_000 : null,
  }));
  const deleteSchedule = vi.fn(async () => ({ ok: true as const }));
  const runScheduleNow = vi.fn(async () => ({ ok: true as const, runId: 'run-1' }));
  const scheduleRuns = vi.fn(async () => ({ runs: [] }));
  const workspaces = vi.fn(async () => [{ slug: 'default', root: 'default', sessionCount: 0 }]);
  const createSchedule = vi.fn(async () => job({ id: 'new' }));
  const updateSchedule = vi.fn(async () => job());
  const previewSchedule = vi.fn(async () => ({ next: [Date.now() + 60_000] }));
  const conn = {
    schedules,
    setScheduleEnabled,
    deleteSchedule,
    runScheduleNow,
    scheduleRuns,
    workspaces,
    createSchedule,
    updateSchedule,
    previewSchedule,
  } as unknown as Connection;
  return {
    conn,
    schedules,
    setScheduleEnabled,
    deleteSchedule,
    runScheduleNow,
    scheduleRuns,
    createSchedule,
    updateSchedule,
    previewSchedule,
  };
}

describe('SchedulePage 列表', () => {
  /** jsdom 无 scrollIntoView：全 describe 挂 spy（保存/取消定位断言用），逐例清理 */
  const scrollSpy = vi.fn();
  beforeEach(() => {
    (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = scrollSpy;
  });
  afterEach(() => {
    scrollSpy.mockClear();
    delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('两列三行卡片：名称/内容/倒计时 + 首行开关；开关调 enabled', async () => {
    const { conn, setScheduleEnabled, scheduleRuns } = makeConn([
      job(),
      job({ id: 'j2', name: '依赖升级', prompt: '升级依赖并跑测试', enabled: false, nextRunAt: null }),
    ]);
    const { container } = render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    expect(await screen.findByText('仓库巡检')).toBeDefined();
    expect(screen.getByText('检查昨天以来的提交与 CI')).toBeDefined();
    expect(screen.getByText('升级依赖并跑测试')).toBeDefined();
    // 两列网格 + 每卡四行(首行开关/名称/…；目标类型；内容；倒计时)——2026-11-21 增目标行
    expect(container.querySelector('.sx-schedule-grid')).not.toBeNull();
    const cards = Array.from(container.querySelectorAll('.sx-schedule-card'));
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(card.children).toHaveLength(4);
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    expect(switches[0]!.getAttribute('aria-checked')).toBe('true');
    expect(switches[1]!.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(switches[0]!);
    await waitFor(() => expect(setScheduleEnabled).toHaveBeenCalledWith('j1', false));
    // 开关 stopPropagation:不误触卡体跳执行记录
    expect(scheduleRuns).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Back|返回/ })).toBeNull();
  });

  it('搜索落点 focusJobId:任务清单落定后定位该卡(短高亮+滚入视野)', async () => {
    const { conn } = makeConn([job(), job({ id: 'j2', name: '依赖升级', prompt: '升级依赖并跑测试' })]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} focusJobId="j2" />);
    await screen.findByText('依赖升级');
    await waitFor(() => expect(screen.getByText('依赖升级').closest('.sx-schedule-card')!.className).toContain('is-focus'));
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('卡片主体 → 执行记录；「…」菜单 → 编辑/立即执行/删除', async () => {
    const { conn, scheduleRuns, runScheduleNow } = makeConn([job()]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    fireEvent.click(await screen.findByText('仓库巡检'));
    await waitFor(() => expect(scheduleRuns).toHaveBeenCalledWith('j1'));
    expect(screen.getByText(/Run history|执行记录/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Back|返回/ })); // 记录页返回
    const more = screen.getByRole('button', { name: bi('More', '更多') });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: bi('Run now', '立即执行') }));
    await waitFor(() => expect(runScheduleNow).toHaveBeenCalledWith('j1'));
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: bi('Edit', '编辑') }));
    // waitFor 吞掉打开配置页时 workspaces 两路回源的异步 setState(避免裸 getByText 后的 act 警告)
    await waitFor(() => expect(screen.getByText(bi('Title', '标题'))).toBeDefined());
  });

  it('删除两步确认：首点改文案不发请求，确认后才 deleteSchedule 并移除卡片', async () => {
    const { conn, deleteSchedule } = makeConn([job()]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    await screen.findByText('仓库巡检');
    fireEvent.click(screen.getByRole('button', { name: bi('More', '更多') }));
    fireEvent.click(screen.getByRole('button', { name: bi('Delete', '删除') }));
    expect(deleteSchedule).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: bi('Confirm delete', '确认删除') })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: bi('Confirm delete', '确认删除') }));
    await waitFor(() => expect(deleteSchedule).toHaveBeenCalledWith('j1'));
    await waitFor(() => expect(screen.queryByText('仓库巡检')).toBeNull());
    expect(screen.getByText(bi('No scheduled tasks yet', '暂无定时任务'))).toBeDefined();
  });

  it('立即执行：runScheduleNow + 状态行 notice，随后自动刷新列表', async () => {
    const { conn, schedules, runScheduleNow } = makeConn([job()]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    await screen.findByText('仓库巡检');
    expect(schedules).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: bi('More', '更多') }));
    fireEvent.click(screen.getByRole('button', { name: bi('Run now', '立即执行') }));
    await waitFor(() => expect(runScheduleNow).toHaveBeenCalledWith('j1'));
    const status = await screen.findByRole('status');
    expect(status.textContent).toBe('Triggered once');
    // 执行后 ~700ms 静默重拉列表
    await waitFor(() => expect(schedules).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it('保存后回到列表并高亮对应卡片(is-focus)', async () => {
    const { conn, updateSchedule } = makeConn([job()]);
    const { container } = render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    await screen.findByText('仓库巡检');
    fireEvent.click(screen.getByRole('button', { name: bi('More', '更多') }));
    fireEvent.click(screen.getByRole('button', { name: bi('Edit', '编辑') }));
    await screen.findByText(bi('Title', '标题'));

    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(updateSchedule).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('.sx-schedule-card.is-focus')).not.toBeNull());
    expect(screen.getByText('仓库巡检')).toBeDefined();
    // spec §9.2：保存回列表后聚焦卡滚进视野
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' }));
  });

  it('取消(配置页返回)后回到列表并高亮对应卡片(is-focus)', async () => {
    const { conn, updateSchedule } = makeConn([job()]);
    const { container } = render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    await screen.findByText('仓库巡检');
    fireEvent.click(screen.getByRole('button', { name: bi('More', '更多') }));
    fireEvent.click(screen.getByRole('button', { name: bi('Edit', '编辑') }));
    await screen.findByText(bi('Title', '标题'));

    fireEvent.click(screen.getByRole('button', { name: /Back|返回/ }));
    await waitFor(() => expect(container.querySelector('.sx-schedule-card.is-focus')).not.toBeNull());
    expect(updateSchedule).not.toHaveBeenCalled();
    // spec §9.2：取消回列表同样定位
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' }));
  });

  it('Esc 层级：配置/记录 → 列表；列表 → onExit', async () => {
    const { conn, scheduleRuns } = makeConn([job()]);
    const onExit = vi.fn();
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={onExit} />);
    await screen.findByText('仓库巡检');
    const newTask = (): HTMLElement => screen.getByRole('button', { name: bi('Create scheduled task', '创建定时任务') });

    // 弹层最内层:菜单开着时 Esc 只收菜单,不退出页面
    fireEvent.click(screen.getByRole('button', { name: bi('More', '更多') }));
    expect(screen.getByRole('button', { name: bi('Run now', '立即执行') })).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: bi('Run now', '立即执行') })).toBeNull();
    expect(onExit).not.toHaveBeenCalled();

    // 列表层:Esc 退出页面
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);

    // 新建配置:Esc 先回列表,不退出
    fireEvent.click(newTask());
    expect(await screen.findByText(bi('New scheduled task', '新建定时任务'))).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(newTask()).toBeDefined());
    expect(onExit).toHaveBeenCalledTimes(1);

    // 执行记录:Esc 先回列表,再 Esc 才退出
    fireEvent.click(screen.getByText('仓库巡检'));
    await waitFor(() => expect(scheduleRuns).toHaveBeenCalledWith('j1'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(newTask()).toBeDefined());
    expect(onExit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it('配置页 Esc 先收打开的下拉弹层，不连带退页；再 Esc 才回列表', async () => {
    const { conn } = makeConn([job()]);
    const onExit = vi.fn();
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={onExit} />);
    await screen.findByText('仓库巡检');
    fireEvent.click(screen.getByRole('button', { name: bi('Create scheduled task', '创建定时任务') }));
    await screen.findByText(bi('New scheduled task', '新建定时任务'));

    const modelPill = document.querySelector('.sx-schedule-model-pill')!;
    fireEvent.click(modelPill);
    expect(screen.getByRole('menu', { name: 'model menu' })).toBeDefined();
    // 弹层开着时 Esc 的目标在页内元素（真键盘事件形态）:capture 层消费,页面级不再收到
    fireEvent.keyDown(modelPill, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'model menu' })).toBeNull();
    expect(screen.getByText(bi('New scheduled task', '新建定时任务'))).toBeDefined();
    expect(onExit).not.toHaveBeenCalled();
    // 弹层已收:Esc 回列表
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('button', { name: bi('Create scheduled task', '创建定时任务') })).toBeDefined());
    expect(onExit).not.toHaveBeenCalled();
  });

  it('首拉失败:错误条呈现且不永挂「加载中…」', async () => {
    const schedules = vi.fn(async () => {
      throw new Error('daemon down');
    });
    const conn = { schedules } as unknown as Connection;
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toBe('daemon down');
    expect(screen.queryByText(bi('Loading…', '加载中…'))).toBeNull();
    expect(screen.queryByText(bi('No scheduled tasks yet', '暂无定时任务'))).toBeNull();
  });

  it('倒计时行：停用=已暂停、ended=已结束；启用任务显示相对倒计时', async () => {
    const { conn } = makeConn([
      job({ id: 'j1', name: '暂停任务', enabled: false, nextRunAt: null }),
      job({ id: 'j2', name: '结束任务', ended: true, enabled: true }),
      // 24.5h 落在「1 天 0 小时」中段,跨 now tick 1s 仍稳定(25h 整点恰好 h=25 → "1d 1h" 边界)
      job({ id: 'j3', name: '启用任务', nextRunAt: Date.now() + 24.5 * 3_600_000 }),
    ]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    expect(await screen.findByText('暂停任务')).toBeDefined();
    expect(screen.getByText(bi('Paused', '已暂停'))).toBeDefined();
    expect(screen.getByText(bi('Ended', '已结束'))).toBeDefined();
    expect(screen.getByText(bi('1d 0h', '1 天 0 小时后'))).toBeDefined();
  });

  it('倒计时行左起周期说明、右端运行次数(2026-11-21 用户裁定)；runCount=0 不显示', async () => {
    const { conn } = makeConn([
      job({ id: 'j1', name: '每日检查', recurrence: { unit: 'day', every: 1, at: '00:45' }, runCount: 3 }),
      job({ id: 'j2', name: '没跑过', runCount: 0 }),
    ]);
    const { container } = render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    expect(await screen.findByText('每日检查')).toBeDefined();
    // 周期说明在最前(每天 00:45)，随后「下次」倒计时，右端「已运行 3 次」
    expect(screen.getByText(bi('Daily at 00:45', '每天 00:45'))).toBeDefined();
    expect(screen.getByText(bi('3 runs', '已运行 3 次'))).toBeDefined();
    const row = container.querySelector('.sx-schedule-next')!;
    expect(row.querySelector('.sx-schedule-next-cadence')?.textContent).toMatch(/Daily at 00:45|每天 00:45/);
    expect(row.querySelector('.sx-schedule-runcount')?.textContent).toMatch(/3 runs|已运行 3 次/);
    const plain = Array.from(container.querySelectorAll('.sx-schedule-card')).find((c) => c.textContent?.includes('没跑过'))!;
    expect(plain.querySelector('.sx-schedule-runcount')).toBeNull();
  });

  it('筛选页签：按最近一次执行状态过滤（进行中/完成/失败）；无 run 只落「全部」', async () => {
    const { conn } = makeConn([
      job({ id: 'j1', name: '运行中任务', lastRun: lastRun('running') }),
      job({ id: 'j2', name: '完成任务', lastRun: lastRun('succeeded') }),
      job({ id: 'j3', name: '失败任务', lastRun: lastRun('failed') }),
      job({ id: 'j4', name: '从没跑过' }),
    ]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    await screen.findByText('运行中任务');
    expect(screen.getByText('从没跑过')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: bi('Running', '进行中') }));
    expect(screen.getByText('运行中任务')).toBeDefined();
    expect(screen.queryByText('完成任务')).toBeNull();
    expect(screen.queryByText('失败任务')).toBeNull();
    expect(screen.queryByText('从没跑过')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: bi('Completed', '完成') }));
    expect(screen.getByText('完成任务')).toBeDefined();
    expect(screen.queryByText('运行中任务')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: bi('Failed', '失败') }));
    expect(screen.getByText('失败任务')).toBeDefined();
    expect(screen.queryByText('完成任务')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: bi('All', '全部') }));
    expect(screen.getByText('从没跑过')).toBeDefined();
    expect(screen.getByText('运行中任务')).toBeDefined();
  });

  it('筛选空态：没有对应状态时显示该页签空文案', async () => {
    const { conn } = makeConn([job({ name: '只有完成', lastRun: lastRun('succeeded') })]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    await screen.findByText('只有完成');
    fireEvent.click(screen.getByRole('button', { name: bi('Failed', '失败') }));
    expect(screen.getByText(bi('No failed tasks', '暂无失败的任务'))).toBeDefined();
  });

  it('创建下拉：主钮开配置；「在会话中创建」回调；Esc 先收下拉', async () => {
    const { conn } = makeConn([job()]);
    const onCreateInChat = vi.fn();
    const onExit = vi.fn();
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={onExit} onCreateInChat={onCreateInChat} />);
    await screen.findByText('仓库巡检');
    const caret = screen.getByRole('button', { name: bi('More create options', '更多创建方式') });
    fireEvent.click(caret);
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Create in chat', '在会话中创建') }));
    expect(onCreateInChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem', { name: bi('Create in chat', '在会话中创建') })).toBeNull();

    fireEvent.click(caret);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: bi('Create in chat', '在会话中创建') })).toBeNull();
    expect(onExit).not.toHaveBeenCalled();

    // 主钮仍直接进配置页
    fireEvent.click(screen.getByRole('button', { name: bi('Create scheduled task', '创建定时任务') }));
    expect(await screen.findByText(bi('New scheduled task', '新建定时任务'))).toBeDefined();
  });

  it('忽略未传 onCreateInChat 时的下拉箭头（只有主钮）', async () => {
    const { conn } = makeConn([job()]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    await screen.findByText('仓库巡检');
    expect(screen.queryByRole('button', { name: bi('More create options', '更多创建方式') })).toBeNull();
  });

  it('菜单收起态：传入 onToggleMenu 才出左上角浮动菜单钮并回调；顶栏仍是空拖拽条', async () => {
    const { conn } = makeConn([job()]);
    const onToggleMenu = vi.fn();
    const { rerender } = render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    await screen.findByText('仓库巡检');
    expect(document.querySelector('.sx-schedule-nav')).toBeNull();
    expect(document.querySelector('.sx-schedules-topbar[data-drag-band]')).not.toBeNull();
    // 设置页同构：页顶条不得有任何动作钮（−□× 是全局窗控簇，不在本层内）
    expect(document.querySelectorAll('.sx-schedules-topbar button')).toHaveLength(0);

    rerender(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} onToggleMenu={onToggleMenu} />);
    const toggle = document.querySelector('.sx-schedule-nav .sx-menu-reopen');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(onToggleMenu).toHaveBeenCalledTimes(1);
  });

  it('刷新钮：点击后转圈并禁用，拉取完成（含最短 420ms）后停', async () => {
    const { conn, schedules } = makeConn([job()]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    expect(await screen.findByText('仓库巡检')).toBeDefined();
    let release!: (v: { now: number; defaultModel: string; jobs: ScheduleJobView[] }) => void;
    schedules.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const btn = screen.getByRole('button', { name: bi('Refresh', '刷新') }) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.className).toContain('is-spinning');
    expect(btn.disabled).toBe(true);
    expect(schedules).toHaveBeenCalledTimes(2);

    await act(async () => {
      release({ now: Date.now(), defaultModel: 'DeepSeek', jobs: [job()] });
    });
    await waitFor(() => expect(btn.getAttribute('aria-busy')).not.toBe('true'), { timeout: 2000 });
    expect(btn.className).not.toContain('is-spinning');
    expect(btn.disabled).toBe(false);
  });

  it('卡片展示目标类型 chip：项目 / SUNX / 通道 + 目标名（2026-11-21 用户裁定）', async () => {
    const { conn } = makeConn([
      job({ id: 'jp', name: '项目任务', target: 'project', targetLabel: '默认工作区' }),
      job({ id: 'js', name: 'SUNX 任务', target: 'sunx', targetJournalId: 'sj1', targetLabel: '运维助手' }),
      job({ id: 'jc', name: '通道任务', target: 'channel', targetChannelId: 'feishu', targetChatId: 'oc_1', targetLabel: '飞书 · 项目群' }),
    ]);
    const { container } = render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    await screen.findByText('SUNX 任务');
    // 2026-11-21 用户裁定「去掉项目这个名字」：chip 只剩目标名；SUNX 行前有冠标 svg
    const chips = Array.from(container.querySelectorAll('.sx-schedule-card .sx-schedule-target-chip'));
    expect(chips.map((e) => e.textContent ?? '').some((t) => t.includes('默认工作区'))).toBe(true);
    expect(chips.map((e) => e.textContent ?? '').some((t) => t.includes('运维助手'))).toBe(true);
    expect(chips.map((e) => e.textContent ?? '').some((t) => t.includes('飞书 · 项目群'))).toBe(true);
    expect(document.querySelector('.sx-schedule-target-chip.is-sunx svg')).not.toBeNull();
  });
});
