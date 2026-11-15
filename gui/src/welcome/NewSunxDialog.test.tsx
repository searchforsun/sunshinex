import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewSunxDialog } from './NewSunxDialog';
import type { NewSunxConn } from './NewSunxDialog';
import { RecentsSection } from '../sidebar/project-menu-recents';
import type { SessionRow } from '../connection';

/**
 * 新建 Sunx 创建弹窗(sunx P1 Task 6;2026-11-15 工作目录改版=欢迎页 useWelcomeWorkspaces 单点
 * 复用+WelcomeProjectPop 弹层):姓名(必填,空禁提交)/工作目录(下拉选已有工作区,浏览文件夹…
 * 可添加新目录——壳 IPC pickFolder→createWorkspace 登记,默认锚置顶)/品性(Charter,文本域可空=
 * 仅总章程)。提交 conn.newSession(target,undefined,undefined,undefined,{kind:'sunx',name,charter?})
 * → 成功走既有 openSession 链路打开并关弹窗。附 RECENTS 头钮退役负断言与侧栏 kind 徽标两件
 * (入口唯一化/徽标为已交付面,测试同档归置)。
 */

/** 双语容忍正解(D37 家族,dirpicker.test 同款):产品面 t() 化后,测试环境钉 en,单语钉必脆 */
const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

/** conn 桩:newSession 可 spy(载荷断言);workspaces 默认返回 sunshinex-default 锚行
 *  (hook 锚定后 picked=root,与既有载荷断言同值);createWorkspace 可 spy(添加新目录断言);
 *  sunxTemplates 缺省空清单(选择器隐藏态),可注入模板行(模板挑选面消费) */
type NewSessionFn = NewSunxConn['newSession'];
type NewSessionMock = ReturnType<typeof vi.fn<NewSessionFn>>;
type SunxTemplatesFn = NewSunxConn['sunxTemplates'];
function makeConn(
  newSessionImpl?: NewSessionFn,
  sunxTemplatesImpl?: SunxTemplatesFn,
): NewSunxConn & {
  newSession: NewSessionMock;
  sunxTemplates: ReturnType<typeof vi.fn<SunxTemplatesFn>>;
  workspaces: ReturnType<typeof vi.fn<() => Promise<Array<{ slug: string; root?: string; sessionCount: number }>>>>;
  createWorkspace: ReturnType<typeof vi.fn<NewSunxConn['createWorkspace']>>;
} {
  const fallback: NewSessionMock = vi.fn(
    async (..._: Parameters<NewSessionFn>): Promise<{ sessionId: string }> => ({ sessionId: 'sx-new-1' }),
  );
  const fallbackTemplates: ReturnType<typeof vi.fn<SunxTemplatesFn>> = vi.fn(
    async (..._: Parameters<SunxTemplatesFn>): Promise<{ entries: []; warnings: string[] }> => ({ entries: [], warnings: [] }),
  );
  return {
    newSession: newSessionImpl !== undefined ? vi.fn(newSessionImpl) : fallback,
    dirpicker: vi.fn(async (path?: string) => ({ path: path ?? '/home', parent: '/home', dirs: ['proj'] })),
    sunxTemplates: sunxTemplatesImpl !== undefined ? vi.fn(sunxTemplatesImpl) : fallbackTemplates,
    workspaces: vi.fn(async () => [{ slug: 'ws-sunshinex-default', root: 'D:/tmp/sunshinex-default', sessionCount: 1 }]),
    createWorkspace: vi.fn(async (body: { path?: string }) => ({ ok: true as const, root: body.path ?? '', slug: body.path ?? '' })),
    locateWorkspace: vi.fn(async () => ({ path: null })),
    sessionCharter: vi.fn(async () => ({ text: null, charterRev: 1 })),
    editCharter: vi.fn(async () => ({ ok: true as const, charterRev: 2 })),
    renameSession: vi.fn(async () => ({ ok: true as const, title: 'x' })),
  };
}

/** 受控开合宿主:open 态内持,onClose 翻 false(母体裁定 open prop + onClose) */
function Harness(props: { conn: NewSunxConn; onOpenSession?: (sessionId: string, root: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <NewSunxDialog
      open={open}
      onClose={() => setOpen(false)}
      conn={props.conn}
      onOpenSession={props.onOpenSession ?? ((): void => undefined)}
    />
  );
}

afterEach(() => {
  // 壳 IPC 桩清理(添加新目录用例注入;漏清会漏到别的用例的浏览通道)
  delete (window as unknown as { sunshinex?: unknown }).sunshinex;
});

describe('NewSunxDialog(新建 Sunx 弹窗:姓名/工作目录/品性三元组)', () => {
  it('受控开合:open=false 零渲染;open=true 弹窗在场且工作目录条=默认工作区(锚回源)', async () => {
    const conn = makeConn();
    const closed = render(
      <NewSunxDialog open={false} onClose={() => {}} conn={conn} onOpenSession={() => {}} />,
    );
    expect(screen.queryByRole('dialog', { name: 'New Sunx' })).toBeNull();
    closed.unmount();
    render(<Harness conn={conn} />);
    expect(screen.getByRole('dialog', { name: 'New Sunx' })).toBeDefined();
    expect(await screen.findByText(bi('Default workspace', '默认工作区'))).toBeDefined(); // 锚回源后显示名
  });

  it('校验:姓名空禁提交(钮 disabled);填名即解禁;品性留空照常可提交(仅总章程)', () => {
    const conn = makeConn();
    render(<Harness conn={conn} />);
    const create = screen.getByRole('button', { name: bi('Create', '创建') }) as HTMLButtonElement;
    expect(create.disabled).toBe(true); // 空名禁提交
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '编排者甲' } });
    expect(create.disabled).toBe(false); // charter 可空
  });

  it('提交载荷:{kind:"sunx", name(trim 后), charter?}——空品性不落 charter 键;填了原样透传', async () => {
    // 空品性:仅 kind+name(charter 键不落);成功即关弹窗,载荷断言用独立挂载
    const conn = makeConn();
    const first = render(<Harness conn={conn} />);
    await screen.findByText(bi('Default workspace', '默认工作区')); // 锚异步落地后再出牌( picked 回源时序 )
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '  编排者甲  ' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(conn.newSession).toHaveBeenCalledTimes(1));
    expect(conn.newSession).toHaveBeenCalledWith('D:/tmp/sunshinex-default', undefined, undefined, undefined, {
      kind: 'sunx',
      name: '编排者甲',
    });
    const opts = conn.newSession.mock.calls[0][4] as { kind?: string; name?: string; charter?: string };
    expect(opts.kind).toBe('sunx');
    expect('charter' in opts).toBe(false); // 留空=仅总章程(无 charter 字段)
    first.unmount();
    // 带品性:原样透传(逐字进冻结层)
    const conn2 = makeConn();
    render(<Harness conn={conn2} />);
    await screen.findByText(bi('Default workspace', '默认工作区'));
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '乙' } });
    fireEvent.change(screen.getByLabelText(bi('Charter', '品性')), { target: { value: 'Be terse. Ship small.' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(conn2.newSession).toHaveBeenCalledTimes(1));
    expect(conn2.newSession).toHaveBeenCalledWith('D:/tmp/sunshinex-default', undefined, undefined, undefined, {
      kind: 'sunx',
      name: '乙',
      charter: 'Be terse. Ship small.',
    });
  });

  it('成功后走既有 openSession 链路打开该会话并关弹窗', async () => {
    const conn = makeConn();
    const onOpenSession = vi.fn();
    render(<Harness conn={conn} onOpenSession={onOpenSession} />);
    await screen.findByText(bi('Default workspace', '默认工作区'));
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '甲' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('sx-new-1', 'D:/tmp/sunshinex-default'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Sunx' })).toBeNull()); // 关弹窗
  });

  it('ESC 关;点外(遮罩)关', () => {
    const conn = makeConn();
    const { unmount } = render(<Harness conn={conn} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New Sunx' })).toBeNull();
    unmount();
    render(<Harness conn={conn} />);
    fireEvent.click(document.querySelector('.modal-overlay')!); // 遮罩本体=点外
    expect(screen.queryByRole('dialog', { name: 'New Sunx' })).toBeNull();
  });

  it('提交中禁重复提交(busy 锁:钮 disabled+在途再点不双发)', async () => {
    let release: ((v: { sessionId: string }) => void) | null = null;
    const conn = makeConn(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          release = resolve;
        }),
    );
    render(<Harness conn={conn} />);
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '甲' } });
    const create = screen.getByRole('button', { name: bi('Create', '创建') }) as HTMLButtonElement;
    fireEvent.click(create);
    await waitFor(() => expect(create.disabled).toBe(true)); // 提交中禁用
    fireEvent.click(create); // 在途再点
    expect(conn.newSession).toHaveBeenCalledTimes(1); // 不双发
    release!({ sessionId: 'sx-1' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Sunx' })).toBeNull());
  });

  it('busy 中三条关闭路径全部拒关(fix round 1:创建中不可取消——ESC/点外/✕ 均不动;resolve 后照常走 openSession+关)', async () => {
    let release: ((v: { sessionId: string }) => void) | null = null;
    const conn = makeConn(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          release = resolve;
        }),
    );
    render(<Harness conn={conn} />);
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '甲' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: bi('Creating…', '创建中…') }) as HTMLButtonElement).disabled).toBe(true),
    );
    // busy 中 ESC / 点外(遮罩) / ✕(disabled):一律拒关——弹窗停留
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('.modal-overlay')!);
    expect((screen.getByRole('button', { name: 'close sunx dialog' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'close sunx dialog' }));
    expect(screen.getByRole('dialog', { name: 'New Sunx' })).toBeDefined();
    // resolve 后照常:关弹窗(成功链照旧,非 busy 关闭路径回归由上方 ESC/点外独立用例钉)
    release!({ sessionId: 'sx-9' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Sunx' })).toBeNull());
  });

  it('失败:错误示出(role=alert),弹窗停留可改再提交', async () => {
    const conn = makeConn(() => Promise.reject(new Error('/session/new -> 400')));
    render(<Harness conn={conn} />);
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '甲' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'New Sunx' })).toBeDefined(); // 停留
    expect((screen.getByRole('button', { name: bi('Create', '创建') }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('NewSunxDialog 工作目录(sunx P2 2026-11-15 改版:欢迎页下拉选已有/添加新目录)', () => {
  it('下拉选已有工作区:弹层列默认锚+其余行,选中非默认行 → 载荷 root 跟随', async () => {
    const conn = makeConn();
    conn.workspaces = vi.fn(async () => [
      { slug: 'ws-sunshinex-default', root: 'D:/tmp/sunshinex-default', sessionCount: 1 },
      { slug: 'p2', root: 'D:/w/shared-p', sessionCount: 3 },
    ]);
    render(<Harness conn={conn} />);
    expect(await screen.findByText(bi('Default workspace', '默认工作区'))).toBeDefined(); // 锚置顶显示名
    fireEvent.click(screen.getByRole('button', { name: bi('Choose working directory', '选择工作目录') }));
    const menu = await screen.findByRole('menu', { name: bi('Projects', '项目') });
    expect(menu).toBeDefined();
    fireEvent.click(screen.getByRole('menuitem', { name: 'shared-p' })); // 选非默认行
    expect(screen.queryByRole('menu')).toBeNull(); // 选中即收
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '丙' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() =>
      expect(conn.newSession).toHaveBeenCalledWith('D:/w/shared-p', undefined, undefined, undefined, { kind: 'sunx', name: '丙' }),
    );
  });

  it('添加新工作目录:壳 IPC pickFolder → createWorkspace 登记+选中 → 载荷 root=新目录', async () => {
    const conn = makeConn();
    // 动态桩模拟 daemon 登记:createWorkspace 落库后 /workspaces 即含新行(hook 回源才不会把
    // picked 洗回默认锚——真实 daemon createWorkspace 注册 workspace.json 同语义)
    const registered: Array<{ slug: string; root: string; sessionCount: number }> = [
      { slug: 'ws-sunshinex-default', root: 'D:/tmp/sunshinex-default', sessionCount: 1 },
    ];
    conn.workspaces = vi.fn(async () => [...registered]);
    conn.createWorkspace = vi.fn(async (body: { path?: string }) => {
      registered.push({ slug: body.path ?? '', root: body.path ?? '', sessionCount: 0 });
      return { ok: true as const, root: body.path ?? '', slug: body.path ?? '' };
    });
    (window as unknown as { sunshinex: unknown }).sunshinex = {
      pickFolder: vi.fn(async () => 'D:/new-dir'),
    };
    render(<Harness conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: bi('Choose working directory', '选择工作目录') }));
    fireEvent.click(await screen.findByRole('menuitem', { name: bi('Browse folders…', '浏览文件夹…') }));
    await waitFor(() => expect(conn.createWorkspace).toHaveBeenCalledWith({ path: 'D:/new-dir' }));
    expect(await screen.findByText('new-dir')).toBeDefined(); // 登记即选中(显示名=目录 basename)
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '丁' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() =>
      expect(conn.newSession).toHaveBeenCalledWith('D:/new-dir', undefined, undefined, undefined, { kind: 'sunx', name: '丁' }),
    );
  });
});

describe('NewSunxDialog 模板挑选(sunx P2 Task 6:GET /settings/sunx-templates 惰拉→选择回填 name/charter 可改)', () => {
  it('惰拉时机:打开/锚回源后取一次,root=锚定工作区;无模板数据=选择器不显(表单照常可用)', async () => {
    const conn = makeConn();
    render(<Harness conn={conn} />);
    await waitFor(() => expect(conn.sunxTemplates).toHaveBeenCalled());
    await waitFor(() => expect(conn.sunxTemplates).toHaveBeenLastCalledWith('D:/tmp/sunshinex-default')); // 锚=默认工作区
    await new Promise((r) => setTimeout(r, 0)); // 空清单应答沉降
    expect(screen.queryByLabelText(bi('Template', '模板'))).toBeNull(); // 无模板=选择器隐藏
    // 表单不被选择器阻塞:填名照常可提交
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '甲' } });
    expect((screen.getByRole('button', { name: bi('Create', '创建') }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('惰拉失败静默=无模板态:error 不示出(零 alert)、弹窗停留、创建主流程不受扰', async () => {
    const conn = makeConn(undefined, () => Promise.reject(new Error('/settings/sunx-templates -> 500')));
    render(<Harness conn={conn} />);
    await waitFor(() => expect(conn.sunxTemplates).toHaveBeenCalled());
    // 微任务沉降后仍零错误示出
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByLabelText(bi('Template', '模板'))).toBeNull(); // 失败=无模板态(选择器隐藏)
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '乙' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(conn.newSession).toHaveBeenCalledTimes(1)); // 主流程照常
  });

  it('选中回填:模板 name→姓名、charter 全文→品性;改后以改后为准(回填可编辑)', async () => {
    const conn = makeConn(undefined, async () => ({
      entries: [
        { id: 'steward', name: '仓库管家', description: 'repo caretaker', charter: 'Be terse.\nShip small.', source: 'global', shadowed: false },
      ],
      warnings: [],
    }));
    render(<Harness conn={conn} />);
    const select = (await screen.findByLabelText(bi('Template', '模板'))) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'steward' } });
    expect((screen.getByLabelText(bi('Name', '姓名')) as HTMLInputElement).value).toBe('仓库管家');
    expect((screen.getByLabelText(bi('Charter', '品性')) as HTMLTextAreaElement).value).toBe('Be terse.\nShip small.');
    // 用户改后以改后为准:回填只是播种,非锁定
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '改编者' } });
    fireEvent.change(screen.getByLabelText(bi('Charter', '品性')), { target: { value: '改后章程' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(conn.newSession).toHaveBeenCalledTimes(1));
    expect(conn.newSession).toHaveBeenCalledWith('D:/tmp/sunshinex-default', undefined, undefined, undefined, {
      kind: 'sunx',
      name: '改编者',
      charter: '改后章程',
    });
  });

  it('被遮蔽行不进选项(生效视图口径):同 id 两行只出项目生效行一个 option', async () => {
    const conn = makeConn(undefined, async () => ({
      entries: [
        { id: 'shared', name: 'Shared G', charter: 'global charter', source: 'global', shadowed: true },
        { id: 'shared', name: 'Shared P', charter: 'project charter', source: 'project', shadowed: false },
      ],
      warnings: [],
    }));
    render(<Harness conn={conn} />);
    const select = (await screen.findByLabelText(bi('Template', '模板'))) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2)); // 占位 option + 生效行一个
    expect(select.options[1]?.textContent).toBe('Shared P');
    fireEvent.change(select, { target: { value: 'shared' } });
    expect((screen.getByLabelText(bi('Charter', '品性')) as HTMLTextAreaElement).value).toBe('project charter'); // 生效版章程
  });
});

/** RecentsSection props 最小装配(本任务两交付面共用) */
function recentsProps(
  recents: Array<SessionRow & { root: string; slug: string }>,
): Parameters<typeof RecentsSection>[0] {
  return {
    recentsOpen: true,
    onToggleRecents: () => undefined,
    onNewChat: () => undefined,
    recents,
    recentLimit: 10,
    onShowMore: () => undefined,
    onCollapse: () => undefined,
    activeSessionId: '',
    runningIds: new Set<string>(),
    journalOfSession: new Map<string, string>(),
    isUnseen: () => false,
    busy: false,
    onAttach: () => undefined,
    onArchiveRow: () => undefined,
    pinnedIds: new Set<string>(),
    onPinRow: () => undefined,
  };
}

describe('RECENTS 头「新建 Sunx」钮退役 + 会话行 kind 徽标(sunx P1 Task 6;2026-11-15 入口提为顶部快捷区行)', () => {
  it('RECENTS 头不再渲染「new sunx」钮(入口唯一化到顶部快捷区,防同名可达名重复)', () => {
    render(<RecentsSection {...recentsProps([])} />);
    expect(screen.queryByRole('button', { name: 'new sunx' })).toBeNull();
  });

  it('kind=sunx 行标题旁小徽标;standard 行(无 kind)无徽标', () => {
    const row = (id: string, kind?: string) =>
      ({ id, file: `${id}.jsonl`, updatedAt: 1, title: `会话 ${id}`, root: 'D:/w', slug: 'w', ...(kind !== undefined ? { kind } : {}) }) as SessionRow & { root: string; slug: string };
    const { container } = render(
      <RecentsSection {...recentsProps([row('j1', 'sunx'), row('j2')])} />,
    );
    const rows = container.querySelectorAll('.sx-session-row');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.sx-sunx-badge')).not.toBeNull(); // sunx 徽标在场
    expect(rows[1].querySelector('.sx-sunx-badge')).toBeNull(); // standard 无徽标
    expect(screen.getByText('会话 j1')).toBeDefined();
  });
});
