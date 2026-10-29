import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PermissionsPane } from '../PermissionsPane';
import type { PermissionsPaneConn } from '../PermissionsPane';
import type { PermissionOpInput, PermissionsBlocks, SettingsView } from '../../connection';

/**
 * Task 25 PermissionsPane 结构化增删桩测:conn 全桩(settings/putPermissionOp 两面,不出网),
 * 用例沿 task brief——①三列渲染(merged 恒只读汇总;project/global 列 deny/allow/additionalDirs
 * 三组 chips+输入行增删);②增删 op 形状(project 带 root、global 省参;add 值 trim);③去重门
 * (输入空/已存在 → Add 禁用零 op);④错误面(op 拒 → 行内 alert,saving 复位可续操作);
 * ⑤root=''(仅全局):project 列只读;⑥refreshTick 变化触发重拉。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

/** blocks 构造器 */
const blocks = (deny: string[] = [], allow: string[] = [], additionalDirs: string[] = []): PermissionsBlocks => ({ deny, allow, additionalDirs });

/** GET /settings 应答构造器(权限三面默认值,逐例覆写) */
const viewOf = (over: { merged?: PermissionsBlocks; project?: PermissionsBlocks; global?: PermissionsBlocks } = {}): SettingsView => ({
  keys: [],
  permissions: {
    merged: over.merged ?? blocks(['Bash(curse *)'], ['Read'], ['/opt']),
    project: over.project ?? blocks(['Bash(rm -rf /*)']),
    global: over.global ?? blocks([], ['Read(**)'], ['/tmp/playground']),
  },
  providers: { choices: [], apiKeyPresent: {}, warnings: [] },
});

/** conn 桩:settings 调用记录;首答 initial,重拉答 next(未给重拉仍答 initial);
 *  putPermissionOp 记录后可编程拒——拒绝路径同样断言 op 形状 */
const connOf = (
  initial: SettingsView,
  opts: { next?: SettingsView; opReject?: Error } = {},
): { conn: PermissionsPaneConn; settingsCalls: Array<string | undefined>; opCalls: PermissionOpInput[] } => {
  const settingsCalls: Array<string | undefined> = [];
  const opCalls: PermissionOpInput[] = [];
  let n = 0;
  return {
    conn: {
      settings(root?: string) {
        settingsCalls.push(root);
        return Promise.resolve(n++ === 0 || opts.next === undefined ? initial : opts.next);
      },
      putPermissionOp(input: PermissionOpInput) {
        opCalls.push(input); // 先记录后判拒
        if (opts.opReject !== undefined) return Promise.reject(opts.opReject);
        return Promise.resolve();
      },
    },
    settingsCalls,
    opCalls,
  };
};

describe('PermissionsPane(结构化增删)', () => {
  it('三列渲染:merged 只读汇总(纯文本,零增删件);project/global 列三组 chips+remove 钮+add 输入行', async () => {
    const { conn, settingsCalls } = connOf(viewOf());
    const { container } = render(<PermissionsPane conn={conn} root="/w/proj" title="Permissions" />);
    expect(await screen.findByText('Bash(rm -rf /*)')).toBeDefined(); // project deny chip
    expect(screen.getByText('Bash(curse *)')).toBeDefined(); // merged 只读汇总
    expect(screen.getByText('Read(**)')).toBeDefined(); // global allow chip
    expect(screen.getByText('/tmp/playground')).toBeDefined(); // global additionalDirs chip
    expect(settingsCalls).toEqual(['/w/proj']);
    // 六条 add 输入行(3 列表 × project/global 两级)
    for (const list of ['deny', 'allow', 'additionalDirs']) {
      expect(screen.getByLabelText(`add ${list} (project)`)).toBeDefined();
      expect(screen.getByLabelText(`add ${list} (global)`)).toBeDefined();
    }
    // remove 钮只在 project/global chips 上(merged 只读——零 remove 钮命中 merged 值)
    const removeLabels = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].map((b) => b.getAttribute('aria-label'));
    expect(removeLabels).toContain('remove deny (project) Bash(rm -rf /*)');
    expect(removeLabels).toContain('remove allow (global) Read(**)');
    expect(removeLabels).toContain('remove additionalDirs (global) /tmp/playground');
    expect(removeLabels.filter((l) => (l ?? '').startsWith('remove')).every((l) => l!.includes('(project)') || l!.includes('(global)'))).toBe(true);
  });

  it('add op 形状:project 带 root;值 trim;成功后重拉(next 面板含新值)', async () => {
    const { conn, opCalls, settingsCalls } = connOf(viewOf(), { next: viewOf({ project: blocks(['Bash(rm -rf /*)', 'X']) }) });
    render(<PermissionsPane conn={conn} root="/w/proj" title="Permissions" />);
    const input = (await screen.findByLabelText('add deny (project)')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  X  ' } });
    fireEvent.click(screen.getByLabelText('+ Add deny (project)'));
    await waitFor(() => expect(opCalls).toEqual([{ op: 'add', scope: 'project', root: '/w/proj', list: 'deny', value: 'X' }]));
    expect(settingsCalls).toEqual(['/w/proj', '/w/proj']); // 成功后重拉
    await screen.findByText('X'); // 重拉面板渲染新 chip
    expect((screen.getByLabelText('add deny (project)') as HTMLInputElement).value).toBe(''); // 草稿清空
  });

  it('add op 形状 global:scope=global 省参 root;additionalDirs 同通路', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<PermissionsPane conn={conn} root="/w/proj" title="Permissions" />);
    fireEvent.change(await screen.findByLabelText('add additionalDirs (global)'), { target: { value: '/opt/w' } });
    fireEvent.click(screen.getByLabelText('+ Add additionalDirs (global)'));
    await waitFor(() => {
      expect(opCalls).toEqual([{ op: 'add', scope: 'global', list: 'additionalDirs', value: '/opt/w' }]);
      expect(opCalls[0]).not.toHaveProperty('root'); // global 省参不留空串伪参
    });
  });

  it('remove op 形状:chip × 钮 → {op:remove, scope, root?, list, value}', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<PermissionsPane conn={conn} root="/w/proj" title="Permissions" />);
    fireEvent.click(await screen.findByRole('button', { name: 'remove deny (project) Bash(rm -rf /*)' }));
    await waitFor(() => expect(opCalls).toEqual([{ op: 'remove', scope: 'project', root: '/w/proj', list: 'deny', value: 'Bash(rm -rf /*)' }]));
  });

  it('去重门:输入空/与既有 chip 重值 → Add 禁用,点击零 op', async () => {
    const { conn, opCalls } = connOf(viewOf());
    render(<PermissionsPane conn={conn} root="/w/proj" title="Permissions" />);
    const input = (await screen.findByLabelText('add deny (project)')) as HTMLInputElement;
    const add = screen.getByLabelText('+ Add deny (project)') as HTMLButtonElement;
    expect(add.disabled).toBe(true); // 空输入禁用
    fireEvent.click(add);
    expect(opCalls).toEqual([]);
    fireEvent.change(input, { target: { value: 'Bash(rm -rf /*)' } }); // 与既有 chip 重值
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(opCalls).toEqual([]);
  });

  it('错误面:op 拒 → 行内 alert 示错,saving 复位后续操作可发', async () => {
    const { conn, opCalls } = connOf(viewOf(), { opReject: new Error('/settings/permissions/op -> 409') });
    render(<PermissionsPane conn={conn} root="/w/proj" title="Permissions" />);
    fireEvent.change(await screen.findByLabelText('add allow (global)'), { target: { value: 'Web(y)' } });
    fireEvent.click(screen.getByLabelText('+ Add allow (global)'));
    expect(await screen.findByRole('alert')).toBeDefined(); // 错误条行内示出(不弹全局)
    // saving 复位:remove 钮恢复可点,第二笔 op 照发
    fireEvent.click(screen.getByRole('button', { name: 'remove deny (project) Bash(rm -rf /*)' }));
    await waitFor(() =>
      expect(opCalls).toEqual([
        { op: 'add', scope: 'global', list: 'allow', value: 'Web(y)' },
        { op: 'remove', scope: 'project', root: '/w/proj', list: 'deny', value: 'Bash(rm -rf /*)' },
      ]),
    );
  });

  it('root 为空(仅全局):project 列只读(零增删件),global 列照常可写;settings 省参', async () => {
    const { conn, settingsCalls } = connOf(viewOf({ project: blocks() }));
    const { container } = render(<PermissionsPane conn={conn} root="" title="Permissions" />);
    expect(await screen.findByText('Read(**)')).toBeDefined();
    expect(settingsCalls).toEqual([undefined]); // 仅全局面省参
    expect(screen.queryByLabelText('add deny (project)')).toBeNull();
    expect(screen.getByLabelText('add allow (global)')).toBeDefined();
    const removeLabels = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].map((b) => b.getAttribute('aria-label'));
    expect(removeLabels.some((l) => (l ?? '').includes('(project)'))).toBe(false);
    expect(removeLabels).toContain('remove allow (global) Read(**)');
  });

  it('refreshTick 变化触发重拉(config-changed 外部改动信号)', async () => {
    const { conn, settingsCalls } = connOf(viewOf());
    const { rerender } = render(<PermissionsPane conn={conn} root="/w/proj" title="Permissions" refreshTick={0} />);
    await screen.findByText('Bash(rm -rf /*)');
    expect(settingsCalls).toEqual(['/w/proj']);
    rerender(<PermissionsPane conn={conn} root="/w/proj" title="Permissions" refreshTick={1} />);
    await waitFor(() => expect(settingsCalls).toEqual(['/w/proj', '/w/proj']));
  });
});
