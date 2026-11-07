import { describe, expect, test, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ChatProps } from '../pages/chat/chat-types';

const captured: { props: ChatProps | null } = { props: null };
vi.mock('../pages/Chat', () => ({
  Chat: (props: ChatProps) => {
    captured.props = props;
    return <div data-testid="side-chat" />;
  },
}));

const { TAB_REGISTRY } = await import('./registry');
type RenderProps = Parameters<(typeof TAB_REGISTRY)[number]['render']>[0];

describe('辅助对话跳转面与主对话同构', () => {
  test('文件/审查/浏览器/记忆/学习技能回调接通 App 开签口径', () => {
    const entry = TAB_REGISTRY.find((e) => e.id === 'sidechat')!;
    const openTab = vi.fn();
    const openFilePath = vi.fn();
    const openMemory = vi.fn();
    const openLearned = vi.fn();
    const p = {
      conn: {},
      sessionId: 'main',
      root: '/w',
      params: { sideId: 'side-1' },
      services: { onOpenTask: () => undefined, board: undefined, teams: [] },
      uid: 'u1',
      ptyIdFor: () => undefined,
      onPtyAllocated: () => undefined,
      openTab,
      closeTab: () => undefined,
      openFilePath,
      openMemory,
      openLearned,
      chatSinkRef: { current: null },
    } as unknown as RenderProps;
    render(entry.render(p));
    const props = captured.props!;
    expect(props.sideChat).toBe(true);
    props.onOpenFile?.('src/a.ts');
    expect(openFilePath).toHaveBeenCalledWith('src/a.ts');
    props.onOpenDiff?.('c1', 'src/a.ts');
    expect(openTab).toHaveBeenCalledWith('diff', { callId: 'c1', path: 'src/a.ts' });
    props.onOpenWeb?.('https://x.test/');
    expect(openTab).toHaveBeenCalledWith('web', { url: 'https://x.test/' });
    props.onOpenMemory?.('slug-a');
    expect(openMemory).toHaveBeenCalledWith('slug-a');
    props.onOpenLearned?.('skill-b');
    expect(openLearned).toHaveBeenCalledWith('skill-b');
    // 2026-11-07 用户裁定撤 11-06「辅助不接」:辅助会话有主会话所有能力,子智能体/任务板开签
    // 挂主会话页签条(services 即主会话投影)——回调在场均可点
    expect(props.onOpenAgent).toBeTypeOf('function');
    expect(props.onOpenTask).toBeTypeOf('function');
  });
});
