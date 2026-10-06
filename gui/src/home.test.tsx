import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { DirPickerResp, SessionRow, WorkspaceRow } from './connection';
import { Home } from './pages/Home';
import type { HomeConn } from './pages/Home';
import { DirPicker } from './pages/DirPicker';

/**
 * G3.5 首页桩测:Home(工作区列表/展开会话/attach 两步链/New→DirPicker 交互链/空态/错误面)
 * 与 DirPicker 组件(逐级浏览/自定义输入/确认取值/取消/服务端错误)——conn 全桩(HTTP 面
 * 不出网),真链在 e2e.test.ts。G5:会话行 Delete 退役(journal id 寻址恒 404——回收改
 * Chat 顶栏 Delete 按 daemon 会话 id;本套钉「行内无 Delete」负断言)+ toggleRow slug
 * 守卫(慢应答丢弃)。G6:DirPicker「Manual approvals」勾选 → Home newSession(root, mode)
 * ——mode 参数面桩测(UI 真面全链在 e2e)。
 */

/** Home/DirPicker 桩 conn:调用记录可断言;应答面可注入(含失败注入) */
interface StubOpts {
  rows?: WorkspaceRow[];
  sessions?: SessionRow[];
  dirs?: DirPickerResp[];
  newSessionId?: string;
  newSessionFail?: Error;
  attachFail?: Error;
}
interface Stub {
  conn: HomeConn;
  calls: {
    workspaces: number;
    sessionsOf: string[];
    dirpicker: Array<string | undefined>;
    newSession: Array<[string, 'manual' | undefined]>;
    attach: Array<[string, string]>;
  };
}
function stubConn(opts: StubOpts = {}): Stub {
  const calls: Stub['calls'] = { workspaces: 0, sessionsOf: [], dirpicker: [], newSession: [], attach: [] };
  const conn: HomeConn = {
    workspaces: () => {
      calls.workspaces += 1;
      return Promise.resolve(opts.rows ?? []);
    },
    sessionsOf: (root: string) => {
      calls.sessionsOf.push(root);
      return Promise.resolve(opts.sessions ?? []);
    },
    dirpicker: (path?: string) => {
      calls.dirpicker.push(path);
      const next = opts.dirs?.[calls.dirpicker.length - 1] ?? { path: path ?? '/home', parent: '/', dirs: [] };
      return Promise.resolve(next);
    },
    newSession: (root: string, mode?: 'manual') => {
      calls.newSession.push([root, mode]);
      if (opts.newSessionFail !== undefined) return Promise.reject(opts.newSessionFail);
      return Promise.resolve({ sessionId: opts.newSessionId ?? 's1' });
    },
    attach: (sessionId: string, journalId: string) => {
      calls.attach.push([sessionId, journalId]);
      if (opts.attachFail !== undefined) return Promise.reject(opts.attachFail);
      return Promise.resolve();
    },
  };
  return { conn, calls };
}

const wsRow = (over: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
  root: '/w/root-a',
  slug: 'root-a-ab12cd34',
  mtime: 1_700_000_000_000,
  sessionCount: 1,
  ...over,
});
const sessRow = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 'j-20261006a',
  file: '/data/sessions/j-20261006a.jsonl',
  updatedAt: 1_700_000_100_000,
  firstUser: '修一个 bug',
  ...over,
});

/** 展开工作区行:点行 → 等会话列表容器挂出(0..N 会话行均到达) */
const openRow = async (): Promise<void> => {
  await screen.findByText('root-a-ab12cd34');
  fireEvent.click(screen.getByRole('button', { name: /root-a-ab12cd34/ }));
  await waitFor(() => expect(screen.getByLabelText('sessions')).toBeDefined());
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Home:工作区列表与展开', () => {
  it('挂载即拉 workspaces 渲染行;刷新按钮再拉', async () => {
    const { conn, calls } = stubConn({ rows: [wsRow()] });
    render(<Home conn={conn} onOpenSession={() => {}} />);
    expect(await screen.findByText('root-a-ab12cd34')).toBeDefined();
    expect(screen.getByText('1 sessions')).toBeDefined();
    expect(calls.workspaces).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'refresh workspaces' }));
    expect(calls.workspaces).toBe(2);
  });

  it('root 在场行展开 → sessionsOf(root) 会话行(摘要/摘要缺省回退)', async () => {
    const { conn, calls } = stubConn({
      rows: [wsRow()],
      sessions: [sessRow(), sessRow({ id: 'j2', firstUser: undefined, updatedAt: 2 })],
    });
    render(<Home conn={conn} onOpenSession={() => {}} />);
    await openRow();
    expect(await screen.findAllByRole('button', { name: 'Attach' })).toHaveLength(2);
    expect(calls.sessionsOf).toEqual(['/w/root-a']);
    expect(screen.getByText('修一个 bug')).toBeDefined();
    expect(screen.getByText('(无摘要)')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Attach' })).toHaveLength(2);
    // 右栏详情:选中工作区 root/会话数
    expect(screen.getByText('/w/root-a')).toBeDefined();
  });

  it('root 缺场行(历史工作区):禁用 + 提示,不触发 sessionsOf', async () => {
    const { conn, calls } = stubConn({ rows: [wsRow({ root: undefined, slug: 'legacy-ff99' })] });
    render(<Home conn={conn} onOpenSession={() => {}} />);
    expect(await screen.findByText('legacy-ff99')).toBeDefined();
    expect(screen.getByText('root 未登记,不可恢复')).toBeDefined();
    const toggle = screen.getByRole('button', { name: /legacy-ff99/ }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(calls.sessionsOf).toEqual([]);
  });

  it('展开无会话:暂无会话占位', async () => {
    const { conn } = stubConn({ rows: [wsRow()], sessions: [] });
    render(<Home conn={conn} onOpenSession={() => {}} />);
    await openRow();
    expect(screen.getByText(/暂无会话/)).toBeDefined();
  });

  it('空态:无工作区 → 引导文案,New session 仍可用', async () => {
    const { conn } = stubConn({ rows: [] });
    render(<Home conn={conn} onOpenSession={() => {}} />);
    expect(await screen.findByText('尚无工作区。')).toBeDefined();
    expect(screen.getByText(/开启第一个会话/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'New session' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('workspaces 失败:错误示出(不静默)', async () => {
    const conn: HomeConn = {
      ...stubConn().conn,
      workspaces: () => Promise.reject(new Error('/workspaces -> 500')),
    };
    render(<Home conn={conn} onOpenSession={() => {}} />);
    expect(await screen.findByText('/workspaces -> 500')).toBeDefined();
  });
});

describe('Home:attach 与 New session 动作链', () => {
  it('Attach 点击:newSession(root) → attach(sessionId, journalId) 两步链 → onOpenSession(newId)', async () => {
    const { conn, calls } = stubConn({
      rows: [wsRow()],
      sessions: [sessRow()],
      newSessionId: 's7',
    });
    const opened: string[] = [];
    render(<Home conn={conn} onOpenSession={(id) => opened.push(id)} />);
    await openRow();
    await screen.findByRole('button', { name: 'Attach' });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(opened).toEqual(['s7']));
    expect(calls.newSession).toEqual([['/w/root-a', undefined]]); // Attach 链不带 mode(缺省)
    expect(calls.attach).toEqual([['s7', 'j-20261006a']]);
  });

  it('Attach 失败(newSession 400):错误示出,不进会话', async () => {
    const { conn, calls } = stubConn({
      rows: [wsRow()],
      sessions: [sessRow()],
      newSessionFail: new Error('/session/new -> 400'),
    });
    const opened: string[] = [];
    render(<Home conn={conn} onOpenSession={(id) => opened.push(id)} />);
    await openRow();
    await screen.findByRole('button', { name: 'Attach' });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    expect(await screen.findByText('/session/new -> 400')).toBeDefined();
    expect(opened).toEqual([]);
    expect(calls.attach).toEqual([]);
  });

  it('Attach 二步失败(attach 500):错误示出、busy 复位、停留首页(T4δ 收口)', async () => {
    const { conn, calls } = stubConn({
      rows: [wsRow()],
      sessions: [sessRow()],
      newSessionId: 's1',
      attachFail: new Error('/session/s1/attach -> 500'),
    });
    const opened: string[] = [];
    render(<Home conn={conn} onOpenSession={(id) => opened.push(id)} />);
    await openRow();
    await screen.findByRole('button', { name: 'Attach' });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    // 错误示出(不静默);两步链已走完第一步(newSession 成功,attach 拒)
    expect(await screen.findByText('/session/s1/attach -> 500')).toBeDefined();
    expect(calls.newSession).toEqual([['/w/root-a', undefined]]);
    expect(calls.attach).toEqual([['s1', 'j-20261006a']]);
    // 停留首页 + 不进会话
    expect(opened).toEqual([]);
    expect(screen.getByRole('region', { name: 'workspaces' })).toBeDefined();
    // busy 复位:Attach 按钮重新可用(可重试)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Attach' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('New session → DirPicker 模态(首载 dirpicker())→ 自定义路径输入确认 → newSession → onOpenSession', async () => {
    const { conn, calls } = stubConn({
      dirs: [{ path: '/home/dev', parent: '/home', dirs: ['proj-x'] }],
      newSessionId: 's2',
    });
    const opened: string[] = [];
    render(<Home conn={conn} onOpenSession={(id) => opened.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    // 模态在场:首载无 path(dirpicker() 缺省)→ 当前路径渲染
    expect(await screen.findByRole('dialog', { name: 'choose directory' })).toBeDefined();
    expect(await screen.findByText('/home/dev')).toBeDefined();
    expect(calls.dirpicker).toEqual([undefined]);
    // 自定义路径输入 → 确认(取输入值)
    fireEvent.change(screen.getByLabelText('custom path'), { target: { value: 'D:/work/proj' } });
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    await waitFor(() => expect(opened).toEqual(['s2']));
    expect(calls.newSession).toEqual([['D:/work/proj', undefined]]); // 缺省不勾:mode 不发
  });

  it('G6 mode 面:DirPicker 勾选 Manual approvals → newSession(root, manual);缺省不勾不带 mode', async () => {
    const { conn, calls } = stubConn({
      dirs: [
        { path: '/home/dev', parent: '/home', dirs: [] },
        { path: '/home/dev', parent: '/home', dirs: [] }, // 第二次打开模态的首载
      ],
      newSessionId: 's3',
    });
    const opened: string[] = [];
    render(<Home conn={conn} onOpenSession={(id) => opened.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    await screen.findByRole('dialog', { name: 'choose directory' });
    // 缺省不勾先确认一次:mode undefined
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    await waitFor(() => expect(opened).toEqual(['s3']));
    expect(calls.newSession).toEqual([['/home/dev', undefined]]);
    // 重开 DirPicker:勾选 Manual approvals → mode 'manual'
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    await screen.findByRole('dialog', { name: 'choose directory' });
    expect((screen.getByLabelText('Manual approvals') as HTMLInputElement).checked).toBe(false); // 缺省不勾(每开重置)
    fireEvent.click(screen.getByLabelText('Manual approvals'));
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    await waitFor(() => expect(opened).toEqual(['s3', 's3']));
    expect(calls.newSession).toEqual([
      ['/home/dev', undefined],
      ['/home/dev', 'manual'],
    ]);
  });

  it('New session 确认失败(daemon 400):错误在模态内示出,不进会话', async () => {
    const { conn, calls } = stubConn({
      dirs: [{ path: '/home', parent: '/', dirs: [] }],
      newSessionFail: new Error('/session/new -> 400'),
    });
    const opened: string[] = [];
    render(<Home conn={conn} onOpenSession={(id) => opened.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    await screen.findByRole('dialog', { name: 'choose directory' });
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    expect(await screen.findByText('/session/new -> 400')).toBeDefined();
    expect(opened).toEqual([]);
    expect(calls.newSession).toEqual([['/home', undefined]]);
  });
});

describe('Home:G5 会话行 Delete 退役与展开竞态守卫', () => {
  it('会话行无 Delete 按钮(G5 退役:journal id 寻址恒 404——回收改 Chat 顶栏 Delete)', async () => {
    const { conn } = stubConn({ rows: [wsRow()], sessions: [sessRow()] });
    render(<Home conn={conn} onOpenSession={() => {}} />);
    await openRow();
    expect(screen.getByText('修一个 bug')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^delete / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('toggle 守卫:展开 A 应答在途切到 B → A 慢应答丢弃(B 列表不被冲)', async () => {
    const pending: Array<(list: SessionRow[]) => void> = [];
    const base = stubConn({ rows: [wsRow({ root: '/w/a', slug: 'ws-a' }), wsRow({ root: '/w/b', slug: 'ws-b' })] });
    const calls = { a: 0, b: 0 };
    const conn: HomeConn = {
      ...base.conn,
      sessionsOf: (root: string) => {
        if (root === '/w/a') {
          calls.a += 1;
          return new Promise((resolve) => pending.push(resolve));
        }
        calls.b += 1;
        return Promise.resolve([sessRow({ id: 'jb', firstUser: 'B 会话' })]);
      },
    };
    render(<Home conn={conn} onOpenSession={() => {}} />);
    await screen.findByText('ws-a');
    fireEvent.click(screen.getByRole('button', { name: /ws-a/ }));
    await waitFor(() => expect(calls.a).toBe(1)); // A 应答在途
    fireEvent.click(screen.getByRole('button', { name: /ws-b/ })); // 切到 B(slug 已非 A)
    expect(await screen.findByText('B 会话')).toBeDefined();
    // A 慢应答到达:slug 守卫丢弃——B 列表不被冲
    await act(async () => {
      pending[0]!([sessRow({ id: 'ja', firstUser: 'A 迟到会话' })]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText('A 迟到会话')).toBeNull();
    expect(screen.getByText('B 会话')).toBeDefined();
  });
});

describe('DirPicker 组件(独立 props)', () => {
  const dirConn = (dirs: DirPickerResp[]) => {
    const calls: Array<string | undefined> = [];
    const conn = {
      dirpicker: (path?: string) => {
        calls.push(path);
        const next = dirs[calls.length - 1] ?? { path: path ?? '/home', parent: '/', dirs: [] };
        return Promise.resolve(next);
      },
    };
    return { conn, calls };
  };

  it('挂载即 dirpicker()(缺省路径)渲染当前路径与子目录', async () => {
    const { conn, calls } = dirConn([{ path: '/home', parent: '/', dirs: ['dev', 'tmp'] }]);
    render(<DirPicker conn={conn} onConfirm={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText('/home')).toBeDefined();
    expect(calls).toEqual([undefined]);
    expect(screen.getByRole('button', { name: 'dev' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'tmp' })).toBeDefined();
  });

  it('逐级:点子目录 dirpicker(拼接路径);「↑ 上级」dirpicker(parent)', async () => {
    const { conn, calls } = dirConn([
      { path: '/home', parent: '/', dirs: ['dev'] },
      { path: '/home/dev', parent: '/home', dirs: ['proj'] },
      { path: '/home', parent: '/', dirs: ['dev'] },
    ]);
    render(<DirPicker conn={conn} onConfirm={() => {}} onCancel={() => {}} />);
    await screen.findByText('/home');
    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    expect(await screen.findByText('/home/dev')).toBeDefined();
    expect(calls[1]).toBe('/home/dev');
    fireEvent.click(screen.getByRole('button', { name: '↑ 上级' }));
    await waitFor(() => expect(calls[2]).toBe('/home'));
  });

  it('盘根形态(parent=自身):上级按钮禁用', async () => {
    const { conn: rootConn } = dirConn([{ path: '/', parent: '/', dirs: [] }]);
    render(<DirPicker conn={rootConn} onConfirm={() => {}} onCancel={() => {}} />);
    await screen.findByText('/');
    expect((screen.getByRole('button', { name: '↑ 上级' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('确认取值:自定义输入非空优先(不经服务端);输入空取当前浏览路径', async () => {
    const { conn } = dirConn([{ path: '/home/dev', parent: '/home', dirs: [] }]);
    const confirmed: string[] = [];
    render(<DirPicker conn={conn} onConfirm={(p) => confirmed.push(p)} onCancel={() => {}} />);
    await screen.findByText('/home/dev');
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    expect(confirmed).toEqual(['/home/dev']);
    fireEvent.change(screen.getByLabelText('custom path'), { target: { value: 'D:/elsewhere' } });
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    expect(confirmed).toEqual(['/home/dev', 'D:/elsewhere']);
  });

  it('G6 manual 勾选:缺省不勾 → onConfirm(path, false);勾选 → onConfirm(path, true)', async () => {
    const { conn } = dirConn([{ path: '/home/dev', parent: '/home', dirs: [] }]);
    const confirmed: Array<[string, boolean]> = [];
    render(<DirPicker conn={conn} onConfirm={(p, m) => confirmed.push([p, m])} onCancel={() => {}} />);
    await screen.findByText('/home/dev');
    const box = screen.getByLabelText('Manual approvals') as HTMLInputElement;
    expect(box.checked).toBe(false); // 缺省不勾
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    expect(confirmed).toEqual([['/home/dev', false]]);
    fireEvent.click(box); // 勾选
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    expect(confirmed).toEqual([
      ['/home/dev', false],
      ['/home/dev', true],
    ]);
  });

  it('「前往」:自定义路径经服务端校验(dirpicker(typed))→ 当前路径切换', async () => {
    const { conn, calls } = dirConn([
      { path: '/home', parent: '/', dirs: [] },
      { path: 'D:/work', parent: 'D:/', dirs: ['proj'] },
    ]);
    render(<DirPicker conn={conn} onConfirm={() => {}} onCancel={() => {}} />);
    await screen.findByText('/home');
    fireEvent.change(screen.getByLabelText('custom path'), { target: { value: 'D:/work' } });
    fireEvent.click(screen.getByRole('button', { name: '前往' }));
    expect(await screen.findByText('D:/work')).toBeDefined();
    expect(calls[1]).toBe('D:/work');
    expect(screen.getByRole('button', { name: 'proj' })).toBeDefined();
  });

  it('取消: onCancel 回调', async () => {
    const { conn } = dirConn([{ path: '/home', parent: '/', dirs: [] }]);
    let cancelled = 0;
    render(<DirPicker conn={conn} onConfirm={() => {}} onCancel={() => (cancelled += 1)} />);
    await screen.findByText('/home');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(cancelled).toBe(1);
  });

  it('服务端 400(路径不存在):错误示出,列表停留', async () => {
    const calls: Array<string | undefined> = [];
    const conn = {
      dirpicker: (path?: string) => {
        calls.push(path);
        return calls.length === 1
          ? Promise.resolve({ path: '/home', parent: '/', dirs: [] })
          : Promise.reject(new Error('/dirpicker?path=%2Fnope -> 400'));
      },
    };
    render(<DirPicker conn={conn} onConfirm={() => {}} onCancel={() => {}} />);
    await screen.findByText('/home');
    fireEvent.change(screen.getByLabelText('custom path'), { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: '前往' }));
    expect(await screen.findByText('/dirpicker?path=%2Fnope -> 400')).toBeDefined();
    expect(screen.getByText('/home')).toBeDefined(); // 停留原列表
  });
});
