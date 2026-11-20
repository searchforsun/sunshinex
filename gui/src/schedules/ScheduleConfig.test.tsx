import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ScheduleConfig } from './ScheduleConfig';
import { recurrenceOf } from './cycle';
import { effortLabel } from '../effort-slider';
import type { Connection, ScheduleDraft, ScheduleJobView } from '../connection';

/** 双语容忍正解(D37 家族):产品面 t() 化,测试环境钉 en,单语钉必脆 */
const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** RTL 默认 normalizer:trim + \s+→空格——locale 串里的窄空格(NBSP 族)需同口径归一后再比 */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 本地 datetime-local 串(与被测组件同口径;测试侧独立实现避免读实现私有函数) */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * conn 桩:三行配置只触 workspaces(挂载回源)+create/update/preview(write 面)+
 * locate/createWorkspace/dirpicker/onConfigChanged(useWelcomeWorkspaces 全接缝)。
 * mocks 以具名引用返回,断言 read 面零强转。
 */
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
  const conn = {
    workspaces,
    createSchedule,
    updateSchedule,
    previewSchedule,
    createWorkspace,
    locateWorkspace,
    dirpicker,
    onConfigChanged,
  } as unknown as Connection;
  return { conn, workspaces, createSchedule, updateSchedule, previewSchedule };
}

/** 完整任务行(编辑态):周期 weekly/强度 low/模式 acceptEdits/带截止——全部偏离新建缺省,
 *  预填断言才真证「以 job 为初值」;root 放工作区清单里,挂载回源不把选择改回默认 */
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

describe('ScheduleConfig 三行', () => {
  it('只有名称/调度/任务;调度以开始时间为锚点;保存 payload 映射正确', async () => {
    const { conn, createSchedule } = makeConn();
    const onSaved = vi.fn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={onSaved} />);
    expect(await screen.findByText(bi('Name', '名称'))).toBeDefined();
    expect(screen.getByText(bi('Schedule', '调度'))).toBeDefined();
    expect(screen.getByText(bi('Task', '任务'))).toBeDefined();

    fireEvent.change(screen.getByLabelText(bi('Name', '名称')), { target: { value: '巡检' } });
    fireEvent.change(screen.getByLabelText(bi('Task', '任务')), { target: { value: '检查仓库' } });
    fireEvent.change(screen.getByLabelText(bi('Starts at', '开始时间')), { target: { value: '2026-11-20T09:30' } });
    fireEvent.change(screen.getByLabelText(bi('Repeat', '周期')), { target: { value: 'daily' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));

    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    const body = createSchedule.mock.calls[0]![0];
    expect(body.name).toBe('巡检');
    expect(body.prompt).toBe('检查仓库');
    expect(body.root).toBe('default');
    expect(body.recurrence).toEqual({ unit: 'day', every: 1, at: '09:30' });
    expect(body.startAt).toBe(new Date(2026, 10, 20, 9, 30, 0, 0).getTime());
    expect('until' in body).toBe(false); // 无截止缺省:body 不带 until 键
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('编辑态:全字段预填;保存走 updateSchedule(job.id, body) 而非 create', async () => {
    const { conn, createSchedule, updateSchedule } = makeConn(Date.now() + 60_000, [
      { slug: 'proj', root: 'D:/w/proj', sessionCount: 1 },
    ]);
    const job = makeJob();
    const onSaved = vi.fn();
    render(<ScheduleConfig conn={conn} job={job} defaultModel="DeepSeek" onSaved={onSaved} />);
    await screen.findByText(bi('Name', '名称'));

    expect((screen.getByLabelText(bi('Name', '名称')) as HTMLInputElement).value).toBe('巡检');
    expect((screen.getByLabelText(bi('Task', '任务')) as HTMLTextAreaElement).value).toBe('检查仓库');
    expect((screen.getByLabelText(bi('Repeat', '周期')) as HTMLSelectElement).value).toBe('weekly');
    expect((screen.getByLabelText(bi('Starts at', '开始时间')) as HTMLInputElement).value).toBe(toLocalInput(JOB_START));
    expect((screen.getByLabelText(bi('Ends at', '截止时间')) as HTMLInputElement).value).toBe(toLocalInput(JOB_UNTIL));
    expect((screen.getByLabelText(bi('No deadline', '无截止')) as HTMLInputElement).checked).toBe(false);
    // 强度 chip 挂在模型 pill 内(low→lowercase 标签)+ 权限 pill(acceptEdits→Auto edit)
    expect(screen.getByRole('button', { name: bi('Auto edit', '自动编辑') })).toBeDefined();
    const modelPill = screen.getByRole('button', { name: /DeepSeek/ });
    expect(modelPill.querySelector('.model-effort-chip')?.textContent).toBe(effortLabel('low'));

    fireEvent.change(screen.getByLabelText(bi('Name', '名称')), { target: { value: '巡检二' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));

    await waitFor(() => expect(updateSchedule).toHaveBeenCalledTimes(1));
    expect(createSchedule).not.toHaveBeenCalled();
    const [id, body] = updateSchedule.mock.calls[0]!;
    expect(id).toBe('j1');
    expect(body.name).toBe('巡检二');
    expect(body.prompt).toBe('检查仓库');
    expect(body.root).toBe('D:/w/proj');
    expect(body.effort).toBe('low');
    expect(body.mode).toBe('acceptEdits');
    expect(body.recurrence).toEqual(recurrenceOf('weekly', JOB_START));
    expect(body.startAt).toBe(JOB_START);
    expect(body.until).toBe(JOB_UNTIL);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('校验:名称/任务为空 → 行内错误,不发请求', async () => {
    const { conn, createSchedule, updateSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={() => undefined} />);
    await screen.findByText(bi('Name', '名称'));
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    expect(screen.getByRole('alert').textContent).toBe('Name and task are required');
    expect(createSchedule).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  it('校验:截止早于/等于开始(未勾无截止)→ 行内错误,不发请求', async () => {
    const { conn, createSchedule, updateSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={() => undefined} />);
    await screen.findByText(bi('Name', '名称'));
    fireEvent.change(screen.getByLabelText(bi('Name', '名称')), { target: { value: '巡检' } });
    fireEvent.change(screen.getByLabelText(bi('Task', '任务')), { target: { value: '检查仓库' } });
    fireEvent.change(screen.getByLabelText(bi('Starts at', '开始时间')), { target: { value: '2026-11-20T09:30' } });
    fireEvent.click(screen.getByLabelText(bi('No deadline', '无截止'))); // 取消勾选 → until 生效
    fireEvent.change(screen.getByLabelText(bi('Ends at', '截止时间')), { target: { value: '2026-11-20T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    expect(screen.getByRole('alert').textContent).toBe('End must be after start');
    expect(createSchedule).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  it('校验:开始时间无效/为空 → 行内错误,不发请求', async () => {
    const { conn, createSchedule, updateSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={() => undefined} />);
    await screen.findByText(bi('Name', '名称'));
    fireEvent.change(screen.getByLabelText(bi('Name', '名称')), { target: { value: '巡检' } });
    fireEvent.change(screen.getByLabelText(bi('Task', '任务')), { target: { value: '检查仓库' } });
    fireEvent.change(screen.getByLabelText(bi('Starts at', '开始时间')), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    expect(screen.getByRole('alert').textContent).toBe('Invalid start time');
    expect(createSchedule).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  it('预览:250ms 防抖调 previewSchedule(周期+开始映射);until 仅未勾无截止时携带;hint 显示返回时刻', async () => {
    const ts = new Date(2026, 10, 21, 10, 0, 0, 0).getTime();
    const { conn, previewSchedule } = makeConn(ts);
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={() => undefined} />);
    fireEvent.change(screen.getByLabelText(bi('Starts at', '开始时间')), { target: { value: '2026-11-20T09:30' } });
    const startMs = new Date(2026, 10, 20, 9, 30, 0, 0).getTime();

    await waitFor(() =>
      expect(previewSchedule).toHaveBeenLastCalledWith({
        recurrence: { unit: 'day', every: 1, at: '09:30' },
        startAt: startMs,
      }),
    );
    expect(await screen.findByText(new RegExp(esc(norm(new Date(ts).toLocaleString()))))).toBeDefined();

    // 取消无截止并给截止时间 → 最后一次预览携带 until
    fireEvent.click(screen.getByLabelText(bi('No deadline', '无截止')));
    fireEvent.change(screen.getByLabelText(bi('Ends at', '截止时间')), { target: { value: '2026-11-22T09:30' } });
    const untilMs = new Date(2026, 10, 22, 9, 30, 0, 0).getTime();
    await waitFor(() =>
      expect(previewSchedule).toHaveBeenLastCalledWith({
        recurrence: { unit: 'day', every: 1, at: '09:30' },
        startAt: startMs,
        until: untilMs,
      }),
    );
  });

  it('底部 dock:工作区 pill(默认工作区)/＋/模型 pill(默认模型+强度 chip)/权限 pill(完全访问)/保存钮', async () => {
    const { conn } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={() => undefined} />);
    expect(await screen.findByText(bi('Default workspace', '默认工作区'))).toBeDefined();
    expect(screen.getByTitle(bi('Add workspace', '新增工作目录'))).toBeDefined();
    const modelPill = screen.getByRole('button', { name: /DeepSeek/ });
    expect(modelPill.textContent).toContain('DeepSeek');
    // 缺省 effort=high:强度 chip 挂在模型 pill 内(不另设强度 pill)
    expect(modelPill.querySelector('.model-effort-chip')?.textContent).toBe(effortLabel('high'));
    expect(screen.getByRole('button', { name: bi('Full access', '完全访问') })).toBeDefined();
    expect(screen.getByRole('button', { name: bi('Save', '保存') })).toBeDefined();
    // dock 挂在 ComposerCard 的 .sx-composer-foot 内
    expect(document.querySelector('.sx-composer-foot .sx-schedule-mode-pill')).not.toBeNull();
  });

  it('无截止缺省:until 输入禁用;创建体不带 until', async () => {
    const { conn, createSchedule, previewSchedule } = makeConn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={() => undefined} />);
    await screen.findByText(bi('Name', '名称'));
    expect((screen.getByLabelText(bi('No deadline', '无截止')) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(bi('Ends at', '截止时间')) as HTMLInputElement).disabled).toBe(true);

    // 预览同口径:挂载后的首次预览不携带 until
    await waitFor(() => expect(previewSchedule).toHaveBeenCalled());
    const previewArg = previewSchedule.mock.calls[0]![0];
    expect('until' in previewArg).toBe(false);

    fireEvent.change(screen.getByLabelText(bi('Name', '名称')), { target: { value: '巡检' } });
    fireEvent.change(screen.getByLabelText(bi('Task', '任务')), { target: { value: '检查仓库' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    const body = createSchedule.mock.calls[0]![0];
    expect('until' in body).toBe(false);
  });

  it('编辑态根权威:workspaces 清单不含 job.root 时选择不被重置,保存 root 仍是 job.root', async () => {
    const { conn, workspaces, updateSchedule } = makeConn();
    const releases: Array<(rows: Array<{ slug: string; root?: string; sessionCount: number }>) => void> = [];
    workspaces.mockImplementation(
      () =>
        new Promise<Array<{ slug: string; root?: string; sessionCount: number }>>((resolve) => {
          releases.push(resolve);
        }),
    );
    const job = makeJob({ root: 'D:/w/ghost' });
    render(<ScheduleConfig conn={conn} job={job} defaultModel="DeepSeek" onSaved={() => undefined} />);
    // 编辑态挂载即两路回源(挂载 effect + presetRoot effect),全部挂起
    await waitFor(() => expect(releases.length).toBeGreaterThan(0));
    expect(screen.getByText('ghost')).toBeDefined(); // preset 种子(picked=job.root)

    // 回源只回默认行:释放前无 job.root 在册——不带根权威就会被重置回默认锚
    await act(async () => {
      let resolve: ((rows: Array<{ slug: string; root?: string; sessionCount: number }>) => void) | undefined;
      while ((resolve = releases.shift()) !== undefined) {
        resolve([{ slug: 'default', root: 'default', sessionCount: 0 }]);
      }
    });
    expect(screen.getByText('ghost')).toBeDefined(); // 回源后仍保持

    fireEvent.change(screen.getByLabelText(bi('Name', '名称')), { target: { value: '巡检二' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(updateSchedule).toHaveBeenCalledTimes(1));
    const [, body] = updateSchedule.mock.calls[0]!;
    expect(body.root).toBe('D:/w/ghost');
  });

  it('保存失败:createSchedule 拒绝 → 行内 alert 显示错误文本,busy 释放可重试', async () => {
    const { conn, createSchedule } = makeConn();
    let rejectSave!: (e: unknown) => void;
    createSchedule.mockImplementation(
      () =>
        new Promise<ScheduleJobView>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={() => undefined} />);
    await screen.findByText(bi('Name', '名称'));
    fireEvent.change(screen.getByLabelText(bi('Name', '名称')), { target: { value: '巡检' } });
    fireEvent.change(screen.getByLabelText(bi('Task', '任务')), { target: { value: '检查仓库' } });
    const save = screen.getByRole('button', { name: bi('Save', '保存') }) as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    expect(save.disabled).toBe(true); // busy 期禁点

    await act(async () => {
      rejectSave(new Error('daemon down'));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('daemon down');
    await waitFor(() => expect(save.disabled).toBe(false)); // busy 释放,可重试
  });
});
