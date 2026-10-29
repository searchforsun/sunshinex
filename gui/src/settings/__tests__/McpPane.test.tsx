import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { McpPane } from '../McpPane';
import type { McpPaneConn } from '../McpPane';
import type { Connection, McpRow } from '../../connection';

/**
 * Task 22 McpPane 重构桩测(op 端点卡片化+编辑弹窗+批准流+遮蔽标注):conn 全桩
 * (mcpServers/mcpProbe/putMcpOp/settingsRaw 四面,不出网),用例沿 task brief——
 * ①列表渲染+挂载自动探测;②SearchBar 搜索过滤(200ms 防抖);③新增提交 putMcpOp op 形状;
 * ④待确认卡 Approve/Deny 按钮调 op approve/deny;⑤遮蔽标注渲染(全局同名卡灰显+只读);
 * ⑥「源码」Tab(2026-10-29 用户裁定:弹窗顶部 配置|源码 两 Tab 替代表单+折叠 JSON 段):
 *   非法 JSON 拦截不落 op、源码非空保存以 JSON 为准+切 Tab 不清内容、清空方回表单组装、
 *   默认 Tab 规则(新增=配置;编辑含表单外隐藏键=源码预填);⑦refreshTick 变化触发重拉;
 * ⑧工具栏作用域下拉(2026-10-29 目标选择器):切换上抛目标 root 字符串(''=全局)+壳换发
 * root+scope 后按新目标重拉;下拉定宽(sx-dd-fixed)。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

/** putMcpOp 输入形(connection.ts 内联签名提取——桩记录类型用,App.test PutAgentInput 同款) */
type McpOpInput = Parameters<Connection['putMcpOp']>[0];

/** 行构造器:daemon GET /settings/mcp 行形(McpRow)的合法缺省,逐例覆写差面(approval Task 15 新字段) */
const row = (over: Partial<McpRow> = {}): McpRow => ({
  name: 'fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'mcp-fs'],
  envKeys: [],
  headerKeys: [],
  source: 'project',
  shadowed: false,
  approval: 'none',
  ...over,
});

/** conn 桩:四面调用记录(首答 initial,重拉答 next——未给 next 重拉仍答 initial);
 *  rawContent=settingsRaw(file:'mcp') 应答(编辑预填 seed 数据源,缺省 null) */
const connOf = (
  initial: McpRow[],
  next?: McpRow[],
  rawContent: string | null = null,
): {
  conn: McpPaneConn;
  mcpServersCalls: Array<string | undefined>;
  probeCalls: Array<[string | undefined, string]>;
  opCalls: McpOpInput[];
  rawCalls: Array<['project' | 'global', string | undefined]>;
} => {
  const mcpServersCalls: Array<string | undefined> = [];
  const probeCalls: Array<[string | undefined, string]> = [];
  const opCalls: McpOpInput[] = [];
  const rawCalls: Array<['project' | 'global', string | undefined]> = [];
  let n = 0;
  return {
    conn: {
      mcpServers(root?: string) {
        mcpServersCalls.push(root);
        const rows = n++ === 0 || next === undefined ? initial : next;
        return Promise.resolve({ servers: rows });
      },
      mcpProbe(root: string | undefined, name: string) {
        probeCalls.push([root, name]);
        return Promise.resolve({ ok: true, tools: [{ name: 'a' }] });
      },
      putMcpOp(input: McpOpInput) {
        opCalls.push(input);
        return Promise.resolve();
      },
      settingsRaw(scope, root) {
        rawCalls.push([scope, root]);
        return Promise.resolve({ content: rawContent });
      },
    },
    mcpServersCalls,
    probeCalls,
    opCalls,
    rawCalls,
  };
};

describe('McpPane(op 端点卡片化)', () => {
  it('列表渲染:卡名/来源徽标/transport chip/命令副题;挂载自动探测(启用卡逐台一探)', async () => {
    const { conn, mcpServersCalls, probeCalls } = connOf([
      row(),
      row({ name: 'web', transport: 'sse', command: undefined, args: undefined, url: 'https://g/web', source: 'global' }),
    ]);
    render(<McpPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('fs')).toBeDefined();
    expect(screen.getByText('web')).toBeDefined();
    expect(screen.getByText('Project')).toBeDefined(); // SourceBadge en 钉
    expect(screen.getByText('Global')).toBeDefined();
    expect(screen.getAllByText('stdio').length).toBeGreaterThan(0); // transport chip(+详情 dl)
    expect(screen.getByText('npx -y mcp-fs')).toBeDefined(); // 命令+args 副题
    expect(screen.getAllByText('https://g/web').length).toBeGreaterThan(0);
    // 读面带参(项目作用域两级清单);挂载自动探测:非停用卡逐台一探
    await waitFor(() => expect(mcpServersCalls).toEqual(['/w/proj']));
    await waitFor(() => expect(probeCalls).toEqual([['/w/proj', 'fs'], ['/w/proj', 'web']]));
    // 探测结果落 details(连通摘要文本在 DOM;两卡各一份)
    expect(screen.getAllByText('Connected · 1 tools')).toHaveLength(2);
  });

  it('搜索过滤:SearchBar 200ms 防抖后按名过滤,清空恢复全列表', async () => {
    const { conn } = connOf([row(), row({ name: 'web', transport: 'sse', command: undefined, args: undefined, url: 'https://g/web', source: 'global' })]);
    render(<McpPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('fs')).toBeDefined();
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'we' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByText('fs')).toBeNull(); // 不匹配卡滤除
      expect(screen.getByText('web')).toBeDefined();
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText('fs')).toBeDefined(); // 清空恢复
    } finally {
      vi.useRealTimers();
    }
  });

  it('新增提交:EditorDrawer 表单 → Save = putMcpOp {op:add, scope:project, root, name, server} + 重拉', async () => {
    const { conn, opCalls, mcpServersCalls } = connOf([row()], [row(), row({ name: 'search', command: 'npx', args: ['-y', 'mcp-search'] })]);
    render(<McpPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add MCP server' });
    expect(dialog).toBeDefined();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'search' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([{ op: 'add', scope: 'project', root: '/w/proj', name: 'search', server: { transport: 'stdio', command: 'npx' } }]),
    );
    // 成功后关抽屉+重拉(第二答含新卡)
    await waitFor(() => {
      expect(mcpServersCalls.length).toBe(2);
      expect(screen.getByText('search')).toBeDefined();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('待确认卡:warn 标注 + Approve/Deny 按钮各调 op approve/deny(scope=project 带 root)', async () => {
    const { conn, opCalls } = connOf([row({ approval: 'pending' })]);
    render(<McpPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('Pending approval')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Approve fs' }));
    await waitFor(() => expect(opCalls).toEqual([{ op: 'approve', scope: 'project', root: '/w/proj', name: 'fs' }]));
    // 重拉后(stub 恒答 pending)拒绝钮仍可用 → op deny
    await waitFor(() => expect((screen.getByRole('button', { name: 'Deny fs' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Deny fs' }));
    await waitFor(() => expect(opCalls).toEqual([{ op: 'approve', scope: 'project', root: '/w/proj', name: 'fs' }, { op: 'deny', scope: 'project', root: '/w/proj', name: 'fs' }]));
  });

  it('遮蔽标注:项目作用域下全局同名卡「Shadowed by project」+ 写钮全禁用;项目卡可写', async () => {
    const { conn, opCalls } = connOf([
      row(),
      row({ name: 'fs', transport: 'http', command: undefined, args: undefined, url: 'https://g/fs', source: 'global', shadowed: true }),
    ]);
    render(<McpPane conn={conn} root="/w/proj" />);
    expect(await screen.findAllByText('fs')).toHaveLength(2);
    expect(screen.getByText('Shadowed by project')).toBeDefined();
    // 全局卡(被遮蔽)写面禁用:无开关(onToggle 不下发)+ Edit/Delete disabled
    const cards = document.querySelectorAll('ul li');
    const globalCard = Array.from(cards).find((c) => c.textContent?.includes('https://g/fs'))!;
    expect(globalCard).toBeDefined();
    expect(globalCard.querySelector('button[aria-label="Enable fs"]')).toBeNull(); // 整机开关不下发(onToggle 缺省)
    expect((globalCard.querySelector('button[aria-label="Edit fs(Global)"]') as HTMLButtonElement).disabled).toBe(true);
    expect((globalCard.querySelector('button[aria-label="Delete fs(Global)"]') as HTMLButtonElement).disabled).toBe(true);
    // 项目卡开关可写:切换 → op disable(name/source 定位)
    const projectSwitch = screen.getByRole('switch', { name: 'Enable fs' }) as HTMLButtonElement;
    expect(projectSwitch.disabled).toBe(false);
    fireEvent.click(projectSwitch);
    await waitFor(() => expect(opCalls).toEqual([{ op: 'disable', scope: 'project', root: '/w/proj', name: 'fs' }]));
  });

  it('「源码」Tab 非法 JSON 提交被拦(行内报错,零 op 落盘;2026-10-29 Tab 形态:弹窗顶部 配置|源码 两 Tab)', async () => {
    const { conn, opCalls } = connOf([row()]);
    render(<McpPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    await screen.findByRole('dialog', { name: 'Add MCP server' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    // 默认落「配置」Tab(表单字段可见);切「源码」Tab(空文本入 Tab 即按表单预填)
    expect(screen.getByLabelText('Command')).toBeDefined(); // 配置 Tab 字段在
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    fireEvent.change(screen.getByLabelText('Server JSON'), { target: { value: '{ not json' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('alert')).toBeDefined(); // 行内报错
    expect(opCalls).toEqual([]); // 零 op 落盘
  });

  it('「源码」非空保存以 JSON 为准 + 切 Tab 不清内容(2026-10-29 用户裁定:配置→源码(预填)→配置 改表单,提交仍 JSON 胜)', async () => {
    const { conn, opCalls } = connOf([row()]);
    render(<McpPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    await screen.findByRole('dialog', { name: 'Add MCP server' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'search' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Source' })); // 预填:表单态快照(name=search,无 command)
    const json = screen.getByLabelText('Server JSON') as HTMLTextAreaElement;
    expect(json.value).toContain('"search"');
    fireEvent.click(screen.getByRole('tab', { name: 'Config' })); // 切回配置
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } }); // 表单改动
    fireEvent.click(screen.getByText('Save'));
    // op server=源码快照(无 command)——jsonText 切 Tab 不清,JSON 胜(钉测:源码非空保存以 JSON 为准)
    await waitFor(() =>
      expect(opCalls).toEqual([{ op: 'add', scope: 'project', root: '/w/proj', name: 'search', server: { transport: 'stdio' } }]),
    );
  });

  it('「源码」清空后保存回落表单组装(清空方解除 JSON 接管);配置 Tab 字段在源码 Tab 隐藏', async () => {
    const { conn, opCalls } = connOf([row()]);
    render(<McpPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    await screen.findByRole('dialog', { name: 'Add MCP server' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'search' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    fireEvent.change(screen.getByLabelText('Server JSON'), { target: { value: '' } }); // 清空解除接管
    fireEvent.click(screen.getByRole('tab', { name: 'Config' }));
    expect(screen.queryByLabelText('Server JSON')).toBeNull(); // 源码 Tab 面隐藏
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(opCalls).toEqual([{ op: 'add', scope: 'project', root: '/w/proj', name: 'search', server: { transport: 'stdio', command: 'node' } }]),
    );
  });

  it('默认 Tab 规则(2026-10-29 用户裁定):新增落「配置」;编辑已有条目存在表单外隐藏键 → 默认落「源码」并预填整条 JSON(隐藏键可见);无隐藏键编辑仍落「配置」', async () => {
    const seed = JSON.stringify({ mcpServers: { fs: { command: 'npx', headers: { 'x-a': '1' } } } });
    const { conn } = connOf([row(), row({ name: 'plain', command: 'node' })], undefined, seed);
    render(<McpPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit fs(Project)' }));
    await screen.findByRole('dialog', { name: 'Edit fs' });
    // 隐藏键(headers)在场 → 默认「源码」:JSON 面可见且预填整条(含隐藏键),配置字段隐藏
    const json = screen.getByLabelText('Server JSON') as HTMLTextAreaElement;
    expect(json.value).toContain('"headers"');
    expect(json.value).toContain('"fs"');
    expect(screen.queryByLabelText('Command')).toBeNull(); // 配置 Tab 面隐藏
    // 切「配置」字段在;切回「源码」内容留存(不清)
    fireEvent.click(screen.getByRole('tab', { name: 'Config' }));
    expect(screen.getByLabelText('Command')).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect((screen.getByLabelText('Server JSON') as HTMLTextAreaElement).value).toContain('"headers"');
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); // 关弹窗
    // 无隐藏键编辑(seed 缺=文件无条目,行字段起步)→ 默认「配置」
    fireEvent.click(await screen.findByRole('button', { name: 'Edit plain(Project)' }));
    await screen.findByRole('dialog', { name: 'Edit plain' });
    expect(screen.getByLabelText('Command')).toBeDefined(); // 配置 Tab 直落
    expect(screen.queryByLabelText('Server JSON')).toBeNull();
  });

  it('refreshTick 变化触发重拉(config-changed 外部改动信号)', async () => {
    const { conn, mcpServersCalls } = connOf([row()]);
    const { rerender } = render(<McpPane conn={conn} root="/w/proj" refreshTick={0} />);
    await screen.findByText('fs');
    expect(mcpServersCalls).toEqual(['/w/proj']);
    rerender(<McpPane conn={conn} root="/w/proj" refreshTick={1} />);
    await waitFor(() => expect(mcpServersCalls).toEqual(['/w/proj', '/w/proj']));
  });

  it('全局作用域(scope=global):清单省参仅全局,全局卡开关走 op scope=global 省参', async () => {
    const { conn, mcpServersCalls, opCalls } = connOf([row({ source: 'global', approval: 'none' })]);
    render(<McpPane conn={conn} root="/w/proj" scope="global" />);
    expect(await screen.findByText('fs')).toBeDefined();
    await waitFor(() => expect(mcpServersCalls).toEqual([undefined])); // 仅全局清单
    const sw = screen.getByRole('switch', { name: 'Enable fs' }) as HTMLButtonElement;
    fireEvent.click(sw);
    await waitFor(() => expect(opCalls).toEqual([{ op: 'disable', scope: 'global', name: 'fs' }])); // 省参 root
  });

  it('工具栏作用域下拉(2026-10-29 目标选择器):切换上抛目标 root 字符串(\'\'=全局);壳换发 root+scope 后按新目标重拉(global 省参/项目带参)', async () => {
    const { conn, mcpServersCalls } = connOf([row({ source: 'global', approval: 'none' })]);
    const raised: string[] = [];
    const scopeOptions = [
      { value: '', label: 'Global' },
      { value: '/w/proj', label: 'proj' },
      { value: '/w/other', label: 'other' },
    ];
    const { rerender } = render(<McpPane conn={conn} root="/w/proj" scope="project" scopeOptions={scopeOptions} onScopeChange={(v) => raised.push(v)} />);
    await screen.findByText('fs');
    await waitFor(() => expect(mcpServersCalls).toEqual(['/w/proj']));
    // 作用域下拉定宽(2026-10-29 用户裁定:sx-dd-fixed 150px 不随内容伸缩)
    expect(screen.getByRole('button', { name: 'Settings scope' }).closest('.sx-dd')!.className).toContain('sx-dd-fixed');
    fireEvent.click(screen.getByRole('button', { name: 'Settings scope' }));
    fireEvent.click(screen.getByRole('option', { name: 'Global' }));
    expect(raised).toEqual(['']); // 只上抛(''=全局,状态留壳层)
    // 壳回写 targetRoot('')后随 props 回流(scope=global+root=''):读面按新目标重拉(global 省参)
    rerender(<McpPane conn={conn} root="" scope="global" scopeOptions={scopeOptions} onScopeChange={(v) => raised.push(v)} />);
    await waitFor(() => expect(mcpServersCalls).toEqual(['/w/proj', undefined]));
    // 选回注册项目:上抛 root 字符串,壳换发 project+root 后带参重拉
    fireEvent.click(screen.getByRole('button', { name: 'Settings scope' }));
    fireEvent.click(screen.getByRole('option', { name: 'other' }));
    expect(raised).toEqual(['', '/w/other']);
    rerender(<McpPane conn={conn} root="/w/other" scope="project" scopeOptions={scopeOptions} onScopeChange={(v) => raised.push(v)} />);
    await waitFor(() => expect(mcpServersCalls).toEqual(['/w/proj', undefined, '/w/other']));
  });
});
