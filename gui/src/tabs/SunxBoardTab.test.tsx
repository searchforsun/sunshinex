import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setLanguage } from '../i18n';
import { SunxBoardTab } from './SunxBoardTab';
import type { Connection } from '../connection';
import type { SessionRow, WorkspaceRow } from '../connection';
import type { Delegation } from '../projection';

// i18n 语言钉:断言走中文文案(pinned-section.test 同款先例)
setLanguage('zh');

/**
 * SUNX 总览页直测(sunx P2 Task 8,spec §17.3):顶部聚合条(运行中实例/在飞任务/待裁决)+
 * 卡片网格(按工作区分节)+「新建 Sunx」入口卡开弹窗;卡片点击上抛开实例目标;刷新钮重拉;
 * 快照走 bumpSeq:false 只读通道;空态文案;快照失败行降级不炸。
 */

const del = (id: string, status: Delegation['status'], over: Partial<Delegation> = {}): Delegation => ({
  id,
  kind: 'subagent',
  label: `agent ${id}`,
  status,
  startedAt: 500,
  ...over,
});

const sunxRow = (id: string, over: Partial<SessionRow> = {}): SessionRow => ({
  id,
  file: `${id}.jsonl`,
  updatedAt: 1_000,
  title: `Sunx ${id}`,
  kind: 'sunx',
  root: 'D:/w/alpha',
  ...over,
} as SessionRow);

const snapResp = (delegations: Delegation[], pending?: unknown[]) => ({
  messages: [],
  board: { tasks: {}, seq: 0 },
  delegations,
  status: 'running',
  ...(pending !== undefined ? { pending } : {}),
});

/** conn 桩:workspaces/sessionsOf/sessionSnapshot 三面 + NewSunxDialog 三方法(开弹窗才触) */
function stubConn(opts: {
  workspaces?: WorkspaceRow[];
  sessionsByRoot?: Record<string, SessionRow[]>;
  snapshot?: (id: string) => Promise<unknown>;
  snapshotBoom?: boolean;
}) {
  const calls = {
    snapshotArgs: [] as Array<{ id: string; opts: { bumpSeq?: boolean } | undefined }>,
    sessionsCalls: [] as string[],
    workspacesCalls: 0,
  };
  const conn = {
    workspaces: () => {
      calls.workspacesCalls += 1;
      return Promise.resolve(opts.workspaces ?? [{ slug: 'alpha', root: 'D:/w/alpha', mtime: 1, sessionCount: 1 }]);
    },
    sessionsOf: (root: string) => {
      calls.sessionsCalls.push(root);
      return Promise.resolve(opts.sessionsByRoot?.[root] ?? []);
    },
    sessionSnapshot: (id: string, _page: unknown, o: { bumpSeq?: boolean } | undefined) => {
      calls.snapshotArgs.push({ id, opts: o });
      if (opts.snapshotBoom) return Promise.reject(new Error('snapshot 404'));
      return Promise.resolve(opts.snapshot?.(id) ?? snapResp([]));
    },
    // NewSunxDialog 面(入口卡开弹窗才触)
    sunxTemplates: () => Promise.resolve({ entries: [], warnings: [] }),
    dirpicker: () => Promise.resolve({ path: 'D:/', parent: 'D:', dirs: [] }),
    newSession: () => Promise.resolve({ sessionId: 'sx-new' }),
  };
  return { conn: conn as unknown as Connection, calls };
}

const alphaJ1 = () => stubConn({
  sessionsByRoot: {
    'D:/w/alpha': [
      sunxRow('j1', { liveSessionId: 'sx1', updatedAt: 900 }),
      sunxRow('j3', { updatedAt: 800 }), // 未挂载(无 liveSessionId):零快照
      { ...sunxRow('j4', { updatedAt: 700 }), kind: undefined }, // standard:kind 过滤滤除
    ],
  },
  snapshot: () =>
    Promise.resolve(
      snapResp(
        [del('d1', 'running'), del('d2', 'paused'), del('d3', 'done'), del('d4', 'failed')],
        [{ pid: 'p1', kind: 'approval' }, { pid: 'p2', kind: 'ask' }],
      ),
    ),
});

describe('SunxBoardTab(SUNX 总览页 sunx P2 Task 8)', () => {
  it('卡片网格+聚合条:kind 过滤、按工作区分节(R10)、在飞/完成/待裁决计数;快照 bumpSeq:false 只读', async () => {
    const { conn, calls } = alphaJ1();
    render(<SunxBoardTab conn={conn} />);
    await waitFor(() => expect(screen.getByText('Sunx j1')).toBeDefined(), { timeout: 2000 });
    // 聚合条:运行中 1 / 在飞任务 2 / 待裁决 2(仅 j1 挂载且带快照;卡片徽标另有「待裁决」文本,聚合条按 aria 容器定位)
    const stats = screen.getByLabelText('sunx board aggregate').textContent ?? '';
    expect(stats).toContain('运行中 1');
    expect(stats).toContain('在飞任务 2');
    expect(stats).toContain('待裁决 2');
    // 卡片进度行:在飞 2 · 完成 1;未挂载行计数归零;standard 行滤除(Sunx j4 不在)
    expect(screen.getByText('Sunx j1').textContent).toBeDefined();
    expect(screen.getByText(/在飞 2 · 完成 1/)).toBeDefined();
    expect(screen.queryByText('Sunx j4')).toBeNull();
    // 未挂载行在卡(降级零计数),快照只对 sx1 拉一次且带 bumpSeq:false
    expect(screen.getByText('Sunx j3')).toBeDefined();
    expect(calls.snapshotArgs).toHaveLength(1);
    expect(calls.snapshotArgs[0]!.id).toBe('sx1');
    expect(calls.snapshotArgs[0]!.opts).toEqual({ bumpSeq: false });
    // 待裁决徽标在场(挂起 2)
    expect(screen.getAllByText(/待裁决/).length).toBeGreaterThanOrEqual(2); // 聚合条+卡片徽标
    // 工作区小节头(R10)
    expect(screen.getByText('alpha')).toBeDefined();
  });

  it('点卡片上抛开实例目标(journalId+root,attach 两步由 App 承担)', async () => {
    const { conn } = alphaJ1();
    const onOpenInstance = vi.fn();
    render(<SunxBoardTab conn={conn} onOpenInstance={onOpenInstance} />);
    await waitFor(() => expect(screen.getByText('Sunx j1')).toBeDefined(), { timeout: 2000 });
    fireEvent.click(screen.getByText('Sunx j1'));
    expect(onOpenInstance).toHaveBeenCalledWith({ journalId: 'j1', root: 'D:/w/alpha' });
  });

  it('「新建 Sunx」入口卡开创建弹窗(复用 NewSunxDialog;portal 到 body)', async () => {
    const { conn } = alphaJ1();
    render(<SunxBoardTab conn={conn} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'new sunx' })).toBeDefined(), { timeout: 2000 });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'new sunx' }));
    expect(screen.getByRole('dialog', { name: '新建 Sunx' })).toBeDefined();
  });

  it('刷新钮重拉(workspaces/sessionsOf 再走一轮);加载在途转圈', async () => {
    const { conn, calls } = alphaJ1();
    render(<SunxBoardTab conn={conn} />);
    await waitFor(() => expect(screen.getByText('Sunx j1')).toBeDefined(), { timeout: 2000 });
    expect(calls.workspacesCalls).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(calls.workspacesCalls).toBe(2), { timeout: 2000 });
    await waitFor(() => expect(calls.sessionsCalls).toHaveLength(2), { timeout: 2000 });
  });

  it('空态:无 sunx 会话=空态文案+入口卡仍在(零卡片零节)', async () => {
    const { conn } = stubConn({ sessionsByRoot: { 'D:/w/alpha': [sunxRow('j9', { kind: undefined })] } });
    render(<SunxBoardTab conn={conn} />);
    await waitFor(() => expect(screen.getByText(/还没有 Sunx 实例/)).toBeDefined(), { timeout: 2000 });
    expect(screen.getByRole('button', { name: 'new sunx' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Sunx j9/ })).toBeNull();
  });

  it('快照失败行降级:live 点仍在(行标注)、计数归零、无待裁决徽标,整页不炸', async () => {
    const { conn } = stubConn({
      sessionsByRoot: { 'D:/w/alpha': [sunxRow('j1', { liveSessionId: 'sx1' })] },
      snapshotBoom: true,
    });
    render(<SunxBoardTab conn={conn} />);
    await waitFor(() => expect(screen.getByText('Sunx j1')).toBeDefined(), { timeout: 2000 });
    expect(screen.getByText('Sunx j1').closest('button')!.querySelector('.sx-sunxboard-dot.live')).not.toBeNull();
    expect(screen.getByText(/在飞 0 · 完成 0/)).toBeDefined();
    // 聚合条待裁决=0(快照缺席不计);卡片无徽标——聚合条外无第二处「待裁决」
    expect(screen.getAllByText(/待裁决/)).toHaveLength(1);
  });
});
