import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewSunxDialog } from './NewSunxDialog';
import type { NewSunxConn } from './NewSunxDialog';
import { RecentsSection } from '../sidebar/project-menu-recents';
import type { SessionRow } from '../connection';

/**
 * 新建 Sunx 创建弹窗(sunx P1 Task 6):姓名(必填,空禁提交)/工作目录(既有 DirPicker 面,缺省=
 * 当前默认工作区锚)/品性(Charter,文本域可空=仅总章程)。提交 conn.newSession(target,undefined,
 * undefined,undefined,{kind:'sunx',name,charter?}) → 成功走既有 openSession 链路打开并关弹窗。
 * 附 RECENTS 头「新建 Sunx」同级钮与侧栏 kind 徽标两件(入口/徽标皆本任务交付,测试同档归置)。
 */

/** 双语容忍正解(D37 家族,dirpicker.test 同款):产品面 t() 化后,测试环境钉 en,单语钉必脆 */
const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

/** conn 桩:newSession 可 spy(载荷断言);dirpicker 可选逐次应答(DirPicker 面消费) */
type NewSessionFn = NewSunxConn['newSession'];
type NewSessionMock = ReturnType<typeof vi.fn<NewSessionFn>>;
function makeConn(newSessionImpl?: NewSessionFn): NewSunxConn & { newSession: NewSessionMock } {
  const fallback: NewSessionMock = vi.fn(
    async (..._: Parameters<NewSessionFn>): Promise<{ sessionId: string }> => ({ sessionId: 'sx-new-1' }),
  );
  return {
    newSession: newSessionImpl !== undefined ? vi.fn(newSessionImpl) : fallback,
    dirpicker: vi.fn(async (path?: string) => ({ path: path ?? '/home', parent: '/home', dirs: ['proj'] })),
  };
}

/** 受控开合宿主:open 态内持,onClose 翻 false(母体裁定 open prop + onClose) */
function Harness(props: {
  conn: NewSunxConn;
  defaultRoot?: string;
  onOpenSession?: (sessionId: string, root: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <NewSunxDialog
      open={open}
      onClose={() => setOpen(false)}
      conn={props.conn}
      defaultRoot={props.defaultRoot ?? 'D:/tmp/sunshinex-default'}
      onOpenSession={props.onOpenSession ?? ((): void => undefined)}
    />
  );
}

describe('NewSunxDialog(新建 Sunx 弹窗:姓名/工作目录/品性三元组)', () => {
  it('受控开合:open=false 零渲染;open=true 弹窗在场且目录锚定缺省工作区', () => {
    const conn = makeConn();
    const closed = render(
      <NewSunxDialog open={false} onClose={() => {}} conn={conn} defaultRoot="D:/tmp/sunshinex-default" onOpenSession={() => {}} />,
    );
    expect(screen.queryByRole('dialog', { name: 'New Sunx' })).toBeNull();
    closed.unmount();
    render(<Harness conn={conn} />);
    expect(screen.getByRole('dialog', { name: 'New Sunx' })).toBeDefined();
    expect(screen.getByText('D:/tmp/sunshinex-default')).toBeDefined(); // 缺省=当前默认工作区锚
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

  it('工作目录:浏览面复用既有 DirPicker,选完回填并随提交', async () => {
    const conn = makeConn();
    render(<Harness conn={conn} defaultRoot="default" />);
    fireEvent.click(screen.getByRole('button', { name: bi('Browse…', '浏览…') }));
    expect(await screen.findByRole('dialog', { name: 'choose directory' })).toBeDefined(); // 既有 DirPicker 面
    fireEvent.click(screen.getByRole('button', { name: 'proj' })); // 逐级浏览
    fireEvent.click(await screen.findByRole('button', { name: bi('Choose this directory', '选择此目录') }));
    expect(screen.getByRole('dialog', { name: 'New Sunx' })).toBeDefined(); // 回表单
    expect(screen.getByText('/home/proj')).toBeDefined(); // 回填所选目录
    fireEvent.change(screen.getByLabelText(bi('Name', '姓名')), { target: { value: '丙' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Create', '创建') }));
    await waitFor(() => expect(conn.newSession).toHaveBeenCalledWith('/home/proj', undefined, undefined, undefined, { kind: 'sunx', name: '丙' }));
  });
});

/** RecentsSection props 最小装配(本任务两交付面共用) */
function recentsProps(
  recents: Array<SessionRow & { root: string; slug: string }>,
  onNewSunx: () => void,
): Parameters<typeof RecentsSection>[0] {
  return {
    recentsOpen: true,
    onToggleRecents: () => undefined,
    onNewChat: () => undefined,
    onNewSunx,
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

describe('RECENTS 头「新建 Sunx」同级钮 + 会话行 kind 徽标(sunx P1 Task 6)', () => {
  it('头部同级钮:点击上抛 onNewSunx(与「新对话」同款样式槽,悬浮提示 data-tip)', () => {
    const onNewSunx = vi.fn();
    render(<RecentsSection {...recentsProps([], onNewSunx)} />);
    const btn = screen.getByRole('button', { name: 'new sunx' });
    expect(btn.getAttribute('data-tip')).toBe('New Sunx'); // data-tip 禁原生 title(铁律)
    expect(btn.querySelector('title')).toBeNull();
    fireEvent.click(btn);
    expect(onNewSunx).toHaveBeenCalledTimes(1);
  });

  it('kind=sunx 行标题旁小徽标;standard 行(无 kind)无徽标', () => {
    const row = (id: string, kind?: string) =>
      ({ id, file: `${id}.jsonl`, updatedAt: 1, title: `会话 ${id}`, root: 'D:/w', slug: 'w', ...(kind !== undefined ? { kind } : {}) }) as SessionRow & { root: string; slug: string };
    const { container } = render(
      <RecentsSection {...recentsProps([row('j1', 'sunx'), row('j2')], () => undefined)} />,
    );
    const rows = container.querySelectorAll('.sx-session-row');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.sx-sunx-badge')).not.toBeNull(); // sunx 徽标在场
    expect(rows[1].querySelector('.sx-sunx-badge')).toBeNull(); // standard 无徽标
    expect(screen.getByText('会话 j1')).toBeDefined();
  });
});
