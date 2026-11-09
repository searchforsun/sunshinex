import { describe, it, expect } from 'vitest';
import { createRef } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useWelcomeFiles } from './use-welcome-files';
import { useWelcomeSlash } from './use-welcome-slash';
import type { WelcomeComposerConn } from './welcome-conn';

/** 按 root 可控放行的应答桩:resolve(root, value) 手动落定,模拟慢工作区迟到 */
function deferredByRoot<T>() {
  const pending = new Map<string, (v: T) => void>();
  return {
    call: (root: string): Promise<T> => new Promise<T>((res) => pending.set(root, res)),
    resolve: (root: string, v: T): void => pending.get(root)?.(v),
  };
}

describe('欢迎页工作区切换:@ 文件清单随目录更换', () => {
  it('切换即清空;旧工作区迟到应答不覆盖新工作区清单', async () => {
    const d = deferredByRoot<{ files: Array<{ path: string; mtime: number }>; dirs?: string[] }>();
    const conn = { workspaceFiles: d.call } as unknown as WelcomeComposerConn;
    const { result, rerender } = renderHook(({ picked }: { picked: string }) => useWelcomeFiles(conn, picked), { initialProps: { picked: '/a' } });
    await act(async () => d.resolve('/a', { files: [{ path: 'a.md', mtime: 1 }] }));
    expect(result.current.files).toEqual(['a.md']);
    rerender({ picked: '/b' });
    expect(result.current.files).toEqual([]);
    await act(async () => d.resolve('/b', { files: [{ path: 'b.md', mtime: 1 }], dirs: ['src/'] }));
    expect(result.current.files).toEqual(['src/', 'b.md']);
    rerender({ picked: '/a' });
    rerender({ picked: '/b' });
    await act(async () => d.resolve('/a', { files: [{ path: 'stale.md', mtime: 1 }] }));
    expect(result.current.files).not.toContain('stale.md');
  });
});

describe('欢迎页工作区切换:/ 与 + 技能清单随目录更换', () => {
  type Groups = { groups: Array<{ source: string; skills: Array<{ id: string; description?: string }> }> };
  it('切换即清空并重拉;旧工作区迟到应答不覆盖新工作区技能', async () => {
    const d = deferredByRoot<Groups>();
    const conn = { commands: async () => ({ commands: [], descriptions: {}, supported: [] }), skillsGroups: (root?: string) => d.call(root ?? '') } as unknown as WelcomeComposerConn;
    const ref = createRef<HTMLTextAreaElement>();
    const { result, rerender } = renderHook(({ picked }: { picked: string }) => useWelcomeSlash(conn, picked, '', ref), { initialProps: { picked: '/a' } });
    act(() => result.current.fetchWelcomeSkills(true));
    await act(async () => d.resolve('/a', { groups: [{ source: 'project', skills: [{ id: 'alpha' }] }] }));
    expect(result.current.welcomeSkills.map((s) => s.id)).toEqual(['alpha']);
    act(() => result.current.fetchWelcomeSkills(true)); // /a 再拉在途(慢工作区)
    rerender({ picked: '/b' });
    expect(result.current.welcomeSkills).toEqual([]);
    await act(async () => d.resolve('/a', { groups: [{ source: 'project', skills: [{ id: 'stale' }] }] }));
    expect(result.current.welcomeSkills).toEqual([]);
    await act(async () => d.resolve('/b', { groups: [{ source: 'project', skills: [{ id: 'beta' }] }] }));
    await waitFor(() => expect(result.current.welcomeSkills.map((s) => s.id)).toEqual(['beta']));
  });
});

describe('欢迎页 / 技能清单停用过滤', () => {
  it('disabled 行不进 / 与 + 候选(与会话内同口径)', async () => {
    const conn = {
      commands: async () => ({ commands: [], descriptions: {}, supported: [] }),
      skillsGroups: async () => ({ groups: [{ source: 'project', skills: [{ id: 'on-skill', description: 'live' }, { id: 'off-skill', description: 'off', disabled: true }] }] }),
    } as unknown as WelcomeComposerConn;
    const ref = createRef<HTMLTextAreaElement>();
    const { result } = renderHook(() => useWelcomeSlash(conn, '/a', '', ref));
    act(() => result.current.fetchWelcomeSkills(true));
    await waitFor(() => expect(result.current.welcomeSkills.map((s) => s.id)).toEqual(['on-skill']));
  });
});
