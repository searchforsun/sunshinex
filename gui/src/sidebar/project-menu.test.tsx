import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ProjectMenu } from './ProjectMenu';
import type { ProjectMenuConn } from './ProjectMenu';

/**
 * G14.9 launcher IA:会话只在 RECENTS 列(顶部主列表,空态「暂无最近会话」占位);
 * PROJECTS 分组=启动器(点击回欢迎页预选该项目,不再内联列会话);搜索面板项目行同语义。
 * 历史锚:本文件前身为 brief task-4 落盘(适配注记见 git),launcher 化后按新 IA 重写用例。
 */

/** stub conn:一项目组(p1, root 在场)+ 一历史组(p2, root 缺场) */
const FIXED_TS = 1_728_000_000_000; // 会话行时间戳钉值(夹具确定性——见 sessionsOf 注)

function makeConn(): ProjectMenuConn & { roots: string[] } {
  const sessionsOfRoots: string[] = [];
  const conn: ProjectMenuConn & { roots: string[] } = {
    roots: sessionsOfRoots,
    workspaces: vi.fn(async () => [
      { slug: 'p1', root: 'D:/w/p1', sessionCount: 1, mtime: Date.now() },
      { slug: 'p2', root: undefined, sessionCount: 1, mtime: Date.now() },
      { slug: 'p3-junk', root: 'C:/Temp/sunshinex/harness-x', sessionCount: 0, mtime: Date.now() },
    ] as never),
    sessionsOf: async (root: string) => {
      sessionsOfRoots.push(root);
      // 时间戳钉常量:点击后的 loadWorkspaces 重拉会再次取 updatedAt——取 Date.now() 时重拉值
      // 新于 markSeen 时刻即未读点复现(同毫秒才通过,毫秒掷硬币抖动源)
      return [{ id: 'j1', firstUser: 'demo goal', updatedAt: FIXED_TS }] as never;
    },
    recentSessions: async () =>
      [{ id: 'j1', firstUser: 'demo goal', updatedAt: FIXED_TS, root: 'D:/w/p1', slug: 'p1' }] as never,
    dirpicker: async () => ({ path: 'D:/w', parent: 'D:', dirs: ['p1'] }),
    newSession: async (root: string, mode?: 'acceptEdits' | 'full-access') => ({ sessionId: `new-${root}${mode ? '-m' : ''}` }),
    // sunx P2 Task 6:模板清单桩(空清单=选择器隐藏态;ProjectMenuConn 新增面)
    sunxTemplates: vi.fn(async () => ({ entries: [], warnings: [] })),
    createWorkspace: vi.fn(async (body: { name?: string; path?: string }) => ({
      ok: true as const,
      root: body.path ?? `D:/MyWorkStation/sunshinex/${body.name ?? 'project'}`,
      slug: `p-${body.name ?? 'ext'}`,
    })),
    attach: async (sessionId: string) => ({ sessionId, root: 'D:/w/p1' }), // 无收编形态:原样回 id+根(收编面在 daemon 钉测)
    archiveSession: vi.fn(async () => undefined), // T6 行内归档落库面(重拉断言消费 workspaces spy)
    appPins: vi.fn(async () => ({ pins: [] })), // 置顶档(归档区/置顶组测试消费)
    saveAppPins: vi.fn(async () => undefined),
    appSeen: vi.fn(async () => ({ seen: {} })), // 已读档(2026-10-23 落底层)
    saveAppSeen: vi.fn(async () => undefined),
    hideWorkspace: vi.fn(async () => undefined), // 移除工作区(2026-10-23)
    archivedSessions: vi.fn(async () => [
      // 归档区(2026-10-21 侧栏 ArchiveSection)数据面:跨工作区聚合行
      { id: 'a1', slug: 'p1', root: 'D:/w/p1', title: '已归档会话', updatedAt: FIXED_TS, archivedAt: FIXED_TS },
    ]) as never,
    deleteSession: vi.fn(async () => undefined), // 受控删除(归档区红删除确认面)
    locateWorkspace: async () => ({ path: null }),
    gitBranches: async () => ({ current: '', branches: [] }),
    // sunx P2 Task 7:品性读写面桩(CharterDialog 弹窗链;ProjectMenuConn 新增面)
    sessionCharter: vi.fn(async () => ({ text: 'STUB CHARTER', charterRev: 1 })),
    editCharter: vi.fn(async () => ({ ok: true as const, charterRev: 2 })),
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
      onOpenDirectory={() => {}}
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
    expect((document.querySelector('.sx-group-head:disabled') as HTMLButtonElement).disabled).toBe(true); // root 缺场组禁用(路径 tooltip 已退役,disabled 即缺场标记)
    // 组行点击=展开:惰拉 sessionsOf,组内会话行在场(组行/RECENTS 行/recents 去重前同文——取首个)
    fireEvent.click(await screen.findByText('p1'));
    // sunx P2 Task 7:SUNX 过滤组挂载即按根聚合(sessionsOf 每工作区一次)——惰拉断言改「含组根」
    await waitFor(() => expect(conn.roots).toContain('D:/w/p1'));
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
    // 未读点消失晚于 active 类一帧(markRead 异步回写)——裸断言在帧隙必抖(waitFor 钉)
    await waitFor(() => expect(row.closest('.sx-session-row')!.querySelector('.sx-session-dot.unseen')).toBeNull());
  });

  it('「+ 添加工作区」:浏览器态开服务端 DirPicker → 确认登记既有目录(G14.51 只登记不建目录)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    fireEvent.click(screen.getByRole('button', { name: 'add workspace' }));
    // DirPicker 弹层在场(缺省 home 起;桩回 D:/w)——确认取当前浏览路径
    await screen.findByRole('dialog', { name: 'choose directory' });
    fireEvent.click(await screen.findByRole('button', { name: /^(?:Choose this directory|选择此目录)$/ }));
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

describe('ProjectMenu T6 侧栏行归档钮(确认 morph)+ 组头归档入口', () => {
  it('RECENTS 行 hover 归档钮:点击 morph 行内「确认」且 stopPropagation 不触发行 attach;确认→archiveSession(j1,true)+列表重拉(计数/Recents)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    await screen.findByText('demo goal');
    const opensBefore = open.mock.calls.length;
    const rootsAtMount = conn.roots.length; // sunx P2 Task 7:SUNX 过滤组挂载即按根聚合(基线截取)
    // 归档钮点击:morph 为「确认」,不触发 attach 两步(stopPropagation)
    fireEvent.click(screen.getByRole('button', { name: 'Archive j1' }));
    expect(screen.queryByRole('button', { name: 'Archive j1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Confirm archive j1' })).toBeDefined();
    fireEvent.mouseDown(document.body); // 行外点击:取消确认(用户裁定),还原归档钮
    expect(screen.getByRole('button', { name: 'Archive j1' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Confirm archive j1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Archive j1' }));
    expect(screen.getByRole('button', { name: 'Confirm archive j1' })).toBeDefined();
    expect(open.mock.calls.length).toBe(opensBefore);
    expect(conn.roots.length).toBe(rootsAtMount); // 无新 sessionsOf 拉(未展开组;attach 未发生)
    // 确认点击:落库 archived=true + 重拉(workspaces=计数/Recents;SUNX 过滤组随 rows 换引用
    // 同拍重拉=新设计,attach 触发的 sessionsOf 仍为零——归档路径断言以 archiveSession 为准)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm archive j1' }));
    await waitFor(() => expect(conn.archiveSession).toHaveBeenCalledWith('j1', true));
    await waitFor(() => expect(conn.workspaces).toHaveBeenCalledTimes(2)); // 挂载 1 次 + 落库后重拉
    expect(open.mock.calls.length).toBe(opensBefore);
  });

  it('组头目录钮(2026-10-27 常驻裁定):root 在场即渲染(零会话点击即建席),点击上抛 onOpenDirectory(root);缺 root 不渲染', async () => {
    const onOpenDirectory = vi.fn();
    renderMenu(makeConn(), { onOpenDirectory });
    await screen.findByText('p1');
    // p1:root+1 会话 → 钮在,点击上抛 root
    fireEvent.click(screen.getByRole('button', { name: 'open directory p1' }));
    expect(onOpenDirectory).toHaveBeenCalledWith('D:/w/p1');
    // 2026-10-27 常驻裁定:p3-junk 0 会话 → 钮照渲染(点击即建席开树视图)
    expect(screen.getByRole('button', { name: 'open directory p3-junk' })).toBeDefined();
    // p2:root 缺场(历史档) → 钮不渲染
    expect(screen.queryByRole('button', { name: 'open directory p2' })).toBeNull();
  });

  it('组头 ⋯→移除工作区(2026-10-23 用户裁定):弹层项调 hideWorkspace(slug) 且清单重拉', async () => {
    const conn = makeConn();
    renderMenu(conn);
    await screen.findByText('demo goal');
    // slug-only 历史行同样可移除(⋯ 不设 root 门槛)
    fireEvent.click(screen.getByRole('button', { name: 'workspace actions p2' }));
    fireEvent.click(screen.getByText('Remove workspace'));
    await waitFor(() => expect(conn.hideWorkspace).toHaveBeenCalledWith('p2'));
    await waitFor(() => expect(conn.workspaces).toHaveBeenCalledTimes(2)); // 挂载 1 + 移除后重拉
  });

  it('归档层入口:点组头归档钮→下侧整替为归档列表(覆盖项目/最近会话,组头换「归档会话」+X);点 X 退出还原', async () => {
    const conn = makeConn();
    renderMenu(conn);
    await screen.findByText('demo goal');
    expect(screen.queryByRole('button', { name: 'exit archive' })).toBeNull(); // 非归档层无 X
    fireEvent.click(screen.getByRole('button', { name: 'archived sessions' }));
    await waitFor(() => expect(conn.archivedSessions).toHaveBeenCalledTimes(2)); // 挂载预取 1(置顶组滤除已归档钉需归档集)+ 开层重拉 1
    // 整替面:归档行在场;项目组行与最近会话区消失;组头 X 在场
    const list = screen.getByRole('list', { name: 'archived sessions' });
    expect(within(list).getByText('已归档会话')).toBeDefined(); // 行标题(无题回落 id)
    expect(within(list).getAllByText('p1').length).toBeGreaterThan(0); // 来源项目 slug 标注
    expect(screen.queryByText('demo goal')).toBeNull(); // 项目组行被覆盖
    expect(screen.queryByText('暂无最近会话')).toBeNull(); // Recents 区被覆盖
    expect(screen.getByRole('button', { name: 'exit archive' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'archived sessions' })).toBeNull(); // 归档/新增图标退役
    expect(screen.queryByRole('button', { name: 'add workspace' })).toBeNull();
    // X 退出:恢复项目/最近会话显示
    fireEvent.click(screen.getByRole('button', { name: 'exit archive' }));
    await screen.findByText('demo goal');
    expect(screen.queryByRole('list', { name: 'archived sessions' })).toBeNull();
    expect(screen.getByRole('button', { name: 'archived sessions' })).toBeDefined();
  });

  it('归档层行点击:经 attachJournal 同链打开(onOpenSession 收 new-<root> + journalId 随行)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    await screen.findByText('demo goal');
    fireEvent.click(screen.getByRole('button', { name: 'archived sessions' }));
    const opensBefore = open.mock.calls.length;
    const list = await screen.findByRole('list', { name: 'archived sessions' });
    fireEvent.click(within(list).getByText('已归档会话'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('new-D:/w/p1', 'D:/w/p1', 'a1'));
    expect(open.mock.calls.length).toBe(opensBefore + 1);
  });
});

describe('ProjectMenu 新建 Sunx 入口(sunx P1 Task 6;2026-11-15 提为顶部快捷区行):创建弹窗链', () => {
  /** 双语容忍正解(D37 家族):测试环境钉 en,单语 zh 钉必脆——双语 regex(元字符转义) */
  const bi = (en: string, zh: string): RegExp =>
    new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

  it('「new sunx」钮开弹窗;提交三元组 newSession(root,…,{kind:"sunx",name}) → onOpenSession 直开新会话(不走欢迎页)且弹窗收', async () => {
    const conn = makeConn();
    conn.newSession = vi.fn(async () => ({ sessionId: 'sx-1' }));
    renderMenu(conn, { onOpenSession: open });
    await screen.findByText('demo goal');
    // 顶部快捷区行在场(可见文字自说明,无 data-tip;与「new default chat」判重)
    const btn = screen.getByRole('button', { name: 'new sunx' });
    expect(btn.textContent).toContain('New Sunx');
    fireEvent.click(btn);
    expect(await screen.findByRole('dialog', { name: 'New Sunx' })).toBeDefined();
    // 缺省锚:工作区清单(p1/p2/harness-x)无 sunshinex-default 行 → 字面 'default'
    expect(screen.getByText(/^(?:Default workspace|默认工作区)$/)).toBeDefined(); // hook 锚字面 'default' 显示名
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '编排者' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(conn.newSession).toHaveBeenCalledWith('default', undefined, undefined, undefined, { kind: 'sunx', name: '编排者' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('sx-1', 'default')); // 既有 openSession 链路
    expect(screen.queryByRole('dialog', { name: 'New Sunx' })).toBeNull(); // 关弹窗
  });
});

describe('ProjectMenu SUNX 过滤组(sunx P2 Task 7):kind 聚合+按工作区分节+看板钮+编辑品性弹窗链', () => {
  /** sunx 会话桩 conn:两工作区各一 sunx 会话+一 standard 会话(RECENTS 空,聚焦过滤组) */
  function makeSunxConn(): ProjectMenuConn & { roots: string[] } {
    const conn = makeConn();
    conn.workspaces = vi.fn(async () => [
      { slug: 'p1', root: 'D:/w/p1', sessionCount: 2, mtime: Date.now() },
      { slug: 'p2', root: 'D:/w/p2', sessionCount: 1, mtime: Date.now() },
    ] as never);
    conn.sessionsOf = async (root: string) =>
      (root === 'D:/w/p1'
        ? [
            { id: 'sx-j1', firstUser: '编排一', updatedAt: 5, kind: 'sunx' },
            { id: 'std-j2', firstUser: '普通会话', updatedAt: 4 },
          ]
        : [{ id: 'sx-j3', firstUser: '编排三', updatedAt: 3, kind: 'sunx' }]) as never;
    conn.recentSessions = vi.fn(async () => [] as never);
    return conn as ProjectMenuConn & { roots: string[] };
  }

  it('组聚合:两工作区各一 sunx 小节;standard 行不入组;空组整块不显', async () => {
    const first = renderMenu(makeSunxConn());
    expect(await screen.findByText('SUNX')).toBeDefined(); // 组头(双语同文)
    const list = first.container.querySelector('.sx-sunx-list')!;
    expect(list.textContent).toContain('编排一');
    expect(list.textContent).toContain('编排三');
    expect(list.textContent).not.toContain('普通会话'); // kind 过滤
    // SUNX 分组常驻(2026-11-15 用户裁定):全 standard 会话 → 组头恒显+空态引导行,列表空
    first.unmount();
    const conn2 = makeConn(); // sessionsOf 全 standard
    const second = renderMenu(conn2);
    await second.findByText('demo goal');
    expect(second.container.querySelector('.sx-sunx-empty')).not.toBeNull(); // 空态引导行
    expect(second.container.querySelector('.sx-sunx-list')).toBeNull(); // 列表空
  });

  it('条目点击=既有 attach 链(attachJournal 两步→onOpenSession)', async () => {
    const conn = makeSunxConn();
    renderMenu(conn, { onOpenSession: open });
    fireEvent.click(await screen.findByText('编排一'));
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.any(String), 'D:/w/p1', 'sx-j1')); // journalId 随行
  });

  it('组头看板钮:接线 onOpenSunxBoard 渲染+点击上抛;未接线不渲染(guard)', async () => {
    const onOpenSunxBoard = vi.fn();
    const first = renderMenu(makeSunxConn(), { onOpenSunxBoard });
    const btn = (await first.findAllByRole('button', { name: 'sunx board' }))[0]; // 常驻后 RECENTS 头+组头双钮同名
    expect(btn.getAttribute('data-tip')).toBe('Sunx board'); // 测试环境钉 en(本文件不钉 zh)
    expect(btn.querySelector('title')).toBeNull(); // data-tip 禁原生 title(铁律)
    fireEvent.click(btn);
    expect(onOpenSunxBoard).toHaveBeenCalledTimes(1);
    first.unmount();
    const second = renderMenu(makeSunxConn());
    await second.findByText('SUNX');
    expect(second.queryByRole('button', { name: 'sunx board' })).toBeNull();
  });

  it('行菜单「编辑品性」→CharterDialog:寻址行 liveSessionId 优先,预填走 conn.sessionCharter,保存走 conn.editCharter', async () => {
    // 行带 liveSessionId(在座标注)=live 寻址;缺席行回落 journal id(sessionsOf 桩定制两形态)
    const conn = makeSunxConn();
    conn.sessionsOf = async (root: string) =>
      (root === 'D:/w/p1'
        ? [
            { id: 'sx-j1', firstUser: '编排一', updatedAt: 5, kind: 'sunx', liveSessionId: 's-live-1' },
            { id: 'std-j2', firstUser: '普通会话', updatedAt: 4 },
          ]
        : [{ id: 'sx-j3', firstUser: '编排三', updatedAt: 3, kind: 'sunx' }]) as never;
    renderMenu(conn);
    await screen.findByText('SUNX');
    fireEvent.click(screen.getByRole('button', { name: 'session actions sx-j1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /编辑品性|Edit charter/ }));
    expect(await screen.findByRole('dialog', { name: /编辑品性|Edit charter/ })).toBeDefined();
    await waitFor(() => expect(conn.sessionCharter).toHaveBeenCalledWith('s-live-1')); // live id 优先
    fireEvent.change(await screen.findByLabelText(/品性|Charter/), { target: { value: '从侧栏改的品性' } });
    fireEvent.click(screen.getByRole('button', { name: /保存|Save/ }));
    await waitFor(() => expect(conn.editCharter).toHaveBeenCalledWith('s-live-1', '从侧栏改的品性'));
    // 关闭后可对无 liveSessionId 的行按 journal id 寻址(成功提示停留 1.4s 后自动关——放宽窗)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /编辑品性|Edit charter/ })).toBeNull(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'session actions sx-j3' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /编辑品性|Edit charter/ }));
    await waitFor(() => expect(conn.sessionCharter).toHaveBeenCalledWith('sx-j3')); // 无 live 行=journal id
  });
});
