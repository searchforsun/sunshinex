import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PluginsPane } from './PluginsPane';
import type { PluginsPaneConn } from './PluginsPane';
import type { PluginRow } from '../connection';

/**
 * PluginsPane 组件桩测(2026-10-26 插件面,Task 12):conn 全桩(仅 plugins/putPlugin 两面,不出网),
 * 三例沿 task brief——①卡渲染+未选 root 写禁用;②切换开关→putPlugin 调用并重拉;③warnings 非空
 * 插件卡显示告警行(+pane 尾聚合装载告警展开面)。测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

/** 行构造器:daemon GET /settings/plugins 行形(PluginRow)的合法缺省,逐例覆写差面 */
const row = (over: Partial<PluginRow> = {}): PluginRow => ({
  id: 'browser-use',
  name: 'Browser Use',
  version: '1.0.0',
  description: 'Browser automation via plugin MCP',
  source: 'builtin',
  enabled: true,
  platformSupported: true,
  servers: ['browser'],
  skillsCount: 0,
  config: {},
  warnings: [],
  ...over,
});

/** conn 桩:plugins 调用记录(首答 initial,重拉答 next——未给 next 重拉仍答 initial);
 *  putPlugin 调用记录 [root, id, patch] */
const connOf = (
  initial: PluginRow[],
  next?: PluginRow[],
  viewWarnings: string[] = [],
): { conn: PluginsPaneConn; pluginsCalls: Array<string | undefined>; putCalls: Array<[string, string, { enabled?: boolean }]> } => {
  const pluginsCalls: Array<string | undefined> = [];
  const putCalls: Array<[string, string, { enabled?: boolean }]> = [];
  let n = 0;
  return {
    conn: {
      plugins(root?: string) {
        pluginsCalls.push(root);
        const rows = n++ === 0 || next === undefined ? initial : next;
        return Promise.resolve({ plugins: rows, warnings: viewWarnings });
      },
      putPlugin(root: string, id: string, patch: { enabled?: boolean }) {
        putCalls.push([root, id, patch]);
        return Promise.resolve();
      },
    },
    pluginsCalls,
    putCalls,
  };
};

describe('PluginsPane 组件(独立 props)', () => {
  it('插件卡渲染:名称/版本/来源徽标/开关;未选 root 时写钮禁用', async () => {
    const { conn, pluginsCalls } = connOf([row()]);
    render(<PluginsPane conn={conn} root="" />);
    expect(await screen.findByText('Browser Use')).toBeDefined();
    expect(screen.getByText('v1.0.0')).toBeDefined();
    expect(screen.getByText('Builtin')).toBeDefined(); // SourceBadge builtin 态(en 钉)
    expect(screen.getByText('Browser automation via plugin MCP')).toBeDefined();
    expect(screen.getByText('browser')).toBeDefined(); // 贡献面行:servers 名列表
    // 写面恒项目级:root='' 开关禁用
    const sw = screen.getByRole('switch', { name: 'Enable Browser Use' }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(pluginsCalls).toEqual([undefined]); // 读面省参(仅全局清单)
  });

  it('切换开关 → putPlugin 调用并重拉', async () => {
    const { conn, pluginsCalls, putCalls } = connOf([row()], [row({ enabled: false })]);
    render(<PluginsPane conn={conn} root="/w/proj" />);
    const sw = await screen.findByRole('switch', { name: 'Enable Browser Use' });
    expect((sw as HTMLButtonElement).disabled).toBe(false);
    expect(pluginsCalls).toEqual(['/w/proj']); // 有 root:读带参
    fireEvent.click(sw);
    await waitFor(() => expect(putCalls).toEqual([['/w/proj', 'browser-use', { enabled: false }]]));
    // 成功后重拉:第二次 plugins() 应答 enabled=false → aria-checked 翻 false
    await waitFor(() => {
      expect(pluginsCalls.length).toBe(2);
      expect(screen.getByRole('switch', { name: 'Enable Browser Use' }).getAttribute('aria-checked')).toBe('false');
    });
  });

  it('加载失败徽标:warnings 非空插件卡显示告警行;pane 尾聚合装载告警可见', async () => {
    const { conn } = connOf(
      [row({ id: 'broken', name: 'Broken', warnings: ['[user:broken] plugin.json 非法 JSON: Unexpected token'], platformSupported: true })],
      undefined,
      ['[user:broken] plugin skipped: manifest invalid'],
    );
    render(<PluginsPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('[user:broken] plugin.json 非法 JSON: Unexpected token')).toBeDefined();
    expect(screen.getByRole('alert')).toBeDefined(); // 行内告警条(role=alert)
    expect(screen.getByText('1 plugin load warning(s)')).toBeDefined(); // pane 尾聚合展开面
    expect(screen.getByText('[user:broken] plugin skipped: manifest invalid')).toBeDefined();
  });
});
