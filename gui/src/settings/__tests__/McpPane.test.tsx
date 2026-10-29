import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { McpPane } from '../McpPane';
import type { McpPaneConn } from '../McpPane';
import type { Connection, McpRow } from '../../connection';

/**
 * Task 22 McpPane 重构桩测(op 端点卡片化+EditorDrawer+批准流+遮蔽标注):conn 全桩
 * (mcpServers/mcpProbe/putMcpOp/settingsRaw 四面,不出网),用例沿 task brief——
 * ①列表渲染+挂载自动探测;②SearchBar 搜索过滤(200ms 防抖);③新增提交 putMcpOp op 形状;
 * ④待确认卡 Approve/Deny 按钮调 op approve/deny;⑤遮蔽标注渲染(全局同名卡灰显+只读);
 * ⑥「JSON 源码」高级折叠非法 JSON 拦截(不落 op);⑦refreshTick 变化触发重拉。
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

  it('「JSON 源码」高级折叠:非法 JSON 提交被拦(行内报错,零 op 落盘)', async () => {
    const { conn, opCalls } = connOf([row()]);
    render(<McpPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    await screen.findByRole('dialog', { name: 'Add MCP server' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('JSON source')); // 展开高级折叠
    fireEvent.change(screen.getByLabelText('Server JSON'), { target: { value: '{ not json' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('alert')).toBeDefined(); // 行内报错
    expect(opCalls).toEqual([]); // 零 op 落盘
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
});
