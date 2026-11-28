// 群聊页（2026-11-26 群组规格 §7）：群主/Sunx 均复用会话用户气泡、引用行、
// composer 发送走 sunxGroupSend；送达/未送达组件不再展示。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setLanguage } from '../../i18n';
import type { Connection } from '../../connection';
import type { SunxRoomMessage } from '../../connection-types';
import { GroupChatPage } from './GroupChatPage';

setLanguage('zh');

const HUMAN: SunxRoomMessage = {
  id: 'm1', seq: 1, ts: 1_728_000_000_000, kind: 'human',
  from: { id: 'grp_x', name: '群主', kind: 'group' },
  text: '@A 你好', mentions: [{ id: 'jid_a', name: 'A' }],
  targets: [{ id: 'jid_a', name: 'A' }],
  deliveries: [{ to: 'jid_a', name: 'A', ok: true }],
};
const PEER: SunxRoomMessage = {
  id: 'm2', seq: 2, ts: 1_728_000_000_100, kind: 'peer',
  from: { id: 'jid_a', name: 'A', runSeq: 2, kind: 'sunx' },
  to: { id: 'grp_x', name: '群主', kind: 'group' },
  text: '回复正文', replyTo: 'm1',
  replyPreview: { from: { id: 'grp_x', name: '群主', kind: 'group' }, text: '@A 你好' },
};

function makeConn(): Connection {
  const messages = [HUMAN, PEER];
  return {
    // 「/」面板（主对话同件）：命令清单+supported 面（群控制命令经 merged 并入仍需在清单内才显示）
    commands: vi.fn(async () => ({
      commands: ['/status', '/compact', '/context', '/memory', '/delete', '/plan', '/stop', '/clear', '/continue'],
      descriptions: {},
      supported: ['/status', '/compact', '/context', '/memory', '/delete', '/plan', '/stop', '/clear', '/continue'],
    })),
    models: vi.fn(async () => ({ choices: [{ id: 'm1', model: 'm1' }] })),
    sunxGroupDetail: vi.fn(async () => ({
      group: { id: 'grp_x', name: '研发群' },
      members: [{
        id: 'jid_a', name: 'A', live: true, running: false, updatedAt: 2, root: 'D:/w',
        asks: [{ pid: 'p1', req: { question: '要发布吗?', options: [{ label: '是' }, { label: '否' }] } }],
      }],
      owner: { id: 'grp_x', name: '群主', kind: 'group' as const },
    })),
    replyAsk: vi.fn(async () => undefined),
    sunxGroupMessages: vi.fn(async () => ({ group: { id: 'grp_x', name: '研发群' }, messages, cursor: 2, hasMore: false })),
    sunxGroupSend: vi.fn(async () => ({ ok: true as const, messageId: 'm3', seq: 3, targets: [] })),
    sunxGroupSearch: vi.fn(async () => ({ results: [] })),
    renameSunxGroup: vi.fn(async () => ({ ok: true as const, group: { id: 'grp_x', name: '研发群' } })),
    createSunxGroup: vi.fn(async () => ({ ok: true as const, group: { id: 'grp_y', name: '新群' } })),
    setSessionGroup: vi.fn(async () => ({ ok: true as const, groupId: 'grp_x' })),
    // Sunx 面板（群隔离）：本群未归档行上卡，外群/归档行滤除
    sunxSessions: vi.fn(async () => [
      { id: 'jid_a', file: 'jid_a.jsonl', title: '本群甲', kind: 'sunx', root: 'D:/w', groupId: 'grp_x', updatedAt: 2 },
      { id: 'jid_z', file: 'jid_z.jsonl', title: '外群乙', kind: 'sunx', root: 'D:/z', groupId: 'grp_y', updatedAt: 1 },
      { id: 'jid_arch', file: 'jid_arch.jsonl', title: '归档丙', kind: 'sunx', root: 'D:/w', groupId: 'grp_x', archived: true, updatedAt: 1 },
    ]),
  } as unknown as Connection;
}

describe('GroupChatPage', () => {
  it('渲染群名/右侧群主气泡/左侧成员气泡（发送行+首行引用）；送达组件不展示', async () => {
    const conn = makeConn();
    const onOpenMember = vi.fn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={onOpenMember} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    expect(await screen.findByText('研发群')).toBeDefined();
    expect(screen.getAllByText(/你好/).some((el) => (el.textContent ?? '').includes('A 你好'))).toBe(true); // @A 走项目 hn chip + 名称，文字被拆节点
    // 左侧气泡：上方发送行 A 发送给 群主；首行引用 A 你好；正文 md
    expect(screen.getByText('发送给')).toBeDefined();
    expect(screen.getAllByText('A').length).toBeGreaterThan(0);
    expect(screen.getByText('回复正文')).toBeDefined();
    // 不再展示「是否接收」组件；来源行仍可点名跳转
    expect(screen.queryByRole('button', { name: 'delivery receipt' })).toBeNull();
    const source = document.querySelector('[data-entry-key="m2"] .user-from-sunx button') as HTMLElement;
    fireEvent.click(source);
    expect(onOpenMember).toHaveBeenCalledWith('jid_a', 2); // runSeq 随归因行定位该轮（七轮半）
  });

  it('composer 发送：@ 面板选成员（@ 按钮已退役）→ sunxGroupSend（无文件/上下文/终端入口）', async () => {
    const conn = makeConn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    expect(screen.queryByRole('button', { name: 'mention member' })).toBeNull(); // @ 按钮退役（2026-11-27 二轮裁定）
    const input = screen.getByPlaceholderText('使用 @ 选择成员，@全体成员 进行分派') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@' } }); // 输入 @ 触发成员面板
    fireEvent.click((await screen.findAllByRole('menuitem', { name: /A/ }))[0]);
    expect(input.value).toBe('@A '); // 选中即插 token
    fireEvent.change(input, { target: { value: '@A 给 A 的消息' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(conn.sunxGroupSend).toHaveBeenCalled());
    const [gid, body] = (conn.sunxGroupSend as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { text: string; mentions?: string[] }];
    expect(gid).toBe('grp_x');
    expect(body.text).toContain('给 A 的消息');
    expect(body.mentions).toEqual(['jid_a']);
    expect(screen.getByRole('button', { name: 'add attachment' })).toBeDefined(); // + 保留（图片/命令等；文件区不渲染）
    expect(screen.queryByRole('button', { name: 'toggle terminal dock' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'toggle side panel' })).toBeNull();
    // @ 用法说明随占位常驻（2026-11-28 四轮裁定）,卡内提示行退役
    expect(screen.queryByText(/输入 @ 选择成员/)).toBeNull();
  });

  it('输入框 @ 成员渲染成 chip（图标+名字，主对话高亮层同手法）；纯文本不挂层', async () => {
    const conn = makeConn();
    const { container } = render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    const input = screen.getByPlaceholderText('使用 @ 选择成员，@全体成员 进行分派') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '没有令牌的普通文本' } });
    expect(container.querySelector('.sx-composer-highlight')).toBeNull(); // 无令牌=原生显字
    fireEvent.change(input, { target: { value: '@A 你好' } });
    const chip = container.querySelector('.sx-composer-highlight .hn-file');
    expect(chip).not.toBeNull();
    expect(chip?.querySelector('.hn-file-ico')).not.toBeNull(); // 图标落 @ 位
    expect(chip?.textContent).toBe('@A'); // 显形=原文宽度（@ 透明保字宽）
    fireEvent.change(input, { target: { value: '@不存在的人' } });
    expect(container.querySelector('.sx-composer-highlight')).toBeNull(); // 非成员名不 chip
  });

  it('「/」面板=主对话命令面板同件：命令/技能分组+双语说明，群控制命令并入、/plan 排除', async () => {
    const conn = makeConn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    const input = screen.getByPlaceholderText('使用 @ 选择成员，@全体成员 进行分派') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/s' } });
    expect(await screen.findByRole('listbox', { name: '命令面板' })).toBeDefined();
    const stop = await screen.findByRole('option', { name: /\/stop/ });
    expect(stop.textContent).toContain('暂停对应 Sunx 执行'); // 命令带双语说明（主对话同表）
    expect(await screen.findByRole('option', { name: /\/status/ })).toBeDefined();
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.queryByRole('option', { name: /\/plan/ })).toBeNull(); // /plan 排除
    expect(await screen.findByRole('option', { name: /\/clear/ })).toBeDefined();
    // 点选落令牌
    fireEvent.click(screen.getByRole('option', { name: /\/clear/ }));
    expect(input.value).toBe('/clear ');
  });

  it('消息面完全复用会话件：主人右用户气泡 / Sunx 左用户气泡（来源行+发送给）/ @ chip / 时间复制 / chat-dock', async () => {
    const conn = makeConn();
    const { container } = render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    const owner = container.querySelector('[data-entry-key="m1"]')!;
    const peer = container.querySelector('[data-entry-key="m2"]')!;
    // 主人=会话用户气泡原样（右）；Sunx=同一件左对齐变体，不另造气泡
    expect(owner.classList.contains('entry-user')).toBe(true);
    expect(owner.classList.contains('entry-user-left')).toBe(false);
    expect(peer.classList.contains('entry-user')).toBe(true);
    expect(peer.classList.contains('entry-user-left')).toBe(true);
    expect(owner.querySelector('.user-bubble')).not.toBeNull();
    expect(peer.querySelector('.user-bubble')).not.toBeNull();
    // 来源行/发送给/群主标记
    expect(peer.querySelector('.user-from-sunx')?.textContent).toContain('A');
    expect(peer.querySelector('.user-from-sunx')?.textContent).toContain('发送给');
    expect(peer.querySelector('.user-from-sunx .sx-sunx-badge')?.textContent).toBe('群主');
    // @Sunx chip = sx-group-mention 芯片（图标+名称不带 @,accent 蓝;2026-11-28 三轮件）；气泡下方只剩时间+复制
    expect(owner.querySelector('.sx-group-mention')?.textContent).toBe('A');
    expect(owner.querySelector('.sx-group-mention .sx-group-mention-ico svg')).not.toBeNull();
    const actions = owner.querySelector('.user-actions')!;
    expect(actions.querySelector('.user-time')).not.toBeNull();
    expect(actions.querySelectorAll('button')).toHaveLength(1);
    expect(actions.querySelector('[aria-label="Copy"]')).not.toBeNull();
    expect(actions.querySelector('[aria-label="delivery receipt"]')).toBeNull();
    expect(actions.querySelector('[aria-label="reply message"]')).toBeNull();
    expect(owner.querySelector('.sx-group-receipt-inline')).toBeNull();
    expect(peer.querySelector('.entry-md .entry-md-body')?.textContent).toContain('回复正文');
    // 输入面=会话 chat-dock/chat-composer
    expect(container.querySelector('.chat-dock .chat-composer')).not.toBeNull();
  });

  it('@ 前缀过滤：@成员 /命令 剥 @ 直发命令(skills/普通消息原样)，@成员 / 触发命令+技能面板（2026-11-28 七轮）', async () => {
    const conn = makeConn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    const input = screen.getByPlaceholderText('使用 @ 选择成员，@全体成员 进行分派') as HTMLTextAreaElement;
    // @ + / 触发命令+技能面板（行首等价）
    fireEvent.change(input, { target: { value: '@A /st' } });
    expect(await screen.findByRole('option', { name: /\/status/ })).toBeDefined();
    // 发送:全文出站(2026-11-28 八轮「显示不去,@ 真正发出时才去」——剥前缀单点在服务端
    // fanoutText),mentions 保留目标
    fireEvent.change(input, { target: { value: '@A /status' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(conn.sunxGroupSend).toHaveBeenCalled());
    const [, body1] = (conn.sunxGroupSend as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { text: string; mentions?: string[] }];
    expect(body1.text).toBe('@A /status');
    expect(body1.mentions).toEqual(['jid_a']);
    // 次令牌非命令(skills/普通词)→同样全文发出
    fireEvent.change(input, { target: { value: '@A /notacmd' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(conn.sunxGroupSend).toHaveBeenCalledTimes(2));
    const [, body2] = (conn.sunxGroupSend as ReturnType<typeof vi.fn>).mock.calls[1] as [string, { text: string }];
    expect(body2.text).toBe('@A /notacmd');
  });

  it('查询侧栏复用项目右栏 sx-sidebar/sx-resizer（可拖宽，--sb-w 落宽）', async () => {
    const conn = makeConn();
    const onToggleSearch = vi.fn();
    const { container } = render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen onSearchClose={vi.fn()} onToggleSearch={onToggleSearch} />);
    await screen.findByText('研发群');
    fireEvent.click(screen.getByRole('button', { name: 'search group messages' }));
    expect(onToggleSearch).toHaveBeenCalledTimes(1);
    const aside = container.querySelector('aside.sx-sidebar.sx-group-search');
    expect(aside).not.toBeNull();
    expect((aside as HTMLElement).style.getPropertyValue('--sb-w')).toBe('420px');
    expect(aside!.querySelector('.sx-resizer')).not.toBeNull();
    expect(aside!.querySelector('.sx-setting-input')).not.toBeNull();
  });

  it('Sunx 面板=群隔离：顶栏入口开右栏，只列本群未归档 Sunx；关闭钮收栏', async () => {
    const conn = makeConn();
    const { container } = render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    fireEvent.click(screen.getByRole('button', { name: 'sunx panel' }));
    await waitFor(() => expect(container.querySelector('aside.sx-group-sunx-panel')).not.toBeNull());
    expect(await screen.findByText('本群甲', {}, { timeout: 3000 })).toBeDefined();
    expect(screen.queryByText('外群乙')).toBeNull(); // 群隔离
    expect(screen.queryByText('归档丙')).toBeNull(); // 归档不上主面板
    fireEvent.click(screen.getByRole('button', { name: 'close sunx panel' }));
    expect(container.querySelector('aside.sx-group-sunx-panel')).toBeNull();
  });

  it('⋯ 紧贴群名右侧；菜单「编辑群名」带群图标；无「群成员」项；编辑群名弹窗左侧群图标', async () => {
    const conn = makeConn();
    const { container } = render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    const title = container.querySelector('.sx-group-topbar .chat-title')!;
    const more = screen.getByRole('button', { name: 'group menu' });
    expect(title.nextElementSibling?.contains(more)).toBe(true); // ⋯ 紧跟群名（非右贴）
    // Sunx 面板/查询两钮在固定簇（fixed 视口定位，CSS 侧落位）
    expect(container.querySelector('.sx-group-topbar-right [aria-label="sunx panel"]')).not.toBeNull();
    expect(container.querySelector('.sx-group-topbar-right [aria-label="search group messages"]')).not.toBeNull();
    fireEvent.click(more);
    expect(screen.queryByRole('menuitem', { name: /群成员/ })).toBeNull(); // 群成员按钮/弹窗退役
    const renameItem = screen.getByRole('menuitem', { name: /编辑群名/ });
    expect(renameItem.querySelector('svg')).not.toBeNull(); // 菜单项左侧群图标（2026-11-27 二轮裁定）
    fireEvent.click(renameItem);
    const dialog = await screen.findByRole('dialog', { name: '编辑群名' });
    // 2026-11-28 四轮裁定「和编辑会话名一致,不要前缀图标」:裸输入框,图标前缀退役
    expect(dialog.querySelector('input.chat-title-input')).not.toBeNull();
    expect(dialog.querySelector('svg')).toBeNull();
  });

  it('查询侧栏打开即收 Sunx 面板（右缘单栏）', async () => {
    const conn = makeConn();
    const { container, rerender } = render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    fireEvent.click(screen.getByRole('button', { name: 'sunx panel' }));
    await waitFor(() => expect(container.querySelector('aside.sx-group-sunx-panel')).not.toBeNull());
    rerender(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen onSearchClose={vi.fn()} />);
    await waitFor(() => expect(container.querySelector('aside.sx-group-sunx-panel')).toBeNull());
  });

  it('群聊空态：群图标+「给 {群名} 群成员分派任务」两行,其余退役（2026-11-28 四轮裁定）', async () => {
    const conn = makeConn();
    (conn.sunxGroupMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ group: { id: 'grp_x', name: '研发群' }, messages: [], cursor: 0, hasMore: false });
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    expect((await screen.findAllByText('研发群')).length).toBeGreaterThanOrEqual(1); // 顶栏群名(+句中群名)
    expect(document.querySelector('.chat-empty .sx-group-empty-ico')).not.toBeNull(); // 第一行群图标
    expect(document.querySelector('.chat-empty .chat-empty-title')?.textContent).toBe('给 研发群 群成员分派任务'); // 第二行
    expect(document.querySelector('.sx-group-empty-cmds')).toBeNull(); // 群命令行退役
    expect(document.querySelector('.chat-empty .chat-empty-hint')).toBeNull(); // 说明行退役
  });

  it('成员 ask 卡在群页弹出：来自 A；选项提交走 replyAsk（同一 pid），提交后撤卡', async () => {
    const conn = makeConn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    expect(await screen.findByText('要发布吗?')).toBeDefined();
    expect(screen.getByText('来自')).toBeDefined();
    expect(screen.getAllByText('A').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('是'));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(conn.replyAsk).toHaveBeenCalledWith('p1', { type: 'selected', labels: ['是'] }));
    await waitFor(() => expect(screen.queryByText('要发布吗?')).toBeNull());
  });

  it('ask 弹窗化：头行 From+成员 左、1/2 分页右，‹› 切到第二题（2026-11-28 九轮）', async () => {
    const conn = makeConn();
    (conn.sunxGroupDetail as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      group: { id: 'grp_x', name: '研发群' },
      members: [{
        id: 'jid_a', name: 'A', live: true, running: false, updatedAt: 2, root: 'D:/w',
        asks: [
          { pid: 'p1', req: { question: '要发布吗?', options: [{ label: '是' }, { label: '否' }] } },
          { pid: 'p2', req: { question: '第二问?', options: [{ label: '好' }] } },
        ],
      }],
      owner: { id: 'grp_x', name: '群主', kind: 'group' as const },
    }));
    const { container } = render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    expect(await screen.findByText('要发布吗?')).toBeDefined();
    const head = container.querySelector('.sx-group-ask-head')!;
    expect(head.querySelector('.sx-group-ask-source')?.textContent).toContain('A'); // 左=来自谁
    expect(head.querySelector('.sx-group-ask-count')?.textContent).toBe('1/2'); // 右=位置/数量
    fireEvent.click(screen.getByRole('button', { name: 'next ask' }));
    expect(await screen.findByText('第二问?')).toBeDefined();
    expect(container.querySelector('.sx-group-ask-count')?.textContent).toBe('2/2');
    expect(screen.queryByText('要发布吗?')).toBeNull(); // 单卡分页:不同时堆叠
    expect(container.querySelector('.sx-group-ask-body')).not.toBeNull(); // 限高正文区在位
  });

  it('@ 面板无筛选行（输入 @ 即活滤）；模型弹层带强度滑条且选中不收口（2026-11-28 三轮）', async () => {
    const conn = makeConn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    const input = screen.getByPlaceholderText('使用 @ 选择成员，@全体成员 进行分派') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@' } });
    expect(await screen.findByRole('menuitem', { name: /全体成员/ })).toBeDefined();
    expect(screen.queryByPlaceholderText('筛选成员…')).toBeNull(); // 筛选行退役
    // 模型弹层:主对话同件=模型行+强度滑条;选中模型不收口(外点/再点收)
    fireEvent.click(screen.getByRole('button', { name: '模型' }));
    expect(await screen.findByRole('menuitem', { name: '跟随成员' })).toBeDefined();
    expect(document.querySelector('.sx-menu-pop.pill-pop input[type="range"]')).not.toBeNull(); // EffortSlider
    fireEvent.click(screen.getByRole('menuitem', { name: 'm1' }));
    expect(screen.getByRole('menuitem', { name: '跟随成员' })).toBeDefined(); // 选中不收口
    // 外点（消息区 mousedown）自关
    fireEvent.mouseDown(document.querySelector('.sx-group-chat')!);
    expect(screen.queryByRole('menuitem', { name: '跟随成员' })).toBeNull();
  });

  it('@ 面板上下选择：↑↓ 移活行（0=全体成员）、Enter 选中、活行高亮（2026-11-28 六轮）', async () => {
    const conn = makeConn();
    const onOpenMember = vi.fn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={onOpenMember} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    const input = screen.getByPlaceholderText('使用 @ 选择成员，@全体成员 进行分派') as HTMLTextAreaElement;
    // 草稿驻留(五轮)可能带着上一用例的草稿——先清空再触发,保证 change 是真变更
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '@' } });
    const rows = await screen.findAllByRole('menuitem');
    expect(rows[0].className).toContain('sx-menuitem-active'); // 初始活行=全体成员
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(rows[1].className).toContain('sx-menuitem-active'); // ↓ 移到成员行
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe('@A ')); // Enter 选中成员 A
    expect(screen.queryByRole('menuitem', { name: /全体成员/ })).toBeNull(); // 选中即收口
  });

  it('「/」面板外点自关、再点输入框重现（slashHidden 闸,2026-11-28 三轮裁定）', async () => {
    const conn = makeConn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    const input = screen.getByPlaceholderText('使用 @ 选择成员，@全体成员 进行分派') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/stop' } });
    expect(await screen.findByRole('option', { name: /\/stop/ })).toBeDefined();
    fireEvent.mouseDown(document.querySelector('.sx-group-chat')!); // 点其他地方
    expect(screen.queryByRole('option', { name: /\/stop/ })).toBeNull();
    fireEvent.click(input); // 再点输入框
    expect(await screen.findByRole('option', { name: /\/stop/ })).toBeDefined();
  });

  it('SUNX 面板头行顶置（SUNX+X+分割线,拖宽把手在位）；查询面板头行「查询群消息 X」同款', async () => {
    const conn = makeConn();
    const { container, rerender } = render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    fireEvent.click(screen.getByRole('button', { name: 'sunx panel' }));
    await waitFor(() => expect(container.querySelector('aside.sx-group-sunx-panel')).not.toBeNull());
    const head = container.querySelector('.sx-group-sunx-panel .sx-panel-head')!;
    expect(head.querySelector('.sx-panel-head-title')?.textContent).toBe('SUNX');
    expect(head.querySelector('[aria-label="close sunx panel"]')).not.toBeNull();
    expect(container.querySelector('.sx-group-sunx-panel .sx-resizer')).not.toBeNull(); // 拖宽加回
    expect(container.querySelector('.sx-group-sunx-panel .sx-side-head')).toBeNull(); // 旧头退役
    rerender(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen onSearchClose={vi.fn()} />);
    const sHead = container.querySelector('.sx-group-search .sx-panel-head')!;
    expect(sHead.querySelector('.sx-panel-head-title')?.textContent).toBe('查询群消息');
    expect(sHead.querySelector('[aria-label="close search"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'run search' })).toBeNull(); // 查询按钮退役
    const bar = container.querySelector('.sx-group-search .sx-group-search-bar')!;
    expect(bar.querySelector('input')).not.toBeNull();
  });

  it('查询活滤：输入即查（去抖）,空态「无匹配消息」（2026-11-28 三轮裁定）', async () => {
    const conn = makeConn();
    const { container } = render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    const input = container.querySelector('.sx-group-search-bar input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '广播' } });
    expect(conn.sunxGroupSearch).not.toHaveBeenCalled(); // 去抖中（250ms 未到）
    await waitFor(() => expect(conn.sunxGroupSearch).toHaveBeenCalledWith('grp_x', '广播', 50));
    (conn.sunxGroupSearch as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    fireEvent.change(input, { target: { value: '不存在的词' } });
    await waitFor(() => expect(conn.sunxGroupSearch).toHaveBeenCalledWith('grp_x', '不存在的词', 50));
    expect(await screen.findByText('无匹配消息')).toBeDefined();
  });
});
