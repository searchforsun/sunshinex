import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RawPane } from '../RawPane';
import type { RawPaneConn } from '../RawPane';

/**
 * RawPane 恒全局桩测(2026-10-31 用户裁定「高级页面要始终读取全局配置,也只能读取全局配置」):
 * conn 全桩(settingsRaw/putSettingsRaw/settings 三面,不出网),用例——①注入 scope=project+
 * root 仍恒读写全局省参(壳注入退役的钉测);②文件切换(settings→mcp)重读且保存同文件;
 * ③scope 注入变化不触发重读(单次挂载读一遍);④409 hint 呈现(保存拒绝错误原文行内 alert
 * 透出)。空态示例占位(RAW_EXAMPLES)随 content='' 显 placeholder,读取落定后即真值。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

/** conn 桩:三面调用记录;settingsRaw 恒答全局原文;putReject 在场则保存恒拒(409 面测试用) */
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
        return Promise.resolve({ content: '{"from":"global"}' });
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

describe('RawPane(恒全局)', () => {
  it('壳注入 scope=project+root 仍恒读写全局省参(注入退役钉测):挂载自动回显+编辑保存透传', async () => {
    const { conn, rawCalls, putCalls } = connOf();
    render(<RawPane conn={conn} root="/w/proj" scope="project" />);
    expect(((await screen.findByLabelText('raw editor')) as HTMLTextAreaElement).value).toBe('{"from":"global"}');
    expect(rawCalls).toEqual([['global', undefined, 'settings']]); // 恒全局省参(root 不带)
    fireEvent.change(screen.getByLabelText('raw editor'), { target: { value: '{"edited":true}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & save' }));
    await waitFor(() => expect(putCalls).toEqual([['global', undefined, 'settings', '{"edited":true}']]));
    expect(await screen.findByText('Saved — applies to new sessions')).toBeDefined();
  });

  it('切文件(settings→mcp):重读恒全局 + 保存走同文件全局 PUT', async () => {
    const { conn, rawCalls, putCalls } = connOf();
    render(<RawPane conn={conn} root="/w/proj" scope="project" />);
    expect(((await screen.findByLabelText('raw editor')) as HTMLTextAreaElement).value).toBe('{"from":"global"}');
    fireEvent.click(screen.getByLabelText('raw file'));
    fireEvent.click(screen.getByRole('option', { name: 'mcp.json' }));
    expect(((await screen.findByLabelText('raw editor')) as HTMLTextAreaElement).value).toBe('{"from":"global"}'); // mcp 重读落定(桩同文)
    expect(rawCalls).toEqual([
      ['global', undefined, 'settings'],
      ['global', undefined, 'mcp'],
    ]);
    fireEvent.change(screen.getByLabelText('raw editor'), { target: { value: '{"mcpServers":{}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & save' }));
    await waitFor(() => expect(putCalls).toEqual([['global', undefined, 'mcp', '{"mcpServers":{}}']]));
  });

  it('scope 注入变化不触发重读(恒全局——作用域维度退役,挂载读一遍)', async () => {
    const { conn, rawCalls } = connOf();
    const { rerender } = render(<RawPane conn={conn} root="/w/proj" scope="project" />);
    expect(((await screen.findByLabelText('raw editor')) as HTMLTextAreaElement).value).toBe('{"from":"global"}');
    rerender(<RawPane conn={conn} root="/w/proj" scope="global" />);
    expect((screen.getByLabelText('raw editor') as HTMLTextAreaElement).value).toBe('{"from":"global"}');
    expect(rawCalls).toEqual([['global', undefined, 'settings']]); // 无第二笔读取
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
