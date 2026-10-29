import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginsPane } from '../PluginsPane';
import type { PluginsPaneConn } from '../PluginsPane';
import type { PluginRow } from '../../connection';

/**
 * Task 24 PluginsPane 重构桩测(搜索+configSchema 配置弹窗+作用域开关):conn 全桩
 * (plugins/putPlugin 两面,不出网),用例沿 task brief——①列表渲染+warnings 三出口(逐卡
 * 告警行+pane 尾聚合装载告警);②SearchBar 搜索过滤(200ms 防抖);③开关 scope 形状两级
 * (project 带 root/global 省参——旧「写死项目级」门退役,root='' 走全局可写);④配置弹窗
 * 提交形状(configSchema 键值表单+schema 外既有键透传保全);⑤无 schema JSON 文本域
 * (非法 JSON 拦截不落盘;合法 JSON 提交解析值);⑥refreshTick 变化触发重拉;
 * ⑦工具栏作用域下拉切换上抛+壳换发 scope 后按新作用域重拉(2026-10-29 三件套入页;
 * 无新增钮——插件目录扫描发现,非用户创建面)。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
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
 *  putPlugin 调用记录 [root, id, patch](root=undefined 即全局省参写) */
const connOf = (
  initial: PluginRow[],
  next?: PluginRow[],
  viewWarnings: string[] = [],
): {
  conn: PluginsPaneConn;
  pluginsCalls: Array<string | undefined>;
  putCalls: Array<[string | undefined, string, { enabled?: boolean; config?: Record<string, unknown> }]>;
} => {
  const pluginsCalls: Array<string | undefined> = [];
  const putCalls: Array<[string | undefined, string, { enabled?: boolean; config?: Record<string, unknown> }]> = [];
  let n = 0;
  return {
    conn: {
      plugins(root?: string) {
        pluginsCalls.push(root);
        const rows = n++ === 0 || next === undefined ? initial : next;
        return Promise.resolve({ plugins: rows, warnings: viewWarnings });
      },
      putPlugin(root: string | undefined, id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) {
        putCalls.push([root, id, patch]);
        return Promise.resolve();
      },
    },
    pluginsCalls,
    putCalls,
  };
};

describe('PluginsPane(搜索+配置抽屉+作用域开关)', () => {
  it('插件卡渲染:名称/版本/来源徽标/开关;逐卡 warnings 行内告警+pane 尾聚合装载告警;root=\'\' 可写(旧项目级写死门退役)', async () => {
    const { conn, pluginsCalls, putCalls } = connOf(
      [row({ warnings: ['[user:broken] plugin.json 非法 JSON: Unexpected token'] })],
      undefined,
      ['[user:broken] plugin skipped: manifest invalid'],
    );
    render(<PluginsPane conn={conn} root="" />);
    expect(await screen.findByText('Browser Use')).toBeDefined();
    expect(screen.getByText('v1.0.0')).toBeDefined();
    expect(screen.getByText('Builtin')).toBeDefined(); // SourceBadge builtin 态(en 钉)
    expect(screen.getByText('Browser automation via plugin MCP')).toBeDefined();
    // 读面省参(root='' 恒全局清单)
    await waitFor(() => expect(pluginsCalls).toEqual([undefined]));
    // 旧「root='' 开关禁用」写死门退役:global 作用域可写,切换走全局省参写
    const sw = screen.getByRole('switch', { name: 'Enable Browser Use' }) as HTMLButtonElement;
    expect(sw.disabled).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(putCalls).toEqual([[undefined, 'browser-use', { enabled: false }]]));
    // warnings 三出口:逐卡行内告警条(role=alert)+pane 尾聚合展开面
    expect(screen.getByText('[user:broken] plugin.json 非法 JSON: Unexpected token')).toBeDefined();
    expect(screen.getByText('1 plugin load warning(s)')).toBeDefined();
    expect(screen.getByText('[user:broken] plugin skipped: manifest invalid')).toBeDefined();
  });

  it('搜索过滤:SearchBar 200ms 防抖后按名过滤,清空恢复全列表', async () => {
    const { conn } = connOf([row(), row({ id: 'web-cap', name: 'Web Capture' })]);
    render(<PluginsPane conn={conn} root="/w/proj" />);
    expect(await screen.findByText('Browser Use')).toBeDefined();
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'web' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByText('Browser Use')).toBeNull(); // 不匹配卡滤除
      expect(screen.getByText('Web Capture')).toBeDefined();
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText('Browser Use')).toBeDefined(); // 清空恢复
    } finally {
      vi.useRealTimers();
    }
  });

  it('开关 scope 两级(project):切换 → putPlugin(root, id, {enabled}) 显式布尔+成功重拉', async () => {
    const { conn, pluginsCalls, putCalls } = connOf([row()], [row({ enabled: false })]);
    render(<PluginsPane conn={conn} root="/w/proj" />);
    const sw = await screen.findByRole('switch', { name: 'Enable Browser Use' });
    expect((sw as HTMLButtonElement).disabled).toBe(false);
    expect(pluginsCalls).toEqual(['/w/proj']); // project 作用域读带 root
    fireEvent.click(sw);
    await waitFor(() => expect(putCalls).toEqual([['/w/proj', 'browser-use', { enabled: false }]]));
    // 成功后重拉:第二答 enabled=false → aria-checked 翻 false
    await waitFor(() => {
      expect(pluginsCalls.length).toBe(2);
      expect(screen.getByRole('switch', { name: 'Enable Browser Use' }).getAttribute('aria-checked')).toBe('false');
    });
  });

  it('开关 scope 两级(global):scope=global → putPlugin(undefined, id, {enabled}) 省参 root', async () => {
    const { conn, pluginsCalls, putCalls } = connOf([row({ enabled: false })]);
    render(<PluginsPane conn={conn} root="/w/proj" scope="global" />);
    const sw = await screen.findByRole('switch', { name: 'Enable Browser Use' });
    await waitFor(() => expect(pluginsCalls).toEqual([undefined])); // global 作用域读省参
    fireEvent.click(sw);
    await waitFor(() => expect(putCalls).toEqual([[undefined, 'browser-use', { enabled: true }]]));
  });

  it('配置抽屉提交形状(configSchema 键值表单):Save → putPlugin(root, id, {config}) 数字转换+schema 外既有键透传保全', async () => {
    const { conn, putCalls, pluginsCalls } = connOf([
      row({
        config: { level: 1, extra: 'keep' },
        configSchema: { level: { type: 'number', description: 'Verbosity level' }, label: { type: 'string' } },
      }),
    ]);
    render(<PluginsPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure Browser Use' }));
    await screen.findByRole('dialog', { name: 'Configure Browser Use' });
    const level = screen.getByLabelText('level') as HTMLInputElement;
    expect(level.value).toBe('1'); // 既有 config 播种
    fireEvent.change(level, { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('label'), { target: { value: 'fast' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(putCalls).toEqual([['/w/proj', 'browser-use', { config: { extra: 'keep', level: 2, label: 'fast' } }]]));
    // 成功后关抽屉+重拉
    await waitFor(() => expect(pluginsCalls.length).toBe(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('无 schema JSON 文本域:非法 JSON 提交被拦(行内报错零落盘);合法 JSON → putPlugin config 解析值', async () => {
    const { conn, putCalls } = connOf([row({ id: 'raw', name: 'Raw', configSchema: undefined, config: { a: 1 } })]);
    render(<PluginsPane conn={conn} root="/w/proj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure Raw' }));
    const json = await screen.findByLabelText('Config JSON');
    fireEvent.change(json, { target: { value: '{ not json' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('alert')).toBeDefined(); // 行内报错
    expect(putCalls).toEqual([]); // 零落盘
    fireEvent.change(json, { target: { value: '{"a":2}' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(putCalls).toEqual([['/w/proj', 'raw', { config: { a: 2 } }]]));
  });

  it('refreshTick 变化触发重拉(config-changed 外部改动信号)', async () => {
    const { conn, pluginsCalls } = connOf([row()]);
    const { rerender } = render(<PluginsPane conn={conn} root="/w/proj" refreshTick={0} />);
    await screen.findByText('Browser Use');
    expect(pluginsCalls).toEqual(['/w/proj']);
    rerender(<PluginsPane conn={conn} root="/w/proj" refreshTick={1} />);
    await waitFor(() => expect(pluginsCalls).toEqual(['/w/proj', '/w/proj']));
  });

  it('工具栏作用域下拉(2026-10-29 目标选择器,只读发现面无添加钮):切换上抛目标 root 字符串(\'\'=全局);壳换发 root+scope 后按新目标重拉(global 省参)', async () => {
    const { conn, pluginsCalls } = connOf([row()]);
    const raised: string[] = [];
    const scopeOptions = [
      { value: '', label: 'Global' },
      { value: '/w/proj', label: 'proj' },
      { value: '/w/other', label: 'other' },
    ];
    const { rerender } = render(<PluginsPane conn={conn} root="/w/proj" scope="project" scopeOptions={scopeOptions} onScopeChange={(v) => raised.push(v)} />);
    await screen.findByText('Browser Use');
    await waitFor(() => expect(pluginsCalls).toEqual(['/w/proj']));
    expect(screen.queryByRole('button', { name: '+ Add' })).toBeNull(); // 无新增钮(目录发现面)
    fireEvent.click(screen.getByRole('button', { name: 'Settings scope' }));
    fireEvent.click(screen.getByRole('option', { name: 'Global' }));
    expect(raised).toEqual(['']); // 只上抛(''=全局,状态留壳层)
    // 壳回写 targetRoot('')后随 props 回流(scope=global+root=''):读面按新目标重拉(global 省参)
    rerender(<PluginsPane conn={conn} root="" scope="global" scopeOptions={scopeOptions} onScopeChange={(v) => raised.push(v)} />);
    await waitFor(() => expect(pluginsCalls).toEqual(['/w/proj', undefined]));
  });
});
