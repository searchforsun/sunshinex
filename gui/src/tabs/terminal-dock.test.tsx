import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Connection } from '../connection';
import { ComposerPillsLeft } from '../pages/chat/ComposerPills';
import { TerminalDock } from './terminal-dock';

/**
 * 终端下栏首测(2026-11-10 终端 dock):标签档恢复/+ 追签/标签 × 走 App kill 链(onCloseTab)/
 * 面板 × 只收显不杀/双击改名落档;ComposerPills 入口钮随 terminalDockEnabled 显隐(判别力:
 * 入口钮删掉=show 用例红;面板 × 误杀标签=hide 用例红)。
 * TerminalTab 以桩替身(xterm/pty 装配属右栏既有测面):替身回抛 uid 验证激活标签正确装配。
 */

const termStub = vi.hoisted(() => ({ uids: [] as string[] }));
vi.mock('./TerminalTab', () => ({
  TerminalTab: (props: { uid: string }) => {
    termStub.uids.push(props.uid);
    return null;
  },
}));

const CONN = {} as unknown as Connection;

const LS_SESSIONS = 'sunshinex.terminal-dock.sessions';
const seed = (sessionId: string, tabs: Array<{ uid: string; name: string }>, active = ''): void => {
  localStorage.setItem(LS_SESSIONS, JSON.stringify({ [sessionId]: { open: true, tabs, active: active !== '' ? active : tabs[0]!.uid } }));
};

beforeEach(() => {
  localStorage.clear();
  termStub.uids = [];
});

describe('TerminalDock(终端下栏)', () => {
  it('标签档从 localStorage 恢复:渲染全部签名,激活档落 TerminalTab(uid 不变)', () => {
    seed('s1', [{ uid: 'dock-term-1', name: '终端1' }, { uid: 'dock-term-2', name: '终端2' }], 'dock-term-2');
    render(<TerminalDock conn={CONN} sessionId="s1" root="/w/demo" ptyIdFor={() => undefined} onPtyAllocated={() => {}} onCloseTab={() => {}} onHide={() => {}} onHeightChange={() => {}} />);
    expect(screen.getByText('终端1')).toBeTruthy();
    expect(screen.getByText('终端2')).toBeTruthy();
    expect(termStub.uids).toEqual(['dock-term-2']);
  });

  it('+ 追加新签并激活:uid 续号 dock-term-n,缺省名=项目名+序号(项目名/项目名2)', () => {
    seed('s1', [{ uid: 'dock-term-1', name: 'demo' }]);
    const onPtyAllocated = vi.fn();
    render(<TerminalDock conn={CONN} sessionId="s1" root="/w/demo" ptyIdFor={() => undefined} onPtyAllocated={onPtyAllocated} onCloseTab={() => {}} onHide={() => {}} onHeightChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'add terminal' }));
    expect(screen.getByText('demo2')).toBeTruthy();
    expect(termStub.uids[termStub.uids.length - 1]).toBe('dock-term-2');
    const saved = JSON.parse(localStorage.getItem(LS_SESSIONS) ?? '{}') as Record<string, { tabs: Array<{ uid: string }> }>;
    expect(saved.s1.tabs.some((x) => x.uid === 'dock-term-2')).toBe(true);
  });

  it('点击页签切换激活(uid 落 TerminalTab;切会话各回各档)', () => {
    seed('s1', [{ uid: 'dock-term-1', name: 'demo' }, { uid: 'dock-term-2', name: 'demo2' }], 'dock-term-1');
    const { rerender } = render(<TerminalDock conn={CONN} sessionId="s1" root="/w/demo" ptyIdFor={() => undefined} onPtyAllocated={() => {}} onCloseTab={() => {}} onHide={() => {}} onHeightChange={() => {}} />);
    expect(termStub.uids).toEqual(['dock-term-1']);
    fireEvent.click(screen.getByText('demo2'));
    expect(termStub.uids[termStub.uids.length - 1]).toBe('dock-term-2');
    rerender(<TerminalDock conn={CONN} sessionId="s2" root="/w/demo" ptyIdFor={() => undefined} onPtyAllocated={() => {}} onCloseTab={() => {}} onHide={() => {}} onHeightChange={() => {}} />);
    expect(screen.getByText('demo')).toBeTruthy(); // s2 无档→缺省签(项目名,无编号)
    rerender(<TerminalDock conn={CONN} sessionId="s1" root="/w/demo" ptyIdFor={() => undefined} onPtyAllocated={() => {}} onCloseTab={() => {}} onHide={() => {}} onHeightChange={() => {}} />);
    expect(screen.getByText('demo2')).toBeTruthy(); // 回 s1:档恢复(demo2 在列)
  });

  it('标签 × 调 onCloseTab(uid) 并移除该签(App kill 链入口;末签删除补新签)', () => {
    seed('s1', [{ uid: 'dock-term-1', name: '终端1' }, { uid: 'dock-term-2', name: '终端2' }]);
    const onCloseTab = vi.fn();
    render(<TerminalDock conn={CONN} sessionId="s1" root="/w/demo" ptyIdFor={() => undefined} onPtyAllocated={() => {}} onCloseTab={onCloseTab} onHide={() => {}} onHeightChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'close terminal 终端1' }));
    expect(onCloseTab).toHaveBeenCalledWith('dock-term-1');
    expect(screen.queryByText('终端1')).toBeNull();
    expect(screen.getByText('终端2')).toBeTruthy();
  });

  it('面板 × 调 onHide 且不动标签档(pty/档全保——误杀即红)', () => {
    seed('s1', [{ uid: 'dock-term-1', name: '终端1' }]);
    const onHide = vi.fn();
    const onCloseTab = vi.fn();
    render(<TerminalDock conn={CONN} sessionId="s1" root="/w/demo" ptyIdFor={() => undefined} onPtyAllocated={() => {}} onCloseTab={onCloseTab} onHide={onHide} onHeightChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'close terminal dock' }));
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onCloseTab).not.toHaveBeenCalled();
    const saved = JSON.parse(localStorage.getItem(LS_SESSIONS) ?? '{}') as Record<string, { tabs: Array<{ uid: string }> }>;
    expect(saved.s1.tabs.map((x) => x.uid)).toEqual(['dock-term-1']);
  });

  it('双击改名:Enter 提交(40 字截断/空回退缺省),落会话档', () => {
    seed('s1', [{ uid: 'dock-term-1', name: '终端1' }]);
    render(<TerminalDock conn={CONN} sessionId="s1" root="/w/demo" ptyIdFor={() => undefined} onPtyAllocated={() => {}} onCloseTab={() => {}} onHide={() => {}} onHeightChange={() => {}} />);
    fireEvent.doubleClick(screen.getByText('终端1'));
    const input = screen.getByRole('textbox', { name: 'Rename terminal tab' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '构建壳' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('构建壳')).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem(LS_SESSIONS) ?? '{}') as Record<string, { tabs: Array<{ uid: string; name: string }> }>;
    expect(saved.s1.tabs).toEqual([{ uid: 'dock-term-1', name: '构建壳' }]);
  });
});

describe('ComposerPillsLeft 终端入口钮(2026-11-10 移左簇完全访问右侧;terminalDockEnabled 显隐)', () => {
  function mount(enabled: boolean | undefined, onToggleDock?: () => void): void {
    render(
      <ComposerPillsLeft
        pillOpen={null}
        setPillOpen={() => {}}
        sessMode="read-only"
        setSessMode={() => {}}
        conn={CONN}
        sessionId="s1"
        terminalDockEnabled={enabled}
        dockOpen={false}
        onToggleDock={onToggleDock}
      />,
    );
  }

  it('terminalDockEnabled=true:入口钮渲染,点击切 dock(开关回调上抛)', () => {
    const onToggleDock = vi.fn();
    mount(true, onToggleDock);
    fireEvent.click(screen.getByRole('button', { name: 'toggle terminal dock' }));
    expect(onToggleDock).toHaveBeenCalledTimes(1);
  });

  it('terminalDockEnabled=false 或未传(旁路面):入口钮不渲染', () => {
    mount(false);
    expect(screen.queryByRole('button', { name: 'toggle terminal dock' })).toBeNull();
    mount(undefined);
    expect(screen.queryByRole('button', { name: 'toggle terminal dock' })).toBeNull();
  });
});
