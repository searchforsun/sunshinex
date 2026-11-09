import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useWelcomeWorkspaces } from './use-welcome-workspaces';
import type { WelcomeComposerConn } from './welcome-conn';

const DEFAULT_ROOT = '/tmp/sunshinex-default';
const conn = {
  workspaces: async () => [
    { slug: 'd', root: DEFAULT_ROOT, sessionCount: 0 },
    { slug: 'p', root: '/w/proj-a', sessionCount: 2 },
  ],
} as unknown as WelcomeComposerConn;
const noop = (): void => undefined;

function useHarness(presetRoot: string | undefined, presetSeq: number) {
  const [picked, setPicked] = useState('');
  useWelcomeWorkspaces(conn, presetRoot, presetSeq, { setPicked, setProjOpen: noop, setHint: noop, setDirOpen: noop });
  return picked;
}

describe('useWelcomeWorkspaces 预选意图', () => {
  it('项目「+」预选该项目;随后新对话(无 preset、seq 递增)回默认工作区', async () => {
    const { result, rerender } = renderHook(({ root, seq }: { root: string | undefined; seq: number }) => useHarness(root, seq), {
      initialProps: { root: undefined as string | undefined, seq: 0 },
    });
    await waitFor(() => expect(result.current).toBe(DEFAULT_ROOT));
    rerender({ root: '/w/proj-a', seq: 1 });
    await waitFor(() => expect(result.current).toBe('/w/proj-a'));
    rerender({ root: undefined, seq: 2 });
    await waitFor(() => expect(result.current).toBe(DEFAULT_ROOT));
  });

  it('同一项目重复「+」(seq 递增)在用户改选后重新生效', async () => {
    const { result, rerender } = renderHook(({ root, seq }: { root: string | undefined; seq: number }) => useHarness(root, seq), {
      initialProps: { root: '/w/proj-a' as string | undefined, seq: 1 },
    });
    await waitFor(() => expect(result.current).toBe('/w/proj-a'));
    rerender({ root: undefined, seq: 2 });
    await waitFor(() => expect(result.current).toBe(DEFAULT_ROOT));
    await act(async () => rerender({ root: '/w/proj-a', seq: 3 }));
    await waitFor(() => expect(result.current).toBe('/w/proj-a'));
  });
});
