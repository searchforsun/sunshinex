import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DirPickerResp } from './connection';
import { DirPicker } from './pages/DirPicker';

/**
 * DirPicker 组件桩测(G8e-T3 回迁):G8a-T5 删 home.test.tsx 时本 describe 随文件退役——组件
 * 本体尚在(ProjectMenu「+ 添加工作区」模态消费),组件级 props/行为契约回归独立成档。conn 全桩
 * (仅 dirpicker 面,不出网),App/e2e 面的装配链各归其档。props 契约:conn(只要 dirpicker)/
 * onConfirm(path, manual)/onCancel——与 G8a 前等价(G6 mode 面起 onConfirm 带 manual 勾选态)。
 */

describe('DirPicker 组件(独立 props)', () => {
  const dirConn = (dirs: DirPickerResp[]) => {
    const calls: Array<string | undefined> = [];
    const conn = {
      dirpicker: (path?: string) => {
        calls.push(path);
        const next = dirs[calls.length - 1] ?? { path: path ?? '/home', parent: '/', dirs: [] };
        return Promise.resolve(next);
      },
    };
    return { conn, calls };
  };

  it('挂载即 dirpicker()(缺省路径)渲染当前路径与子目录', async () => {
    const { conn, calls } = dirConn([{ path: '/home', parent: '/', dirs: ['dev', 'tmp'] }]);
    render(<DirPicker conn={conn} onConfirm={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText('/home')).toBeDefined();
    expect(calls).toEqual([undefined]);
    expect(screen.getByRole('button', { name: 'dev' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'tmp' })).toBeDefined();
  });

  it('逐级:点子目录 dirpicker(拼接路径);「↑ 上级」dirpicker(parent)', async () => {
    const { conn, calls } = dirConn([
      { path: '/home', parent: '/', dirs: ['dev'] },
      { path: '/home/dev', parent: '/home', dirs: ['proj'] },
      { path: '/home', parent: '/', dirs: ['dev'] },
    ]);
    render(<DirPicker conn={conn} onConfirm={() => {}} onCancel={() => {}} />);
    await screen.findByText('/home');
    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    expect(await screen.findByText('/home/dev')).toBeDefined();
    expect(calls[1]).toBe('/home/dev');
    fireEvent.click(screen.getByRole('button', { name: '↑ 上级' }));
    await waitFor(() => expect(calls[2]).toBe('/home'));
  });

  it('盘根形态(parent=自身):上级按钮禁用', async () => {
    const { conn: rootConn } = dirConn([{ path: '/', parent: '/', dirs: [] }]);
    render(<DirPicker conn={rootConn} onConfirm={() => {}} onCancel={() => {}} />);
    await screen.findByText('/');
    expect((screen.getByRole('button', { name: '↑ 上级' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('确认取值:自定义输入非空优先(不经服务端);输入空取当前浏览路径', async () => {
    const { conn } = dirConn([{ path: '/home/dev', parent: '/home', dirs: [] }]);
    const confirmed: string[] = [];
    render(<DirPicker conn={conn} onConfirm={(p) => confirmed.push(p)} onCancel={() => {}} />);
    await screen.findByText('/home/dev');
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    expect(confirmed).toEqual(['/home/dev']);
    fireEvent.change(screen.getByLabelText('custom path'), { target: { value: 'D:/elsewhere' } });
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    expect(confirmed).toEqual(['/home/dev', 'D:/elsewhere']);
  });

  it('G6 manual 勾选:缺省不勾 → onConfirm(path, false);勾选 → onConfirm(path, true)', async () => {
    const { conn } = dirConn([{ path: '/home/dev', parent: '/home', dirs: [] }]);
    const confirmed: Array<[string, boolean]> = [];
    render(<DirPicker conn={conn} onConfirm={(p, m) => confirmed.push([p, m])} onCancel={() => {}} />);
    await screen.findByText('/home/dev');
    const box = screen.getByLabelText('Manual approvals') as HTMLInputElement;
    expect(box.checked).toBe(false); // 缺省不勾
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    expect(confirmed).toEqual([['/home/dev', false]]);
    fireEvent.click(box); // 勾选
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    expect(confirmed).toEqual([
      ['/home/dev', false],
      ['/home/dev', true],
    ]);
  });

  it('「前往」:自定义路径经服务端校验(dirpicker(typed))→ 当前路径切换', async () => {
    const { conn, calls } = dirConn([
      { path: '/home', parent: '/', dirs: [] },
      { path: 'D:/work', parent: 'D:/', dirs: ['proj'] },
    ]);
    render(<DirPicker conn={conn} onConfirm={() => {}} onCancel={() => {}} />);
    await screen.findByText('/home');
    fireEvent.change(screen.getByLabelText('custom path'), { target: { value: 'D:/work' } });
    fireEvent.click(screen.getByRole('button', { name: '前往' }));
    expect(await screen.findByText('D:/work')).toBeDefined();
    expect(calls[1]).toBe('D:/work');
    expect(screen.getByRole('button', { name: 'proj' })).toBeDefined();
  });

  it('取消: onCancel 回调', async () => {
    const { conn } = dirConn([{ path: '/home', parent: '/', dirs: [] }]);
    let cancelled = 0;
    render(<DirPicker conn={conn} onConfirm={() => {}} onCancel={() => (cancelled += 1)} />);
    await screen.findByText('/home');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(cancelled).toBe(1);
  });

  it('服务端 400(路径不存在):错误示出,列表停留', async () => {
    const calls: Array<string | undefined> = [];
    const conn = {
      dirpicker: (path?: string) => {
        calls.push(path);
        return calls.length === 1
          ? Promise.resolve({ path: '/home', parent: '/', dirs: [] })
          : Promise.reject(new Error('/dirpicker?path=%2Fnope -> 400'));
      },
    };
    render(<DirPicker conn={conn} onConfirm={() => {}} onCancel={() => {}} />);
    await screen.findByText('/home');
    fireEvent.change(screen.getByLabelText('custom path'), { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: '前往' }));
    expect(await screen.findByText('/dirpicker?path=%2Fnope -> 400')).toBeDefined();
    expect(screen.getByText('/home')).toBeDefined(); // 停留原列表
  });
});
