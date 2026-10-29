import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RawPane } from '../RawPane';
import type { RawPaneConn } from '../RawPane';

/**
 * Task 27 RawPane 项目作用域解锁桩测:conn 全桩(settingsRaw/putSettingsRaw/settings 三面,
 * 不出网),用例沿 task brief——①project 作用域挂载自动回显 GET 带 root+保存 PUT 带 root;
 * ②global 作用域读写恒省参 root(URL 面无 root,connection 对 undefined 省参已单测);
 * ③scope 切换(project→global)触发重读且 root 面随作用域切换;④project+mcp 文件保存走
 * 带 root 的 PUT(文件四象限的 mcp 侧);⑤409 hint 呈现(保存拒绝错误原文行内 alert 透出)。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

/** conn 桩:三面调用记录;settingsRaw 按作用域答不同原文(project/global 各一串——重读落定可辨);
 *  putReject 在场则保存恒拒(409/400 面测试用) */
const connOf = (o: { putReject?: Error } = {}): {
  conn: RawPaneConn;
  rawCalls: Array<['project' | 'global', string | undefined, 'settings' | 'mcp']>;
  putCalls: Array<['project' | 'global', string | undefined, 'settings' | 'mcp', string]>;
  settingsCalls: Array<string | undefined>;
} => {
  const rawCalls: Array<['project' | 'global', string | undefined, 'settings' | 'mcp']> = [];
  const putCalls: Array<['project' | 'global', string | undefined, 'settings' | 'mcp', string]> = [];
  const settingsCalls: Array<string | undefined> = [];
  return {
    conn: {
      settingsRaw(scope, root, file) {
        rawCalls.push([scope, root, file]);
        return Promise.resolve({ content: scope === 'project' ? '{"from":"project"}' : '{"from":"global"}' });
      },
      putSettingsRaw(scope, root, file, content) {
        putCalls.push([scope, root, file, content]);
        return o.putReject !== undefined ? Promise.reject(o.putReject) : Promise.resolve();
      },
      settings(root) {
        settingsCalls.push(root);
        return Promise.resolve({ warnings: [] });
      },
    },
    rawCalls,
    putCalls,
    settingsCalls,
  };
};

describe('RawPane(项目作用域解锁)', () => {
  it('project 作用域:挂载自动回显 GET 带 root + 保存 PUT 带 root(编辑原文透传)', async () => {
    const { conn, rawCalls, putCalls } = connOf();
    render(<RawPane conn={conn} root="/w/proj" scope="project" />);
    expect(((await screen.findByLabelText('raw editor')) as HTMLTextAreaElement).value).toBe('{"from":"project"}');
    expect(rawCalls).toEqual([['project', '/w/proj', 'settings']]); // 读取面:project 带 root
    fireEvent.change(screen.getByLabelText('raw editor'), { target: { value: '{"edited":true}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & save' }));
    await waitFor(() => expect(putCalls).toEqual([['project', '/w/proj', 'settings', '{"edited":true}']]));
    expect(await screen.findByText('Saved — applies to new sessions')).toBeDefined();
  });

  it('global 作用域:读写恒省参 root(scope=global、root undefined——connection 省参即 URL 无 root)', async () => {
    const { conn, rawCalls, putCalls } = connOf();
    render(<RawPane conn={conn} root="/w/proj" scope="global" />);
    expect(((await screen.findByLabelText('raw editor')) as HTMLTextAreaElement).value).toBe('{"from":"global"}');
    expect(rawCalls).toEqual([['global', undefined, 'settings']]); // 定位面省参(服务端忽略 root)
    fireEvent.change(screen.getByLabelText('raw editor'), { target: { value: '{"g":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & save' }));
    await waitFor(() => expect(putCalls).toEqual([['global', undefined, 'settings', '{"g":1}']]));
  });

  it('scope 切换(project→global):重读且 root 面随作用域切换,新作用域原文落定编辑器', async () => {
    const { conn, rawCalls } = connOf();
    const { rerender } = render(<RawPane conn={conn} root="/w/proj" scope="project" />);
    expect(((await screen.findByLabelText('raw editor')) as HTMLTextAreaElement).value).toBe('{"from":"project"}');
    rerender(<RawPane conn={conn} root="/w/proj" scope="global" />);
    await waitFor(() => expect((screen.getByLabelText('raw editor') as HTMLTextAreaElement).value).toBe('{"from":"global"}'));
    expect(rawCalls).toEqual([
      ['project', '/w/proj', 'settings'], // 初挂载:project 带 root
      ['global', undefined, 'settings'], // 切作用域:global 省参重读
    ]);
  });

  it('project+切文件(mcp):原文带 root 读取 + 保存走带 root 的 PUT(mcp 四象限)', async () => {
    const { conn, rawCalls, putCalls } = connOf();
    render(<RawPane conn={conn} root="/w/proj" scope="project" />);
    expect(((await screen.findByLabelText('raw editor')) as HTMLTextAreaElement).value).toBe('{"from":"project"}');
    fireEvent.click(screen.getByLabelText('raw file'));
    fireEvent.click(screen.getByRole('option', { name: 'mcp.json' }));
    expect(((await screen.findByLabelText('raw editor')) as HTMLTextAreaElement).value).toBe('{"from":"project"}'); // mcp 重读落定(桩同文)
    expect(rawCalls).toEqual([
      ['project', '/w/proj', 'settings'],
      ['project', '/w/proj', 'mcp'],
    ]);
    fireEvent.change(screen.getByLabelText('raw editor'), { target: { value: '{"mcpServers":{}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & save' }));
    await waitFor(() => expect(putCalls).toEqual([['project', '/w/proj', 'mcp', '{"mcpServers":{}}']]));
  });

  it('409 hint 呈现:保存拒绝(conn 拒因透传)→ 行内 alert 透出错误原文(含 status 行)', async () => {
    const { conn, putCalls } = connOf({ putReject: new Error('/settings/raw -> 409') });
    render(<RawPane conn={conn} root="/w/proj" scope="project" />);
    await screen.findByLabelText('raw editor');
    fireEvent.change(screen.getByLabelText('raw editor'), { target: { value: '// comment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('/settings/raw -> 409');
    expect(putCalls).toHaveLength(1);
  });
});
