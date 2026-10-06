import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { Files } from './pages/Files';
import { DiffPanel } from './diff-panel';
import { Chat } from './pages/Chat';
import { highlightCode } from './highlight';
import { emptyBoard } from './projection';
import type { Connection, FileResp, SnapshotResponse } from './connection';
import type { ChatSink } from './pages/Chat';
import type { MutableRefObject } from 'react';
import type { SessionEvent } from '../../src/types';

/**
 * G6 预览+diff 组件测:Files 页（输入 Enter 加载/高亮 class/truncated 横幅/403 错误态/
 * initialPath 自动加载）、DiffPanel 双列与单列形态、highlightCode 扩展映射、Chat 工具条
 * write 展开（DiffPanel 内容 + path 按钮 → onOpenFile）与非 write 展开（result 摘要）。
 * 连接面以对象桩钉 readFile/sessionSnapshot 口径（Files/Chat 只消费这两个面）。
 */

const noop = (): void => {};

/** Files 页连接桩:readFile 可编程应答 */
function connOf(over: Partial<Connection> = {}): Connection {
  return { readFile: vi.fn(() => Promise.resolve({ path: '/r/a.ts', content: 'const x = 1;\n' })), ...over } as unknown as Connection;
}

describe('highlightCode:扩展名→语言映射', () => {
  it('.ts → typescript(产出 hljs token class);未知扩展缺省 plaintext(零 token)', () => {
    const html = highlightCode('const x = 1;', 'a.ts');
    expect(html).toContain('hljs-keyword'); // const → keyword token
    const plain = highlightCode('const x = 1;', 'a.unknownext');
    expect(plain).not.toContain('hljs-');
    expect(plain).toContain('const'); // plaintext 原文透传
  });

  it('映射表覆盖面:tsx/json/md/bash 各得其所(产出 span 包裹)', () => {
    expect(highlightCode('{"a":1}', 'x.json')).toContain('hljs-attr');
    expect(highlightCode('# t', 'x.md')).toContain('hljs-section');
    expect(highlightCode('export default () => 1;', 'x.tsx')).toContain('hljs-keyword');
    expect(highlightCode('echo hi', 'x.sh')).toContain('hljs-built_in');
  });
});

describe('DiffPanel:双列/单列形态', () => {
  it('old+new:双列 pre(左 old 右 new)+ 标题行 − old / + new', () => {
    render(<DiffPanel oldStr="旧内容" newStr="新内容" />);
    expect(screen.getByLabelText('diff')).toBeDefined();
    expect(screen.getByText('− old')).toBeDefined();
    expect(screen.getByText('+ new')).toBeDefined();
    const cols = document.querySelectorAll('.diff-panel .diff-col');
    expect(cols).toHaveLength(2);
    expect(cols[0]!.textContent).toBe('旧内容');
    expect(cols[0]!.className).toContain('diff-old');
    expect(cols[1]!.textContent).toBe('新内容');
    expect(cols[1]!.className).toContain('diff-new');
  });

  it('无 oldStr:只右列(write 整文件替换写形态)', () => {
    render(<DiffPanel newStr="唯一内容" />);
    const cols = document.querySelectorAll('.diff-panel .diff-col');
    expect(cols).toHaveLength(1);
    expect(cols[0]!.className).toContain('diff-new');
    expect(cols[0]!.textContent).toBe('唯一内容');
  });
});

describe('Files 页:输入加载/高亮/横幅/错误态', () => {
  it('输入路径 Enter 加载:conn.readFile(sessionId, path) → 高亮渲染(hljs class 在场)', async () => {
    const conn = connOf();
    render(<Files conn={conn} sessionId="s1" />);
    fireEvent.change(screen.getByLabelText('file path input'), { target: { value: 'src/a.ts' } });
    fireEvent.keyDown(screen.getByLabelText('file path input'), { key: 'Enter' });
    await waitFor(() => expect(conn.readFile).toHaveBeenCalledWith('s1', 'src/a.ts'));
    await waitFor(() => expect(screen.getByLabelText('file content')).toBeDefined());
    expect(document.querySelector('.files-view .hljs-keyword')).not.toBeNull(); // const → keyword
    expect(document.querySelector('.files-truncated')).toBeNull(); // 未截断无横幅
  });

  it('truncated 横幅:truncated:true 回执 → 截断标记在场', async () => {
    const conn = connOf({ readFile: vi.fn(() => Promise.resolve({ path: '/r/big.txt', content: 'x', truncated: true } as FileResp)) });
    render(<Files conn={conn} sessionId="s1" initialPath="big.txt" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('512KB'));
  });

  it('403 错误态:readFile 拒绝 → 错误消息示出(含 status)', async () => {
    const conn = connOf({ readFile: vi.fn(() => Promise.reject(new Error('/session/s1/file?path=../x -> 403'))) });
    render(<Files conn={conn} sessionId="s1" />);
    fireEvent.change(screen.getByLabelText('file path input'), { target: { value: '../x' } });
    fireEvent.click(screen.getByRole('button', { name: '加载' }));
    await waitFor(() => expect(screen.getByText('/session/s1/file?path=../x -> 403')).toBeDefined());
    expect(document.querySelector('.files-view')).toBeNull(); // 无内容面
  });

  it('initialPath 到场自动加载(跳转面)', async () => {
    const conn = connOf();
    render(<Files conn={conn} sessionId="s1" initialPath="src/jump.ts" />);
    await waitFor(() => expect(conn.readFile).toHaveBeenCalledWith('s1', 'src/jump.ts'));
    expect((screen.getByLabelText('file path input') as HTMLInputElement).value).toBe('src/jump.ts');
  });
});

describe('Chat 工具条:write 展开 DiffPanel + path 按钮;其他工具展开 result', () => {
  /** Chat 直挂连接桩:sessionSnapshot 空快照应答(播种即落定) */
  const chatConn = (): Connection =>
    ({
      sessionSnapshot: vi.fn(() => Promise.resolve({ messages: [], board: emptyBoard(), delegations: [], status: 'idle', lastSeq: 0 } as SnapshotResponse & { lastSeq: number })),
    }) as unknown as Connection;

  /** 挂载 Chat 并等待播种落定(输入启用),返回 sink 转投面(plain ref 对象——非组件内 useRef) */
  async function mountChat(onOpenFile?: (p: string) => void): Promise<MutableRefObject<ChatSink | null>> {
    const sinkRef: MutableRefObject<ChatSink | null> = { current: null } as MutableRefObject<ChatSink | null>;
    render(
      <Chat conn={chatConn()} sessionId="s1" connState="open" onBack={noop} sinkRef={sinkRef} onOpenFile={onOpenFile} />,
    );
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    return sinkRef;
  }

  let ts = 0;
  const ev = (type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent => ({ type, text, payload, ts: ++ts });

  /** write tool-call 帧(batch-runner 实发形态:text=工具名,payload.input={path,content})+result 配对 */
  const writeCall = (path: string, content: string): SessionEvent =>
    ev('tool-call', 'write', { input: { path, content }, callId: 'c1', status: 'pending' });

  it('write 条目:折叠态一行(● write <path> ⎿ result);点击展开 DiffPanel 右列=input.content', async () => {
    const sinkRef = await mountChat();
    act(() => {
      sinkRef.current!.on(writeCall('src/a.ts', '新文件体'), 1);
      sinkRef.current!.on(ev('tool-result', 'written', { tool: 'write', callId: 'c1', status: 'completed' }), 2);
    });
    expect(screen.getByText('● write src/a.ts ⎿ written')).toBeDefined(); // 折叠一行
    expect(document.querySelector('.diff-panel')).toBeNull(); // 未展开无面板
    fireEvent.click(screen.getByRole('button', { name: '● write src/a.ts ⎿ written' }));
    expect(document.querySelector('.diff-panel')).not.toBeNull();
    expect(document.querySelector('.diff-panel .diff-new')?.textContent).toBe('新文件体');
    expect(document.querySelectorAll('.diff-panel .diff-col')).toHaveLength(1); // write 无 pre-image:只右列
  });

  it('write 展开:path 文本按钮 → onOpenFile(path)', async () => {
    const onOpenFile = vi.fn();
    const sinkRef = await mountChat(onOpenFile);
    act(() => {
      sinkRef.current!.on(writeCall('src/b.ts', 'body'), 1);
      sinkRef.current!.on(ev('tool-result', 'written', { tool: 'write', callId: 'c1', status: 'completed' }), 2);
    });
    fireEvent.click(screen.getByRole('button', { name: '● write src/b.ts ⎿ written' }));
    fireEvent.click(screen.getByRole('button', { name: 'src/b.ts' }));
    expect(onOpenFile).toHaveBeenCalledWith('src/b.ts');
  });

  it('非 write 工具(read):展开 result 摘要,无 DiffPanel 无 path 按钮', async () => {
    const onOpenFile = vi.fn();
    const sinkRef = await mountChat(onOpenFile);
    act(() => {
      sinkRef.current!.on(ev('tool-call', 'read', { input: { path: 'src/c.ts' }, callId: 'c2', status: 'pending' }), 1);
      sinkRef.current!.on(ev('tool-result', 'file content here', { tool: 'read', callId: 'c2', status: 'completed' }), 2);
    });
    fireEvent.click(screen.getByRole('button', { name: '● read src/c.ts ⎿ file content here' }));
    expect(screen.getByText('file content here')).toBeDefined(); // 展开示 result 摘要
    expect(document.querySelector('.diff-panel')).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});
