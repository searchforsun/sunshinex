import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentsPane } from '../AgentsPane';
import type { AgentsPaneConn } from '../AgentsPane';
import type { Connection, AgentEntryView, BuiltinRole } from '../../connection';

/**
 * Task 23 AgentsPane 重构桩测(卡片化+enabled 开关+旧位置迁移+EditorDrawer+SearchBar):
 * conn 全桩(agentsView/putAgentOp/agentBody 三面,不出网),用例沿 task brief——
 * ①卡片渲染(id/name/badge/chips/shadowed 标/正文折叠/builtins 只读卡/warnings;行无 enabled
 *   字段=daemon 未富化 → 开关不渲染的 gating 契约);②启停开关 op 形状(enable/disable,
 *   project 带 root/global 省参);③旧位置卡迁移钮 op 形状(migrate 恒 root+id,非 legacy 卡无钮);
 * ④编辑提交形状(EditorDrawer:upsert scope=卡 source;id 编辑态锁定;截断守卫兜底仍在);
 * ⑤SearchBar 搜索过滤(200ms 防抖);⑥refreshTick 变化触发重拉。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

/** putAgentOp 输入形(connection.ts 内联签名提取——桩记录类型用,McpPane.test McpOpInput 同款) */
type AgentsOpInput = Parameters<Connection['putAgentOp']>[0];

/** 行构造器:daemon GET /settings/agents view.entries 行形(AgentEntryView)的合法缺省,逐例覆写差面 */
const row = (over: Partial<AgentEntryView> = {}): AgentEntryView => ({
  id: 'dev',
  name: 'Developer',
  description: 'writes code',
  memory: true,
  isolation: 'worktree',
  executor: 'internal-team',
  source: 'project',
  shadowed: false,
  bodyPreview: 'You are a developer.',
  ...over,
});

/** conn 桩:三面调用记录(agentsView 首答 initial,重拉答 next——未给 next 重拉仍答 initial;
 *  putAgentOp 可编程拒;agentBody 缺省拒——G8d 全文装载失败回退预览面,给 body 则答全文) */
const connOf = (
  initial: AgentEntryView[],
  opts: { builtins?: BuiltinRole[]; warnings?: string[]; next?: AgentEntryView[]; opReject?: Error; fullBody?: string } = {},
): {
  conn: AgentsPaneConn;
  agentsViewCalls: Array<string | undefined>;
  opCalls: AgentsOpInput[];
  bodyCalls: Array<['project' | 'global', string, string | undefined]>;
} => {
  const agentsViewCalls: Array<string | undefined> = [];
  const opCalls: AgentsOpInput[] = [];
  const bodyCalls: Array<['project' | 'global', string, string | undefined]> = [];
  let n = 0;
  return {
    conn: {
      agentsView(root?: string) {
        agentsViewCalls.push(root);
        const entries = n++ === 0 || opts.next === undefined ? initial : opts.next;
        return Promise.resolve({ builtins: opts.builtins ?? [], view: { entries, warnings: opts.warnings ?? [] } });
      },
      putAgentOp(input: AgentsOpInput) {
        opCalls.push(input); // 先记录后判拒——拒绝路径同样断言 op 形状
        if (opts.opReject !== undefined) return Promise.reject(opts.opReject);
        return Promise.resolve();
      },
      agentBody(scope, id, root) {
        bodyCalls.push([scope, id, root]);
        return opts.fullBody !== undefined
          ? Promise.resolve({ body: opts.fullBody })
          : Promise.reject(new Error(`/settings/agents/body -> 404`));
      },
    },
    agentsViewCalls,
    opCalls,
    bodyCalls,
  };
};

describe('AgentsPane(卡片化+启停+旧位置迁移)', () => {
  it('卡片渲染:id 标题/名字副题/来源徽标/属性 chips/shadowed 标/正文折叠/builtins 只读卡/warnings;行无 enabled 字段 → 开关不渲染(gating 契约)', async () => {
    const { conn, agentsViewCalls } = connOf(
      [row(), row({ id: 'shared', name: 'Shared G', description: undefined, memory: undefined, isolation: undefined, executor: undefined, source: 'global', shadowed: true, bodyPreview: '全局版。' })],
      {
        builtins: [{ role: 'builder', name: 'Builder', framing: 'implements plan steps' }],
        warnings: ['agents/broken/agent.md: frontmatter parse failed'],
      },
    );
    const { container } = render(<AgentsPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('dev')).toBeDefined(); // 卡标题=id(注册表键)
    expect(screen.getByText('Developer')).toBeDefined(); // 副题=name
    expect(screen.getByText('Project')).toBeDefined(); // SourceBadge en 钉
    expect(screen.getByText('Global')).toBeDefined();
    expect(screen.getByText('writes code')).toBeDefined(); // 描述行
    expect(screen.getByText('memory')).toBeDefined(); // 属性 chips
    expect(screen.getByText('isolation:worktree')).toBeDefined();
    expect(screen.getByText('executor:internal-team')).toBeDefined();
    expect(screen.getByText('Shadowed by project')).toBeDefined(); // shadowed 标注沿现数据
    expect(screen.getByText('Builder')).toBeDefined(); // builtins 只读卡(role/name/framing)
    expect(screen.getByText('builder')).toBeDefined();
    expect(screen.getByText(/frontmatter parse failed/)).toBeDefined(); // warnings 告警条
    expect(screen.getByText('You are a developer.')).toBeDefined(); // 正文折叠(details 默认展开渲染于 DOM)
    expect(agentsViewCalls).toEqual(['/w/proj']); // 读面带参(project 作用域两级清单)
    // gating 契约:行不带 enabled 字段(现 daemon 未富化)→ 开关不渲染(诚实休眠,富化后自动点亮)
    expect(container.querySelector('button[role="switch"]')).toBeNull();
  });

  it('启停开关 op 形状:enabled:true 卡切停 → {op:disable, scope:project, root, id};重拉后再切 → {op:enable,…}', async () => {
    const { conn, opCalls } = connOf([row({ enabled: true })], { next: [row({ enabled: false })] });
    render(<AgentsPane conn={conn} root="/w/proj" />);
    const sw = (await screen.findByRole('switch', { name: 'Enable dev' })) as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(opCalls).toEqual([{ op: 'disable', scope: 'project', root: '/w/proj', id: 'dev' }]));
    // 重拉(next enabled:false)后开关态翻转为 off → 再切 = op enable
    const sw2 = (await screen.findByRole('switch', { name: 'Enable dev' })) as HTMLButtonElement;
    expect(sw2.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw2);
    await waitFor(() => expect(opCalls).toEqual([{ op: 'disable', scope: 'project', root: '/w/proj', id: 'dev' }, { op: 'enable', scope: 'project', root: '/w/proj', id: 'dev' }]));
  });

  it('启停开关 global 作用域:scope=global 下清单省参,开关 op scope=global 省参 root', async () => {
    const { conn, agentsViewCalls, opCalls } = connOf([row({ source: 'global', enabled: false })]);
    render(<AgentsPane conn={conn} root="/w/proj" scope="global" />);
    const sw = await screen.findByRole('switch', { name: 'Enable dev' });
    await waitFor(() => expect(agentsViewCalls).toEqual([undefined])); // 仅全局清单
    fireEvent.click(sw);
    await waitFor(() => expect(opCalls).toEqual([{ op: 'enable', scope: 'global', id: 'dev' }])); // 省参 root
  });

  it('旧位置卡:「Old location」标注 + Migrate 钮 → {op:migrate, root, id}(非 legacy 卡无迁移钮);migrate 404 行内示错', async () => {
    const { conn, opCalls } = connOf(
      [row({ oldLocation: true }), row({ id: 'nh', name: 'New home', oldLocation: false })],
      { opReject: new Error('/settings/agents/op -> 404') },
    );
    render(<AgentsPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('Old location')).toBeDefined(); // 旧位置卡标
    expect(screen.queryByText('New home')).toBeDefined();
    // 非 legacy 卡无迁移钮;legacy 卡迁移钮 → op migrate(恒项目级 root 锚定)
    expect(screen.queryByRole('button', { name: 'Migrate to .sunshinex/ nh' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Migrate to .sunshinex/ dev' }));
    await waitFor(() => expect(opCalls).toEqual([{ op: 'migrate', root: '/w/proj', id: 'dev' }]));
    // stub 恒拒(404 非 legacy)→ actionError 行内示错(saving 复位,不弹全局)
    expect(await screen.findByRole('alert')).toBeDefined();
  });

  it('编辑提交形状:EditorDrawer(Edit dev)id 锁定 → Save = putAgentOp {op:upsert, scope:project, root, id, frontmatter, body};缺省键不落', async () => {
    const { conn, opCalls, agentsViewCalls, bodyCalls } = connOf([row({ bodyPreview: 'short body', isolation: undefined, executor: undefined })], { fullBody: 'full body text' });
    render(<AgentsPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit dev(Project)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit dev' });
    expect(dialog).toBeDefined();
    const idInput = screen.getByLabelText('agent id') as HTMLInputElement;
    expect(idInput.value).toBe('dev');
    expect(idInput.readOnly).toBe(true); // id 编辑态锁定(目录名)
    fireEvent.change(screen.getByLabelText('agent name'), { target: { value: 'Dev renamed' } });
    fireEvent.change(screen.getByLabelText('agent description'), { target: { value: '  docs  ' } });
    fireEvent.change(screen.getByLabelText('agent body'), { target: { value: '正文内容' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        {
          op: 'upsert',
          scope: 'project',
          root: '/w/proj',
          id: 'dev',
          frontmatter: { name: 'Dev renamed', description: 'docs', memory: true },
          body: '正文内容',
        },
      ]),
    );
    // G8d 全文装载面保留:编辑钮即拉 agentBody 播种全文(成功后守卫退役)
    await waitFor(() => expect(bodyCalls).toEqual([['project', 'dev', '/w/proj']]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // 成功关抽屉
    await waitFor(() => expect(agentsViewCalls).toEqual(['/w/proj', '/w/proj'])); // 保存后重拉
  });

  it('截断守卫兜底:agentBody 拒(404)回退 200 字预览播种,未改写正文保存 → 行内示错+零 op;改写正文放行', async () => {
    const { conn, opCalls } = connOf([row({ description: undefined, bodyPreview: 'x'.repeat(200) })]);
    render(<AgentsPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit dev(Project)' }));
    await screen.findByRole('dialog', { name: 'Edit dev' });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('alert')).toBeDefined(); // 截断守卫行内示错
    expect(opCalls).toEqual([]); // 零 op 落盘
    fireEvent.change(screen.getByLabelText('agent body'), { target: { value: '改写后的完整正文' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(opCalls).toHaveLength(1));
    expect(opCalls[0]).toMatchObject({ op: 'upsert', scope: 'project', root: '/w/proj', id: 'dev', body: '改写后的完整正文' });
  });

  it('新增:+ New → EditorDrawer(New agent)id 可编辑 → Save = upsert op(缺省 isolation/executor 不落);坏 id 行内拦', async () => {
    const { conn, opCalls } = connOf([]);
    render(<AgentsPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New' }));
    await screen.findByRole('dialog', { name: 'New agent' });
    fireEvent.change(screen.getByLabelText('agent id'), { target: { value: '../evil' } });
    fireEvent.change(screen.getByLabelText('agent name'), { target: { value: 'Writer' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('alert')).toBeDefined(); // id 安全面行内拦(路径穿越)
    expect(opCalls).toEqual([]);
    fireEvent.change(screen.getByLabelText('agent id'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([{ op: 'upsert', scope: 'project', root: '/w/proj', id: 'writer', frontmatter: { name: 'Writer' }, body: '' }]),
    );
  });

  it('搜索过滤:SearchBar 200ms 防抖后按 id/name 过滤,清空恢复', async () => {
    const { conn } = connOf([row(), row({ id: 'writer', name: 'Scribe', description: undefined })]);
    render(<AgentsPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('dev')).toBeDefined();
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'scri' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByText('dev')).toBeNull(); // 不匹配卡滤除
      expect(screen.getByText('writer')).toBeDefined();
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText('dev')).toBeDefined(); // 清空恢复
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshTick 变化触发重拉(config-changed 外部改动信号)', async () => {
    const { conn, agentsViewCalls } = connOf([row()]);
    const { rerender } = render(<AgentsPane conn={conn} root="/w/proj" refreshTick={0} />);
    await screen.findByText('dev');
    expect(agentsViewCalls).toEqual(['/w/proj']);
    rerender(<AgentsPane conn={conn} root="/w/proj" refreshTick={1} />);
    await waitFor(() => expect(agentsViewCalls).toEqual(['/w/proj', '/w/proj']));
  });
});
