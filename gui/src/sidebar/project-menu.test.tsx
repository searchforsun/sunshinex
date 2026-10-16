import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectMenu } from './ProjectMenu';
import type { ProjectMenuConn } from './ProjectMenu';

/**
 * G14.9 launcher IA:会话只在 RECENTS 列(顶部主列表,空态「暂无最近会话」占位);
 * PROJECTS 分组=启动器(点击回欢迎页预选该项目,不再内联列会话);搜索面板项目行同语义。
 * 历史锚:本文件前身为 brief task-4 落盘(适配注记见 git),launcher 化后按新 IA 重写用例。
 */

/** stub conn:一项目组(p1, root 在场)+ 一历史组(p2, root 缺场) */
function makeConn(): ProjectMenuConn & { roots: string[] } {
  const sessionsOfRoots: string[] = [];
  const conn: ProjectMenuConn & { roots: string[] } = {
    roots: sessionsOfRoots,
    workspaces: async () => [
      { slug: 'p1', root: 'D:/w/p1', sessionCount: 1, mtime: Date.now() },
      { slug: 'p2', root: undefined, sessionCount: 1, mtime: Date.now() },
      { slug: 'p3-junk', root: 'C:/Temp/sunshinex/harness-x', sessionCount: 0, mtime: Date.now() },
    ] as never,
    sessionsOf: async (root: string) => {
      sessionsOfRoots.push(root);
      return [{ id: 'j1', firstUser: 'demo goal', updatedAt: Date.now() }] as never;
    },
    recentSessions: async () =>
      [{ id: 'j1', firstUser: 'demo goal', updatedAt: Date.now(), root: 'D:/w/p1', slug: 'p1' }] as never,
    dirpicker: async () => ({ path: 'D:/w', parent: 'D:', dirs: ['p1'] }),
    newSession: async (root: string, mode?: 'manual') => ({ sessionId: `new-${root}${mode ? '-m' : ''}` }),
    createWorkspace: vi.fn(async (body: { name?: string; path?: string }) => ({
      ok: true as const,
      root: body.path ?? `D:/MyWorkStation/sunshinex/${body.name ?? 'project'}`,
      slug: `p-${body.name ?? 'ext'}`,
    })),
    attach: async () => undefined,
    locateWorkspace: async () => ({ path: null }),
  };
  return conn;
}

const open = vi.fn();

function renderMenu(conn: ProjectMenuConn, props?: Partial<Parameters<typeof ProjectMenu>[0]>) {
  return render(
    <ProjectMenu
      conn={conn}
      connState="online"
      activeSessionId=""
      activeRoot=""
      onOpenSession={open}
      onNewChat={() => {}}
      onComposeIn={() => {}}
      {...props}
    />,
  );
}

describe('ProjectMenu(G14.9 launcher IA:RECENTS 主列表 + 项目启动器)', () => {
  it('项目行=展开器(G14.32):点击展开组内会话列表(惰拉 sessionsOf);hover 钮=onComposeIn;root 缺场组禁用', async () => {
    const onComposeIn = vi.fn();
    const conn = makeConn();
    renderMenu(conn, { onComposeIn });
    expect(await screen.findByText('p1')).toBeTruthy();
    expect(screen.getByText('p2')).toBeTruthy();
    expect(screen.getByText('harness-x')).toBeTruthy(); // 0 会话档照常入册(行文案=root basename, G14.189 回退)
    expect((document.querySelector('[data-tip^="root 未登记"]') as HTMLButtonElement).disabled).toBe(true);
    // 组行点击=展开:惰拉 sessionsOf,组内会话行在场(组行/RECENTS 行/recents 去重前同文——取首个)
    fireEvent.click(await screen.findByText('p1'));
    await waitFor(() => expect(conn.roots).toEqual(['D:/w/p1']));
    expect((await screen.findAllByText('demo goal'))[0]).toBeTruthy();
    // 新对话入口移至行尾 hover 钮:点击才 onComposeIn
    fireEvent.click(screen.getByLabelText('new session in p1'));
    expect(onComposeIn).toHaveBeenCalledWith('D:/w/p1');
  });

  it('RECENTS 行=Attach 两步(newSession+attach)→ onOpenSession + 行 active + 未读点消失', async () => {
    const conn = makeConn();
    renderMenu(conn, { activeSessionId: 'new-D:/w/p1' });
    const row = await screen.findByText('demo goal');
    fireEvent.click(row);
    await waitFor(() => expect(open).toHaveBeenCalledWith('new-D:/w/p1', 'D:/w/p1', 'j1')); // G14.213 journalId 随行
    await waitFor(() => expect(row.closest('.sx-session-row')!.className).toContain('active'));
    expect(row.closest('.sx-session-row')!.querySelector('.sx-session-dot.unseen')).toBeNull();
  });

  it('「+ 添加工作区」:浏览器态开服务端 DirPicker → 确认登记既有目录(G14.51 只登记不建目录)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    fireEvent.click(screen.getByRole('button', { name: 'add workspace' }));
    // DirPicker 弹层在场(缺省 home 起;桩回 D:/w)——确认取当前浏览路径
    await screen.findByRole('dialog', { name: 'choose directory' });
    fireEvent.click(await screen.findByRole('button', { name: '选择此目录' }));
    // {path} 分支=登记既有目录;旧 {name} 建目录分支不再被 GUI 触达
    await waitFor(() => expect(conn.createWorkspace).toHaveBeenCalledWith({ path: 'D:/w' }));
  });

  it('「+ 添加工作区」:桌面壳 IPC 回全路径 → createWorkspace({path}) 直登(不开弹层)', async () => {
    const conn = makeConn();
    Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => 'D:/w/p9' } });
    renderMenu(conn);
    fireEvent.click(screen.getByRole('button', { name: 'add workspace' }));
    await waitFor(() => expect(conn.createWorkspace).toHaveBeenCalledWith({ path: 'D:/w/p9' }));
    delete (window as { sunshinex?: unknown }).sunshinex;
  });
});

describe('ProjectMenu G10-C2 侧栏(分区头与 Recents 恒显)', () => {
  it('品牌行/新对话行/Recents·Projects 分区头在场;RECENTS 列出跨工作区最近会话', async () => {
    renderMenu(makeConn(), { activeRoot: '' });
    expect(screen.getByText('Sunshinex')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'new chat' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Recents')).toBeDefined();
    expect(screen.getByText('Projects')).toBeDefined();
    expect(await screen.findAllByText('demo goal')).toHaveLength(1); // 唯一会话列表
  });

  it('New chat:回欢迎页开新对话(onNewChat)', () => {
    const onNewChat = vi.fn();
    renderMenu(makeConn(), { activeRoot: '', onNewChat });
    const btn = screen.getAllByRole('button', { name: 'new chat' })[0] as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('搜索面板项目行:点击同样回欢迎页预选该项目(onComposeIn)', async () => {
    const onComposeIn = vi.fn();
    const conn = makeConn();
    renderMenu(conn, { onComposeIn });
    await screen.findByText('p1');
    fireEvent.click(screen.getByRole('button', { name: 'search' }));
    // 搜索面板在前、组行在后——按容器内按钮精确定位(避免组行同名文本歧义)
    const searchRow = Array.from(document.querySelectorAll('.sx-search-modal button')).find((b) => (b.textContent ?? '').startsWith('p1'));
    fireEvent.click(searchRow!);
    await waitFor(() => expect(onComposeIn).toHaveBeenCalledWith('D:/w/p1'));
  });
});

describe('ProjectMenu G14.115 RECENTS 分页显形(默认 10 条,步进 10,收起复位)', () => {
  it('默认只示 10 条+尾行「Show more」;每次步进 10;全放后「Collapse」复位;分区头折叠再展开回默认', async () => {
    const conn = makeConn();
    conn.recentSessions = async () =>
      Array.from({ length: 25 }, (_, i) => ({
        id: `j${i}`, firstUser: `session ${i}`, updatedAt: Date.now() - i * 1000, root: 'D:/w/p1', slug: 'p1',
      })) as never;
    renderMenu(conn, { activeRoot: '' });
    await waitFor(() => expect(screen.getByText('session 0')).toBeDefined());
    expect(screen.queryByText('session 10')).toBeNull(); // 默认只示 10
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText('session 19')).toBeDefined();
    expect(screen.queryByText('session 20')).toBeNull(); // 步进 10,不一次放完
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText('session 24')).toBeDefined(); // 全量 25
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getByText('session 9')).toBeDefined();
    expect(screen.queryByText('session 10')).toBeNull(); // 收起复位默认
    // 分区头折叠→再展开:同样回默认显形
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText('session 24')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Recents' })); // 折叠(复位)
    fireEvent.click(screen.getByRole('button', { name: 'Recents' })); // 再展开
    expect(screen.getByText('session 9')).toBeDefined();
    expect(screen.queryByText('session 10')).toBeNull();
  });

  it('会话数 ≤ 10:无分页尾行(Show more/Collapse 均不示)', async () => {
    const conn = makeConn();
    conn.recentSessions = async () =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `k${i}`, firstUser: `few ${i}`, updatedAt: Date.now() - i * 1000, root: 'D:/w/p1', slug: 'p1',
      })) as never;
    renderMenu(conn, { activeRoot: '' });
    await waitFor(() => expect(screen.getByText('few 0')).toBeDefined());
    expect(screen.getByText('few 9')).toBeDefined(); // 全量在场
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull();
  });
});
