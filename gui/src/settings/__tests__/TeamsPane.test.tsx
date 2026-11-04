import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TeamsPane } from '../TeamsPane';
import type { TeamsPaneConn } from '../TeamsPane';
import type { Connection, TeamEntryView, AgentEntryView, BuiltinRole } from '../../connection';

/**
 * agents-teams P1 Task 3 TeamsPane 桩测(镜像 AgentsPane.test.tsx 的 connOf stub 模式):
 * conn 全桩(teamsView/putTeamOp/teamBody/agentsView 四面,不出网),用例沿 task brief 3e——
 * ①清单渲染(id 标题/name 副题/来源徽标/成员 chips+missing 警示 chip/shadowed 标/正文/排序
 *   显示副本 project 先/warnings/无 enabled 字段开关不渲染 gating);②启停开关 op 形状
 *   (enable/disable,project 带 root/global 省参);③编辑提交形状(EditorModal:teamBody 全文回填、
 *   members 合并去重保首现、lead ∈ members 失效 lead 不落、缺省键不落);④新增坏 id(非 kebab)
 *   行内拦+合规提交(members=勾选+extra 合并);⑤refreshTick 变化触发重拉;⑥删除两段确认。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

/** putTeamOp 输入形(connection.ts 内联签名提取——桩记录类型用,AgentsPane.test 同款) */
type TeamsOpInput = Parameters<Connection['putTeamOp']>[0];

/** 行构造器:daemon GET /settings/teams view.entries 行形(TeamEntryView)的合法缺省,逐例覆写差面 */
const row = (over: Partial<TeamEntryView> = {}): TeamEntryView => ({
  id: 'core',
  name: 'Core Team',
  description: 'does core work',
  version: '0.1.0',
  members: ['dev', 'writer'],
  lead: 'dev',
  missing: [],
  source: 'project',
  shadowed: false,
  bodyPreview: 'Team charter.',
  ...over,
});

/** agentsView.view.entries 行构造器(成员多选数据源的注册 agent 面) */
const agentRow = (over: Partial<AgentEntryView> = {}): AgentEntryView => ({
  id: 'dev',
  name: 'Developer',
  description: 'writes code',
  source: 'project',
  shadowed: false,
  bodyPreview: 'You are a developer.',
  ...over,
});

/** conn 桩:四面调用记录(teamsView 首答 initial,重拉答 next——未给 next 重拉仍答 initial;
 *  putTeamOp 可编程拒;teamBody 缺省拒——全文装载失败回退预览面,给 body 则答全文;
 *  agentsView 恒答(成员选择器数据源) */
const connOf = (
  initial: TeamEntryView[],
  opts: { builtins?: BuiltinRole[]; agents?: AgentEntryView[]; warnings?: string[]; next?: TeamEntryView[]; opReject?: Error; fullBody?: string } = {},
): {
  conn: TeamsPaneConn;
  teamsViewCalls: Array<string | undefined>;
  agentsViewCalls: Array<string | undefined>;
  opCalls: TeamsOpInput[];
  bodyCalls: Array<['project' | 'global', string, string | undefined]>;
} => {
  const teamsViewCalls: Array<string | undefined> = [];
  const agentsViewCalls: Array<string | undefined> = [];
  const opCalls: TeamsOpInput[] = [];
  const bodyCalls: Array<['project' | 'global', string, string | undefined]> = [];
  let n = 0;
  return {
    conn: {
      teamsView(root?: string) {
        teamsViewCalls.push(root);
        const entries = n++ === 0 || opts.next === undefined ? initial : opts.next;
        return Promise.resolve({ view: { entries, warnings: opts.warnings ?? [] } });
      },
      putTeamOp(input: TeamsOpInput) {
        opCalls.push(input); // 先记录后判拒——拒绝路径同样断言 op 形状
        if (opts.opReject !== undefined) return Promise.reject(opts.opReject);
        return Promise.resolve();
      },
      teamBody(scope, id, root) {
        bodyCalls.push([scope, id, root]);
        return opts.fullBody !== undefined
          ? Promise.resolve({ body: opts.fullBody })
          : Promise.reject(new Error(`/settings/teams/body -> 404`));
      },
      agentsView(root?: string) {
        agentsViewCalls.push(root);
        return Promise.resolve({ builtins: opts.builtins ?? [], view: { entries: opts.agents ?? [], warnings: [] } });
      },
    },
    teamsViewCalls,
    agentsViewCalls,
    opCalls,
    bodyCalls,
  };
};

describe('TeamsPane(卡片化+成员多选+启停)', () => {
  it('清单渲染:id 标题/name 副题/来源徽标/成员 chips+missing 警示 chip/shadowed 标/正文/warnings;排序=显示副本 project 先(wire global→project 仅显示反转);无 enabled 字段开关不渲染(gating)', async () => {
    const { conn, teamsViewCalls, agentsViewCalls } = connOf(
      [
        // wire 序=global→project(catalog 清单序):global 行在前;成员面逐行相异(断言可单点寻址)
        row({ id: 'g-team', name: 'Global Team', description: undefined, version: undefined, lead: undefined, source: 'global', members: ['alpha'], bodyPreview: '全局章程。' }),
        row({ id: 'shared', name: 'Shadowed Team', description: undefined, version: undefined, lead: undefined, source: 'global', shadowed: true, members: ['beta'], bodyPreview: '被遮蔽章程。' }),
        row({ members: ['dev', 'writer', 'ghost'], missing: ['ghost'] }),
      ],
      {
        warnings: ['teams/broken/team.md: frontmatter parse failed'],
      },
    );
    const { container } = render(<TeamsPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('core')).toBeDefined(); // 卡标题=id(注册表键)
    expect(screen.getByText('Core Team')).toBeDefined(); // 副题=name
    expect(screen.getByText('Project')).toBeDefined(); // SourceBadge en 钉
    expect(screen.getAllByText('Global').length).toBeGreaterThan(0);
    expect(screen.getByText('does core work')).toBeDefined(); // 描述行
    expect(screen.getByText('dev')).toBeDefined(); // 成员 chips
    expect(screen.getByText('writer')).toBeDefined();
    const ghost = screen.getByText('ghost');
    expect(ghost.className).toContain('sx-chip-missing'); // missing 成员=警示样式 chip
    expect(ghost.className).toContain('sx-chip'); // 组合子形态(叠加 .sx-chip)
    expect(screen.getByText('Shadowed by project')).toBeDefined(); // shadowed 标注沿现数据
    expect(screen.getByText('Team charter.')).toBeDefined(); // 正文直显
    expect(screen.getByText(/frontmatter parse failed/)).toBeDefined(); // warnings 告警条
    // 显示副本排序:project 行先、global 行后(wire 序反转仅显示;ledger R 裁定)
    const titles = [...container.querySelectorAll('.sx-rc-title')].map((el) => el.textContent);
    expect(titles).toEqual(['core', 'g-team', 'shared']);
    expect(teamsViewCalls).toEqual(['/w/proj']); // 读面带参(project 作用域两级清单)
    expect(agentsViewCalls).toEqual(['/w/proj']); // 成员选择器数据源同 root
    // gating 契约:行不带 enabled 字段 → 开关不渲染(诚实休眠)
    expect(container.querySelector('button[role="switch"]')).toBeNull();
  });

  it('启停开关 op 形状:enabled:true 卡切停 → {op:disable, scope:project, root, id};重拉翻转后再切 → {op:enable,…}', async () => {
    const { conn, opCalls } = connOf([row({ enabled: true })], { next: [row({ enabled: false })] });
    render(<TeamsPane conn={conn} root="/w/proj" />);
    const sw = (await screen.findByRole('switch', { name: 'Enable core' })) as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(opCalls).toEqual([{ op: 'disable', scope: 'project', root: '/w/proj', id: 'core' }]));
    // 重拉(next enabled:false)后开关态翻转为 off → 再切 = op enable
    const sw2 = (await screen.findByRole('switch', { name: 'Enable core' })) as HTMLButtonElement;
    expect(sw2.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw2);
    await waitFor(() =>
      expect(opCalls).toEqual([
        { op: 'disable', scope: 'project', root: '/w/proj', id: 'core' },
        { op: 'enable', scope: 'project', root: '/w/proj', id: 'core' },
      ]),
    );
  });

  it('启停 global 作用域:scope=global 下清单省参,开关 op scope=global 省参 root', async () => {
    const { conn, teamsViewCalls, opCalls } = connOf([row({ source: 'global', enabled: false })]);
    render(<TeamsPane conn={conn} root="/w/proj" scope="global" />);
    const sw = await screen.findByRole('switch', { name: 'Enable core' });
    await waitFor(() => expect(teamsViewCalls).toEqual([undefined])); // 仅全局清单
    fireEvent.click(sw);
    await waitFor(() => expect(opCalls).toEqual([{ op: 'enable', scope: 'global', id: 'core' }])); // 省参 root
  });

  it('编辑提交形状:id 锁定/teamBody 全文回填/成员复选+builtins∪entries 数据源(`id — name`)/Save = upsert(members 合并去重、lead ∈ members、缺省键不落、enabled 显式落)/保存后重拉', async () => {
    const { conn, opCalls, teamsViewCalls, bodyCalls } = connOf(
      [row({ bodyPreview: 'short' })],
      {
        builtins: [{ role: 'builder', name: 'Builder', framing: 'implements plan steps' }],
        agents: [agentRow(), agentRow({ id: 'writer', name: 'Scribe' })],
        fullBody: 'full charter text',
      },
    );
    render(<TeamsPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit core(Project)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit core' });
    expect(dialog).toBeDefined();
    const idInput = screen.getByLabelText('team id') as HTMLInputElement;
    expect(idInput.value).toBe('core');
    expect(idInput.readOnly).toBe(true); // id 编辑态锁定(目录名)
    // G8d 同款全文装载:编辑钮即拉 teamBody 播种全文(成功后截断守卫退役)
    await waitFor(() => expect(bodyCalls).toEqual([['project', 'core', '/w/proj']]));
    const bodyArea = screen.getByLabelText('team body') as HTMLTextAreaElement;
    await waitFor(() => expect(bodyArea.value).toBe('full charter text'));
    // 成员复选数据源=builtins∪entries,行显 `id — name`
    expect(screen.getByText('builder — Builder')).toBeDefined();
    expect(screen.getByText('dev — Developer')).toBeDefined();
    expect(screen.getByText('writer — Scribe')).toBeDefined();
    fireEvent.change(screen.getByLabelText('team name'), { target: { value: 'Core renamed' } });
    fireEvent.change(screen.getByLabelText('team description'), { target: { value: '  docs  ' } });
    fireEvent.change(screen.getByLabelText('team version'), { target: { value: '0.2.0' } });
    fireEvent.click(screen.getByLabelText('team member dev')); // 取消勾选 dev(原 lead)
    fireEvent.click(screen.getByRole('button', { name: 'team lead' })); // lead Select 选项=当前 members
    fireEvent.click(screen.getByRole('option', { name: 'writer' }));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        {
          op: 'upsert',
          scope: 'project',
          root: '/w/proj',
          id: 'core',
          frontmatter: { name: 'Core renamed', description: 'docs', version: '0.2.0', members: ['writer'], lead: 'writer', enabled: true },
          body: 'full charter text',
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // 成功关弹窗
    await waitFor(() => expect(teamsViewCalls).toEqual(['/w/proj', '/w/proj'])); // 保存后重拉

    // 失效 lead 守卫:复开后取消勾选原 lead(dev)且不改 lead 选择 → 提交不带 lead 键(lead ∈ members)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit core(Project)' }));
    await screen.findByRole('dialog', { name: 'Edit core' });
    fireEvent.click(screen.getByLabelText('team member dev'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls[1]).toEqual({
        op: 'upsert',
        scope: 'project',
        root: '/w/proj',
        id: 'core',
        // toEqual 整体精配——frontmatter 无 lead 键即断言失效 lead 不落(lead ∈ members 守卫)
        frontmatter: { name: 'Core Team', description: 'does core work', version: '0.1.0', members: ['writer'], enabled: true },
        body: 'full charter text',
      }),
    );
  });

  it('新增:坏 id(非 kebab)行内拦零 op;合规提交 = upsert(members=勾选+extra 空白分隔合并、去重保首现;空缺省键不落)', async () => {
    const { conn, opCalls } = connOf([], {
      builtins: [{ role: 'builder', name: 'Builder', framing: 'implements plan steps' }],
      agents: [agentRow()],
    });
    render(<TeamsPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('No teams.')).toBeDefined(); // 空清单空态
    fireEvent.click(screen.getByRole('button', { name: '+ New' }));
    await screen.findByRole('dialog', { name: 'New team' });
    fireEvent.change(screen.getByLabelText('team id'), { target: { value: 'Core_Team' } }); // 大写+下划线≠kebab
    fireEvent.change(screen.getByLabelText('team name'), { target: { value: 'Core Team' } });
    fireEvent.click(screen.getByLabelText('team member builder'));
    fireEvent.click(screen.getByLabelText('team member dev'));
    fireEvent.change(screen.getByLabelText('team extra members'), { target: { value: 'writer   builder ' } }); // 与勾选重复 → 去重保首现
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('alert')).toBeDefined(); // kebab 词法行内拦(daemon 400 同文案)
    expect(opCalls).toEqual([]);
    fireEvent.change(screen.getByLabelText('team id'), { target: { value: 'core-team' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([
        {
          op: 'upsert',
          scope: 'project',
          root: '/w/proj',
          id: 'core-team',
          frontmatter: { name: 'Core Team', members: ['builder', 'dev', 'writer'], enabled: true },
          body: '',
        },
      ]),
    );
  });

  it('refreshTick 变化触发重拉(config-changed teams 键外部改动信号)', async () => {
    const { conn, teamsViewCalls } = connOf([row()]);
    const { rerender } = render(<TeamsPane conn={conn} root="/w/proj" refreshTick={0} />);
    await screen.findByText('core');
    expect(teamsViewCalls).toEqual(['/w/proj']);
    rerender(<TeamsPane conn={conn} root="/w/proj" refreshTick={1} />);
    await waitFor(() => expect(teamsViewCalls).toEqual(['/w/proj', '/w/proj']));
  });

  it('删除两段确认:同 aria-label 武装+确认 → {op:delete, scope:project, root, id}', async () => {
    const { conn, opCalls } = connOf([row()]);
    render(<TeamsPane conn={conn} root="/w/proj" />);
    await screen.findByRole('button', { name: 'Delete core(Project)' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete core(Project)' })); // 武装
    fireEvent.click(screen.getByRole('button', { name: 'Delete core(Project)' })); // 确认(段名恒定)
    await waitFor(() => expect(opCalls).toEqual([{ op: 'delete', scope: 'project', root: '/w/proj', id: 'core' }]));
  });
});
