import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectMenu } from './ProjectMenu';
import type { ProjectMenuConn } from './ProjectMenu';

/**
 * 落盘说明(brief task-4):本文件 = brief 测试代码逐字落盘,唯三适配(brief 原文在本仓
 * RTL16+React18.3+tsc strict 环境无法转绿,详见 task-4-report.md):
 * 1) DirPicker 模态断言(brief 明文允许)——以 DirPicker 既有 role=dialog 面;
 * 2) 前四例的 p1 定位改 await findByText——RTL render 为同步 act(dist/pure.js renderRoot
 *    证实,asyncWrapper 仅挂 waitFor),不冲已 resolve promise 的微任务续体,同步
 *    getByText 恒 miss;同元素同断言语义,home.test.tsx 既有同款惯例。
 * 3) stub 的 roots 注解 string[][] 改 string[]——brief 笔误(push 的是 root 字符串且断言
 *    toEqual(['D:/w/p1']),运行时本就是 string[];纯类型面,运行时零改动)。
 */

/** stub conn:一项目组(p1, root 在场)+ 一历史组(p2, root 缺场) */
function makeConn(): ProjectMenuConn & { roots: string[] } {
  const sessionsOfRoots: string[] = [];
  const conn: ProjectMenuConn & { roots: string[] } = {
    roots: sessionsOfRoots,
    workspaces: async () => [
      { slug: 'p1', root: 'D:/w/p1', sessionCount: 1, mtime: Date.now() },
      { slug: 'p2', root: undefined, sessionCount: 0, mtime: Date.now() },
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

describe('ProjectMenu(spec §1 左栏项目分组)', () => {
  it('工作区=组;组头点击展开惰拉 sessions(root 缺场组禁用)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    expect(await screen.findByText('p1')).toBeTruthy();
    expect(screen.getByText('p2')).toBeTruthy();
    expect((screen.getByTitle(/root 未登记/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByText('p1'));
    expect(await screen.findByText('demo goal')).toBeTruthy();
    expect(conn.roots).toEqual(['D:/w/p1']); // 惰拉:仅展开才请求
  });

  it('Attach 两步(newSession+attach)→ onOpenSession(sessionId, root)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    fireEvent.click(await screen.findByText('p1'));
    fireEvent.click(await screen.findByTitle('打开会话'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('new-D:/w/p1', 'D:/w/p1'));
  });

  it('组内「+」:回欢迎页并预选该项目(onComposeIn)', async () => {
    const onComposeIn = vi.fn();
    renderMenu(makeConn(), { activeRoot: '', onComposeIn });
    fireEvent.click(await screen.findByText('p1'));
    fireEvent.click(screen.getByRole('button', { name: 'new session in p1' }));
    expect(onComposeIn).toHaveBeenCalledWith('D:/w/p1');
  });

  it('组内「+」(manual 档测试):同样回欢迎页预选该项目', async () => {
    const onComposeIn = vi.fn();
    renderMenu(makeConn(), { activeRoot: '', onComposeIn });
    fireEvent.click(await screen.findByText('p1'));
    fireEvent.click(screen.getByRole('button', { name: 'new session in p1' }));
    expect(onComposeIn).toHaveBeenCalledWith('D:/w/p1');
  });

  it('activeRoot 组自动展开;点开的会话行 active(journal 映射),未点开不亮', async () => {
    const conn = makeConn();
    renderMenu(conn, { activeSessionId: 'new-D:/w/p1', activeRoot: 'D:/w/p1' });
    const row = await screen.findByText('demo goal');
    // 未点开(无 journal 映射):行不亮——root 兜底退役(整组全亮读作误 hover)
    expect(row.closest('.sx-session-row')!.className).not.toContain('active');
    // 点开会话行:attach 两步记下会话 id ↔ journal 行映射 → 行 active + 未读蓝点消失
    fireEvent.click(row);
    await waitFor(() => expect(row.closest('.sx-session-row')!.className).toContain('active'));
    expect(row.closest('.sx-session-row')!.querySelector('.sx-session-dot.unseen')).toBeNull();
  });

  it('「+ 添加工作区」:原生选择器选完 → createWorkspace 建项目(G10-C11)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    // jsdom 无 showDirectoryPicker——桩一个原生选择器(选回名字 p9)
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => ({ name: 'p9' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'add workspace' }));
    await waitFor(() => expect(conn.createWorkspace).toHaveBeenCalledWith({ name: 'p9' }));
    delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

});

describe('ProjectMenu G10-C2 侧栏双区 IA', () => {
  it('品牌行/新对话行/Projects·Recents 分区头在场;Recents 扁平列出跨工作区最近会话', async () => {
    renderMenu(makeConn(), { activeRoot: '' });
    expect(screen.getByText('Sunshinex')).toBeDefined();
    expect(screen.getByRole('button', { name: 'new chat' })).toBeDefined();
    expect(screen.getByText('Projects')).toBeDefined();
    expect(screen.getByText('Recents')).toBeDefined();
    expect(await screen.findAllByText('demo goal')).toHaveLength(1); // 组收起态:仅 Recents 行(组展开后组内行再现)
  });

  it('New chat:回欢迎页开新对话(onNewChat)', () => {
    const onNewChat = vi.fn();
    renderMenu(makeConn(), { activeRoot: '', onNewChat });
    expect((screen.getByRole('button', { name: 'new chat' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'new chat' }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('项目行 +:回欢迎页并预选该项目(onComposeIn)', async () => {
    const onComposeIn = vi.fn();
    renderMenu(makeConn(), { activeRoot: '', onComposeIn });
    fireEvent.click(await screen.findByText('p1')); // 展开组
    fireEvent.click(screen.getByRole('button', { name: 'new session in p1' }));
    expect(onComposeIn).toHaveBeenCalledWith('D:/w/p1');
  });
});
