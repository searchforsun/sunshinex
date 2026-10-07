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
    dirpicker: async () => ({ path: 'D:/w', parent: 'D:', dirs: ['p1'] }),
    newSession: async (root: string, mode?: 'manual') => ({ sessionId: `new-${root}${mode ? '-m' : ''}` }),
    attach: async () => undefined,
  };
  return conn;
}

const open = vi.fn();

function renderMenu(conn: ProjectMenuConn, props?: Partial<Parameters<typeof ProjectMenu>[0]>) {
  return render(
    <ProjectMenu conn={conn} connState="online" activeSessionId="" activeRoot="" onOpenSession={open} {...props} />,
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
    fireEvent.click(await screen.findByText('Attach'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('new-D:/w/p1', 'D:/w/p1'));
  });

  it('组内「+」新建:mode 弹层选 auto→newSession(root)→onOpenSession', async () => {
    const conn = makeConn();
    renderMenu(conn);
    fireEvent.click(await screen.findByText('p1'));
    fireEvent.click(await screen.findByRole('button', { name: 'new session in p1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /auto/i }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('new-D:/w/p1', 'D:/w/p1'));
  });

  it('组内「+」新建:manual→newSession(root,"manual")', async () => {
    const conn = makeConn();
    renderMenu(conn);
    fireEvent.click(await screen.findByText('p1'));
    fireEvent.click(await screen.findByRole('button', { name: 'new session in p1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /manual/i }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('new-D:/w/p1-m', 'D:/w/p1'));
  });

  it('activeRoot 组自动展开;当前会话行 active 态', async () => {
    const conn = makeConn();
    renderMenu(conn, { activeSessionId: 'new-D:/w/p1', activeRoot: 'D:/w/p1' });
    const row = await screen.findByText('demo goal');
    expect(row.closest('.sx-session-row')!.className).toContain('active');
  });

  it('「+ 添加工作区」开 DirPicker 模态(测试钩子 class 复用)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    fireEvent.click(screen.getByText('+ 添加工作区'));
    // 适配(brief 注允许):DirPicker 既有可定位面为 role=dialog aria-label="choose directory";
    // 原 getByTitle('dirpicker') 钩子不在场——断言语义不变 = 模态在场
    expect(screen.getByRole('dialog', { name: 'choose directory' })).toBeTruthy();
  });

  it('底栏显示连接态点', () => {
    renderMenu(makeConn());
    expect(screen.getByLabelText('connection: online')).toBeTruthy();
  });
});
