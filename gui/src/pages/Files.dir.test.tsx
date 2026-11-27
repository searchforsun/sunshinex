import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { Files } from './Files';
import type { Connection } from '../connection';

/** 2026-11-27 用户裁定「文件夹禁止从右侧栏打开,从菜单栏定位到指定行就可以」:file 页签探到目录
 *  →尾斜杠回抛(左侧树定位/外开)后自关本签,文件夹不留右侧标签。 */
describe('Files 目录探测', () => {
  it('目录路径:尾斜杠移交 + 自关页签(不再留下 "src" 空文件夹标签)', async () => {
    const readFile = vi.fn(() => Promise.resolve({ path: 'src', type: 'directory' as const, content: '' }));
    const onOpenFile = vi.fn();
    const closeSelf = vi.fn();
    render(
      <Files
        conn={{ readFile } as unknown as Connection}
        sessionId="s1"
        initialPath="src"
        onOpenFile={onOpenFile}
        closeSelf={closeSelf}
      />,
    );
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith('src/'));
    expect(closeSelf).toHaveBeenCalledTimes(1);
  });

  it('普通文件不触发自关', async () => {
    const readFile = vi.fn(() => Promise.resolve({ path: 'a.ts', type: 'file' as const, content: 'ok' }));
    const closeSelf = vi.fn();
    render(
      <Files
        conn={{ readFile } as unknown as Connection}
        sessionId="s1"
        initialPath="a.ts"
        onOpenFile={vi.fn()}
        closeSelf={closeSelf}
      />,
    );
    await waitFor(() => expect(readFile).toHaveBeenCalled());
    expect(closeSelf).not.toHaveBeenCalled();
  });
});
