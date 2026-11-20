import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ScheduleConfig } from './ScheduleConfig';
import { effortLabel } from '../effort-slider';
import type { Connection, ScheduleDraft, ScheduleJobView } from '../connection';

/** 双语容忍正解(D37 家族):产品面 t() 化,测试环境钉 en,单语钉必脆 */
const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 自绘 Select/星期多选：开 trigger → 点 option */
function pick(trigger: RegExp, option: string | RegExp): void {
  fireEvent.click(screen.getByRole('button', { name: trigger }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

function makeConn(
  previewNext: number = Date.now() + 60_000,
  rows: Array<{ slug: string; root?: string; sessionCount: number }> = [
    { slug: 'default', root: 'default', sessionCount: 0 },
  ],
) {
  const workspaces = vi.fn(async () => rows);
  const createSchedule = vi.fn(
    async (body: ScheduleDraft): Promise<ScheduleJobView> => ({
      id: 'new',
      ...body,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: Date.now() + 60_000,
      runCount: 0,
    }),
  );
  const updateSchedule = vi.fn(
    async (id: string, body: ScheduleDraft): Promise<ScheduleJobView> => ({
      id,
      ...body,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: Date.now() + 60_000,
      runCount: 0,
    }),
  );
  const previewSchedule = vi.fn(async (_body: { recurrence: unknown; startAt: number; until?: number }) => ({
    next: [previewNext],
  }));
  const createWorkspace = vi.fn(async (_body: { name?: string; path?: string }) => ({
    ok: true as const,
    root: 'D:/w/p',
    slug: 'p',
  }));
  const locateWorkspace = vi.fn(async (_body: { token: string; roots?: string[] }) => ({ path: null }));
  const dirpicker = vi.fn(async (_path?: string) => ({ path: '', parent: '', dirs: [] as string[] }));
  const onConfigChanged = vi.fn((_cb: (f: unknown) => void) => () => undefined);
  const settings = vi.fn(async () => ({
    providers: { choices: [{ id: 'deepseek-flash' }, { id: 'glm-4.7' }] },
  }));
  const conn = {
    workspaces,
    createSchedule,
    updateSchedule,
    previewSchedule,
    createWorkspace,
    locateWorkspace,
    dirpicker,
    onConfigChanged,
    settings,
  } as unknown as Connection;
  return { conn, workspaces, createSchedule, updateSchedule, previewSchedule };
}

const JOB_START = new Date(2026, 10, 16, 8, 15, 0, 0).getTime();
const JOB_UNTIL = new Date(2026, 11, 1, 0, 0, 0, 0).getTime();
function makeJob(patch: Partial<ScheduleJobView> = {}): ScheduleJobView {
  return {
    id: 'j1',
    name: '巡检',
    prompt: '检查仓库',
    root: 'D:/w/proj',
    effort: 'low',
    mode: 'acceptEdits',
    recurrence: { unit: 'week', every: 1, weekdays: [1], at: '08:15' },
    startAt: JOB_START,
    until: JOB_UNTIL,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: Date.now() + 60_000,
    runCount: 0,
    ...patch,
  };
}

describe('ScheduleConfig 上下三段', () => {
  it('缺省：标题有默认名、调度=每天 09:00 单行、指令复用 composer；保存用 now 锚点且不带截止', async () => {
    const { conn, createSchedule } = makeConn();
    const onSaved = vi.fn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={onSaved} onBack={vi.fn()} />);
    expect(await screen.findByText(bi('Title', '标题'))).toBeDefined();
    expect(screen.getByText(bi('Schedule', '调度'))).toBeDefined();
    expect(screen.getByText(bi('Instruction', '指令'))).toBeDefined();
    const nameInput = screen.getByLabelText(bi('Title', '标题')) as HTMLInputElement;
    expect(nameInput.value).toMatch(/Untitled scheduled task|未命名定时任务/);
    expect(screen.getByRole('button', { name: bi('Repeat', '周期') }).textContent).toMatch(/Daily|每天/);
    expect(screen.getByText(/Daily at 09:00|每天 09:00/)).toBeDefined();

    fireEvent.change(screen.getByLabelText(bi('Instruction', '指令')), { target: { value: '检查仓库' } });
    const before = Date.now();
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    const body = createSchedule.mock.calls[0]![0];
    expect(body.name).toMatch(/Untitled scheduled task|未命名定时任务/);
    expect(body.prompt).toBe('检查仓库');
    expect(body.root).toBe('default');
    expect(body.effort).toBe('medium');
    expect(body.mode).toBe('full-access');
    expect(body.recurrence).toEqual({ unit: 'day', every: 1, at: '09:00' });
    expect(body.startAt).toBeGreaterThanOrEqual(before);
    expect('until' in body).toBe(false);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('每小时：只出分钟选择；锚点=当前小时+分钟、秒为零', async () => {
    const { conn, createSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(bi('Title', '标题'));
    pick(bi('Repeat', '周期'), bi('Hourly', '每小时'));
    pick(bi('Minute', '分钟'), '30');
    expect(screen.getByText(/Hourly at :30|每小时第 30 分钟/)).toBeDefined();

    fireEvent.change(screen.getByLabelText(bi('Instruction', '指令')), { target: { value: '检查仓库' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    const body = createSchedule.mock.calls[0]![0];
    expect(body.recurrence).toEqual({ unit: 'hour', every: 1 });
    const anchor = new Date(body.startAt);
    expect([anchor.getMinutes(), anchor.getSeconds(), anchor.getMilliseconds()]).toEqual([30, 0, 0]);
  });

  it('每周：星期多选 + 时:分；payload weekdays 去重排序', async () => {
    const { conn, createSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(bi('Title', '标题'));
    pick(bi('Repeat', '周期'), bi('Weekly', '每周'));
    fireEvent.click(screen.getByRole('button', { name: bi('Weekdays', '星期') }));
    fireEvent.click(screen.getByRole('option', { name: bi('Wed', '周三') }));
    fireEvent.click(screen.getByRole('button', { name: bi('Weekdays', '星期') })); // 收起多选
    pick(bi('Hour', '小时'), '08');
    pick(bi('Minute', '分钟'), '15');
    expect(screen.getByText(/Weekly on Mon, Wed at 08:15|每周一、周三 08:15/)).toBeDefined();

    fireEvent.change(screen.getByLabelText(bi('Instruction', '指令')), { target: { value: '检查仓库' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    const body = createSchedule.mock.calls[0]![0];
    expect(body.recurrence).toEqual({ unit: 'week', every: 1, weekdays: [1, 3], at: '08:15' });
  });

  it('每月：日选择 + 时:分；payload dayOfMonth/at', async () => {
    const { conn, createSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(bi('Title', '标题'));
    pick(bi('Repeat', '周期'), bi('Monthly', '每月'));
    pick(bi('Day of month', '日'), '15');
    pick(bi('Hour', '小时'), '07');
    pick(bi('Minute', '分钟'), '00');
    expect(screen.getByText(/Monthly on day 15 at 07:00|每月 15 日 07:00/)).toBeDefined();

    fireEvent.change(screen.getByLabelText(bi('Instruction', '指令')), { target: { value: '检查仓库' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    const body = createSchedule.mock.calls[0]![0];
    expect(body.recurrence).toEqual({ unit: 'month', every: 1, dayOfMonth: 15, at: '07:00' });
  });

  it('编辑态：全字段预填；保存走 updateSchedule，startAt 改 now、截止预填并保留', async () => {
    const { conn, updateSchedule } = makeConn(Date.now() + 60_000, [{ slug: 'proj', root: 'D:/w/proj', sessionCount: 1 }]);
    const job = makeJob();
    const onSaved = vi.fn();
    render(<ScheduleConfig conn={conn} job={job} defaultModel="DeepSeek" onSaved={onSaved} onBack={vi.fn()} />);
    await screen.findByText(bi('Title', '标题'));

    expect((screen.getByLabelText(bi('Title', '标题')) as HTMLInputElement).value).toBe('巡检');
    expect((screen.getByLabelText(bi('Instruction', '指令')) as HTMLTextAreaElement).value).toBe('检查仓库');
    expect(screen.getByRole('button', { name: bi('Repeat', '周期') }).textContent).toMatch(/Weekly|每周/);
    expect(screen.getByRole('button', { name: bi('Weekdays', '星期') }).textContent).toMatch(/Mon|周一/);
    expect(screen.getByRole('button', { name: bi('Hour', '小时') }).textContent).toContain('08');
    expect(screen.getByRole('button', { name: bi('Minute', '分钟') }).textContent).toContain('15');
    expect(screen.getByRole('button', { name: 'model' }).querySelector('.model-effort-chip')?.textContent).toBe(effortLabel('low'));
    expect(screen.getByText(bi('Workspace edits', '工作区编辑'))).toBeDefined();
    expect(screen.getByRole('button', { name: bi('Deadline', '截止时间') }).textContent).toMatch(/2026-12-01 00:00/);

    fireEvent.change(screen.getByLabelText(bi('Title', '标题')), { target: { value: '巡检二' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));

    await waitFor(() => expect(updateSchedule).toHaveBeenCalledTimes(1));
    const [id, body] = updateSchedule.mock.calls[0]!;
    expect(id).toBe('j1');
    expect(body.name).toBe('巡检二');
    expect(body.prompt).toBe('检查仓库');
    expect(body.root).toBe('D:/w/proj');
    expect(body.effort).toBe('low');
    expect(body.mode).toBe('acceptEdits');
    expect(body.recurrence).toEqual(job.recurrence);
    expect(body.startAt).toBeGreaterThan(job.startAt);
    expect(body.until).toBe(JOB_UNTIL);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('自定义周期（年/分钟）编辑：保留原 recurrence/startAt/until，不静默改语义', async () => {
    const { conn, updateSchedule } = makeConn();
    const job = makeJob({
      recurrence: { unit: 'year', every: 1, month: 3, day: 5, at: '09:00' },
      startAt: JOB_START,
      until: JOB_UNTIL,
    });
    render(<ScheduleConfig conn={conn} job={job} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(bi('Title', '标题'));
    expect(screen.getByRole('button', { name: bi('Repeat', '周期') }).textContent).toMatch(/Custom|自定义/);
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(updateSchedule).toHaveBeenCalledTimes(1));
    const [, body] = updateSchedule.mock.calls[0]!;
    expect(body.recurrence).toEqual(job.recurrence);
    expect(body.startAt).toBe(JOB_START);
    expect(body.until).toBe(JOB_UNTIL);
  });

  it('校验：指令空时保存钮禁用；指令填了但标题空 → 行内错误，不发请求', async () => {
    const { conn, createSchedule, updateSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(bi('Title', '标题'));
    const create = (): HTMLButtonElement => screen.getByRole('button', { name: bi('Create', '创建') }) as HTMLButtonElement;
    expect(create().disabled).toBe(true); // 指令未填：不可保存（2026-11-20 用户裁定）

    fireEvent.change(screen.getByLabelText(bi('Instruction', '指令')), { target: { value: '检查仓库' } });
    expect(create().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(bi('Title', '标题')), { target: { value: '' } });
    fireEvent.click(create());
    expect(screen.getByRole('alert').textContent).toBe('Title is required');
    expect(createSchedule).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(bi('Instruction', '指令')), { target: { value: '' } });
    expect(create().disabled).toBe(true);
  });

  it('截止时间：调度行右端自绘月历；选日写入 until，预览与保存携带', async () => {
    const { conn, createSchedule, previewSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(bi('Title', '标题'));
    fireEvent.change(screen.getByLabelText(bi('Instruction', '指令')), { target: { value: '检查仓库' } });

    fireEvent.click(screen.getByRole('button', { name: bi('Deadline', '截止时间') }));
    fireEvent.click(screen.getByRole('button', { name: bi('Next month', '下个月') }));
    const now = new Date();
    const y = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
    const m = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
    const key = `${y}-${String(m).padStart(2, '0')}-05`;
    fireEvent.click(screen.getByRole('button', { name: key }));
    const expected = new Date(y, m - 1, 5, 23, 59, 0, 0).getTime();
    expect(screen.getByRole('button', { name: bi('Deadline', '截止时间') }).textContent).toMatch(/2026|2027/);

    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    const body = createSchedule.mock.calls[0]![0];
    expect(body.until).toBe(expected);
    await waitFor(() => expect(previewSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ until: expected })));
  });

  it('截止时间：时分在右侧滚轮（非下拉），点选后改写 until', async () => {
    const { conn, createSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(bi('Title', '标题'));
    fireEvent.change(screen.getByLabelText(bi('Instruction', '指令')), { target: { value: '检查仓库' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Deadline', '截止时间') }));

    // 右侧时/分两枚滚轮（日历栏之后），默认 23:59 高亮
    const body = document.querySelector('.sx-deadline-cal + .sx-deadline-time-col')!;
    expect(body.querySelectorAll('.sx-wheel').length).toBe(2);
    const hourWheel = screen.getByRole('group', { name: bi('Deadline hour', '截止小时') });
    const minuteWheel = screen.getByRole('group', { name: bi('Deadline minute', '截止分钟') });
    expect(hourWheel.querySelector('.is-active')?.textContent).toBe('23');
    expect(minuteWheel.querySelector('.is-active')?.textContent).toBe('59');

    const now = new Date();
    const y = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
    const m = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
    fireEvent.click(screen.getByRole('button', { name: bi('Next month', '下个月') }));
    fireEvent.click(screen.getByRole('button', { name: `${y}-${String(m).padStart(2, '0')}-05` }));
    fireEvent.click(hourWheel.querySelectorAll('.sx-wheel-item')[8]!);
    fireEvent.click(minuteWheel.querySelectorAll('.sx-wheel-item')[30]!);
    expect(hourWheel.querySelector('.is-active')?.textContent).toBe('08');
    expect(minuteWheel.querySelector('.is-active')?.textContent).toBe('30');

    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    expect(createSchedule.mock.calls[0]![0].until).toBe(new Date(y, m - 1, 5, 8, 30, 0, 0).getTime());
  });

  it('预览：250ms 防抖、返回时刻入 hint；改时/分后重算', async () => {
    const ts = new Date(2026, 10, 21, 10, 0, 0, 0).getTime();
    const { conn, previewSchedule } = makeConn(ts);
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(previewSchedule).toHaveBeenCalled());
    expect(previewSchedule.mock.calls.at(-1)![0].recurrence).toEqual({ unit: 'day', every: 1, at: '09:00' });
    expect(await screen.findByText(new RegExp(esc(norm(new Date(ts).toLocaleString()))))).toBeDefined();

    pick(bi('Hour', '小时'), '10');
    pick(bi('Minute', '分钟'), '30');
    await waitFor(() =>
      expect(previewSchedule).toHaveBeenLastCalledWith(
        expect.objectContaining({ recurrence: { unit: 'day', every: 1, at: '10:30' } }),
      ),
    );
  });

  it('底部 dock：工作区 pill（无＋）/权限 pill/与输入框同一枚模型 pill（模型菜单+强度滑块）；保存钮不在 dock', async () => {
    const { conn, createSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText(bi('Default workspace', '默认工作区'))).toBeDefined();
    expect(screen.queryByTitle(bi('Add workspace', '新增工作目录'))).toBeNull();
    expect(screen.getByText(bi('Full access', '完全访问'))).toBeDefined();
    const modelPill = screen.getByRole('button', { name: 'model' });
    expect(modelPill.textContent).toContain('DeepSeek');
    expect(modelPill.querySelector('.model-effort-chip')?.textContent).toBe(effortLabel('medium'));
    fireEvent.click(modelPill);
    expect(screen.getByRole('menu', { name: 'model menu' })).toBeDefined();
    fireEvent.click(screen.getByRole('menuitem', { name: 'glm-4.7' }));
    expect(modelPill.textContent).toContain('glm-4.7');

    fireEvent.change(screen.getByLabelText(bi('Instruction', '指令')), { target: { value: '检查仓库' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    expect(createSchedule.mock.calls[0]![0].model).toBe('glm-4.7');
    expect(document.querySelector('.sx-composer-foot .sx-schedule-mode-pill')).not.toBeNull();
    expect(document.querySelector('.sx-composer-foot .sx-schedule-save')).toBeNull();
    expect(screen.getByRole('button', { name: bi('Create', '创建') })).toBeDefined();
  });

  it('编辑态根权威：workspaces 清单不含 job.root 时选择不被重置，保存 root 仍是 job.root', async () => {
    const { conn, workspaces, updateSchedule } = makeConn();
    const releases: Array<(rows: Array<{ slug: string; root?: string; sessionCount: number }>) => void> = [];
    workspaces.mockImplementation(
      () =>
        new Promise<Array<{ slug: string; root?: string; sessionCount: number }>>((resolve) => {
          releases.push(resolve);
        }),
    );
    const job = makeJob({ root: 'D:/w/ghost' });
    render(<ScheduleConfig conn={conn} job={job} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => expect(releases.length).toBeGreaterThan(0));
    expect(screen.getByText('ghost')).toBeDefined();

    await act(async () => {
      let resolve: ((rows: Array<{ slug: string; root?: string; sessionCount: number }>) => void) | undefined;
      while ((resolve = releases.shift()) !== undefined) {
        resolve([{ slug: 'default', root: 'default', sessionCount: 0 }]);
      }
    });
    expect(screen.getByText('ghost')).toBeDefined();

    fireEvent.change(screen.getByLabelText(bi('Title', '标题')), { target: { value: '巡检二' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(updateSchedule).toHaveBeenCalledTimes(1));
    const [, body] = updateSchedule.mock.calls[0]!;
    expect(body.root).toBe('D:/w/ghost');
  });

  it('保存失败：行内 alert 显示错误文本，busy 释放可重试', async () => {
    const { conn, createSchedule } = makeConn();
    let rejectSave!: (e: unknown) => void;
    createSchedule.mockImplementation(
      () =>
        new Promise<ScheduleJobView>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(bi('Title', '标题'));
    fireEvent.change(screen.getByLabelText(bi('Instruction', '指令')), { target: { value: '检查仓库' } });
    const save = screen.getByRole('button', { name: bi('Create', '创建') }) as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    expect(save.disabled).toBe(true);

    await act(async () => {
      rejectSave(new Error('daemon down'));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('daemon down');
    await waitFor(() => expect(save.disabled).toBe(false));
  });
});
