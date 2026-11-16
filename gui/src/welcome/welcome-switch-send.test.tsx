import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomeComposer } from './WelcomeComposer';
import { setLanguage } from '../i18n';
import type { WelcomeComposerConn } from './welcome-conn';

/** 欢迎页「切换并发送」弹窗编排测(2026-11-16 用户实测四反馈回归锚):
 *  ①弹窗不可点击=确认钮曾指回 send() 回环重开弹窗(重拉代价面+清提交信息),永远到不了 doSend
 *  ②统计中缺加载态:误导性未提交文案+确认钮可盲点
 *  ③弹窗在场 composer 发送钮未禁用。
 *  桩面:project/branch 经 localStorage 持久键播种(恢复单次闸即选中分支,免点穿分支菜单) */

type Stat = { files: number; added: number; deleted: number; dirty: number; dirtyAdded: number; dirtyDeleted: number; missing: boolean };

function mkConn(): WelcomeComposerConn & Record<string, ReturnType<typeof vi.fn>> {
  const conn = {
    dirpicker: vi.fn(async () => ({ path: '/w', parent: '/', dirs: [] })),
    workspaces: vi.fn(async () => [{ slug: 'repo', root: '/w/repo', sessionCount: 0 }]),
    newSession: vi.fn(async () => ({ sessionId: 's9' })),
    createWorkspace: vi.fn(async () => ({ ok: true as const, root: '/w/repo', slug: 'repo' })),
    locateWorkspace: vi.fn(async () => ({ path: null })),
    gitBranches: vi.fn(async () => ({ current: 'main', branches: ['main', 'feature'] })),
    gitCheckout: vi.fn(async () => undefined),
    gitCommitCheckout: vi.fn(async () => undefined),
    gitBranchCreate: vi.fn(async () => undefined),
    gitFetchRemote: vi.fn(async () => ({ fetched: [] })),
    branchDiffStat: vi.fn(async (): Promise<Stat> => ({ files: 3, added: 9, deleted: 2, dirty: 1, dirtyAdded: 4, dirtyDeleted: 1, missing: false })),
    commands: vi.fn(async () => ({ commands: [], descriptions: {}, supported: [] })),
    skillsGroups: vi.fn(async () => ({ groups: [] })),
    tree: vi.fn(async () => ({ entries: [] })),
    settings: vi.fn(async () => ({ keys: [], providers: { choices: [] } })),
    workspaceFiles: vi.fn(async () => ({ files: [] })),
    setSessionModel: vi.fn(async () => undefined),
    setSessionEffort: vi.fn(async () => undefined),
    setSessionMode: vi.fn(async () => undefined),
  };
  return conn as unknown as WelcomeComposerConn & Record<string, ReturnType<typeof vi.fn>>;
}

async function mountPickedFeature(conn: WelcomeComposerConn, onOpened: (id: string, root: string, goal: string) => void): Promise<void> {
  render(<WelcomeComposer conn={conn} onOpened={onOpened} />);
  const goal = await screen.findByLabelText('welcome goal');
  fireEvent.change(goal, { target: { value: 'do it' } });
  // 分支恢复单次闸:gitBr 到位后 sx-welcome:branch 播种即预选 feature(选项条文案可见)
  await screen.findByText('feature');
}

beforeEach(() => {
  setLanguage('en');
  localStorage.clear();
});

describe('欢迎页「切换并发送」弹窗(2026-11-16 实测四反馈)', () => {
  it('确认直进提交并切换再建会话,代价面只拉一次(回环根修:不再重开弹窗清提交信息)', async () => {
    localStorage.setItem('sx-welcome:project', '/w/repo');
    localStorage.setItem('sx-welcome:branch', 'feature');
    const conn = mkConn();
    const onOpened = vi.fn();
    await mountPickedFeature(conn, onOpened);
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await screen.findByRole('dialog', { name: 'Switch and send' });
    expect(conn.branchDiffStat).toHaveBeenCalledWith('/w/repo', 'feature');
    await screen.findByText(/will be committed first/); // 脏面代价到齐
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'WIP_ before switch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch and send' }));
    await waitFor(() => expect(conn.gitCommitCheckout).toHaveBeenCalledTimes(1));
    expect(conn.gitCommitCheckout).toHaveBeenCalledWith('/w/repo', 'feature', false, 'WIP_ before switch');
    await waitFor(() => expect(conn.newSession).toHaveBeenCalledWith('/w/repo', undefined, false, undefined));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith('s9', '/w/repo', 'do it', undefined));
    expect(conn.branchDiffStat).toHaveBeenCalledTimes(1); // 回环回归:确认不再重拉代价面
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch and send' })).toBeNull());
  });

  it('统计中显式加载态:误导性未提交文案退场,确认钮与 composer 发送钮均禁用;取消即恢复', async () => {
    localStorage.setItem('sx-welcome:project', '/w/repo');
    localStorage.setItem('sx-welcome:branch', 'feature');
    const conn = mkConn();
    let resolveStat: ((v: Stat) => void) | null = null;
    conn.branchDiffStat = vi.fn(
      () =>
        new Promise<Stat>((res) => {
          resolveStat = res;
        }),
    );
    await mountPickedFeature(conn, vi.fn());
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await screen.findByRole('dialog', { name: 'Switch and send' });
    expect(screen.getByText('Counting branch differences…')).toBeTruthy();
    expect(screen.queryByText(/may block the switch/)).toBeNull(); // 统计中不再误示未提交文案
    const primary = screen.getByRole('button', { name: 'Counting…' });
    expect((primary as HTMLButtonElement).disabled).toBe(true); // 待数盲确认禁令
    expect((screen.getByRole('button', { name: 'send' }) as HTMLButtonElement).disabled).toBe(true); // 弹窗在场发送钮禁用
    expect(resolveStat).not.toBeNull();
    resolveStat!({ files: 3, added: 9, deleted: 2, dirty: 1, dirtyAdded: 4, dirtyDeleted: 1, missing: false });
    await screen.findByText(/will be committed first/);
    expect((screen.getByRole('button', { name: 'Switch and send' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((screen.getByRole('button', { name: 'send' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('提交并切换失败:收弹窗回 composer 错误条,发送钮恢复可重发(不困于覆盖层之下)', async () => {
    localStorage.setItem('sx-welcome:project', '/w/repo');
    localStorage.setItem('sx-welcome:branch', 'feature');
    const conn = mkConn();
    conn.gitCommitCheckout = vi.fn(async () => {
      throw new Error('identity not configured');
    });
    await mountPickedFeature(conn, vi.fn());
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await screen.findByRole('dialog', { name: 'Switch and send' });
    await screen.findByText(/will be committed first/);
    fireEvent.click(screen.getByRole('button', { name: 'Switch and send' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch and send' })).toBeNull());
    await screen.findByText('identity not configured'); // 错误在 composer 错误条可见
    expect((screen.getByRole('button', { name: 'send' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
