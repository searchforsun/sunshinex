import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { Files } from './pages/Files';
import { DiffPanel } from './diff-panel';
import { Chat } from './pages/Chat';
import { highlightCode } from './highlight';
import { emptyBoard } from './projection';
import type { Connection, DiffResp, FileResp, SnapshotResponse } from './connection';
import type { ChatSink } from './pages/Chat';
import type { MutableRefObject } from 'react';
import type { SessionEvent } from '../../src/types';

/** G10-C3 工具行图标化后的定位器:textContent 含 verb+path 的折叠行(●/⎿ 记号退役) */
function toolRow(text: string): HTMLButtonElement | null {
  const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.tool-summary'));
  return rows.find((r) => r.textContent?.replace(/\s+/g, ' ').includes(text)) ?? null;
}

/**
 * G6 预览+diff 组件测:Files 页（输入 Enter 加载/高亮 class/truncated 横幅/403 错误态/
 * initialPath 自动加载 + G7 请求序守卫）、DiffPanel 双列与单列形态、highlightCode 扩展映射、
 * Chat 工具条 write 展开（DiffPanel 内容 + path 按钮 → onOpenFile）与非 write 展开（result 摘要；
 * G7 起 write 展开接 conn.fetchDiff——双列/404 退单列/gen bump/toolInputs reseed 清）。
 * 连接面以对象桩钉 readFile/sessionSnapshot/fetchDiff 口径（Files/Chat 只消费这三个面）。
 */

const noop = (): void => {};

/** Files 页连接桩:readFile 可编程应答;G10 面(Chat 渲染即拉)零行为桩 */
function connOf(over: Partial<Connection> = {}): Connection {
  return {
    readFile: vi.fn(() => Promise.resolve({ path: '/r/a.ts', content: 'const x = 1;\n' })),
    sessionModel: () => Promise.resolve({ current: undefined, explicitDefault: false, choices: [] }),
    setSessionModel: () => Promise.resolve(),
    setSessionTier: () => Promise.resolve(),
    setSessionEffort: () => Promise.resolve(),
    setSessionMode: () => Promise.resolve(),
    cancelSteer: () => Promise.resolve(),
    rewindSession: () => Promise.resolve(),
    forkSession: () => Promise.resolve({ sessionId: 'forked' }),
    sessionAnchors: () => Promise.resolve([]),
    removeMemory: () => Promise.resolve({ removed: [], failed: [] }),
    runCommand: () => Promise.resolve(),
    commands: () => Promise.resolve({ commands: ['/status', '/compact', '/plan'], descriptions: { status: 's', compact: 'c', plan: 'p' }, supported: ['/status', '/compact'] }),
    ...over,
  } as unknown as Connection;
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

describe('Files 页:输入加载/高亮/横幅/错误态/请求序守卫', () => {
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

  it('G7 请求序守卫:连续加载下慢旧应答不覆写新请求结果(过期应答丢弃)', async () => {
    // 逐次发号的可控应答:两次 readFile 各持一个 resolver,后发先至再旧迟到
    const resolvers: Array<(f: FileResp) => void> = [];
    const conn = connOf({ readFile: vi.fn(() => new Promise<FileResp>((res) => { resolvers.push(res); })) });
    render(<Files conn={conn} sessionId="s1" />);
    fireEvent.change(screen.getByLabelText('file path input'), { target: { value: 'a.unknown' } });
    fireEvent.keyDown(screen.getByLabelText('file path input'), { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('file path input'), { target: { value: 'b.unknown' } });
    fireEvent.keyDown(screen.getByLabelText('file path input'), { key: 'Enter' });
    expect(resolvers).toHaveLength(2);
    // 新请求先应答(unknown 扩展→plaintext 原文透传,断言可读)
    await act(async () => {
      resolvers[1]!({ path: '/r/b.unknown', content: 'BBB-新请求' });
    });
    await waitFor(() => expect(screen.getByLabelText('file content').textContent).toContain('BBB-新请求'));
    // 慢旧应答迟到:序已过期,丢弃——不覆写
    await act(async () => {
      resolvers[0]!({ path: '/r/a.unknown', content: 'AAA-旧请求' });
    });
    expect(screen.getByLabelText('file content').textContent).toContain('BBB-新请求');
    expect(screen.getByLabelText('file content').textContent).not.toContain('AAA-旧请求');
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

describe('Chat 工具条:write 展开 DiffPanel(G7 接 fetchDiff) + path 按钮;其他工具展开 result', () => {
  /** 空快照形态(reseed 断言基线) */
  const emptySnap = (): SnapshotResponse & { lastSeq: number } => ({
    messages: [],
    board: emptyBoard(),
    delegations: [],
    status: 'idle',
    lastSeq: 0,
  });

  /** Chat 直挂连接桩:sessionSnapshot/fetchDiff 可编程(fetchDiff 缺省拒——退单列现内容);G10 面零行为桩 */
  const chatConn = (over: Partial<Connection> = {}): Connection =>
    ({
      sessionSnapshot: vi.fn(() => Promise.resolve(emptySnap())),
      fetchDiff: vi.fn(() => Promise.reject(new Error('/session/s1/diff?callId=c1 -> 404'))),
      sessionModel: () => Promise.resolve({ current: undefined, explicitDefault: false, choices: [] }),
      setSessionModel: () => Promise.resolve(),
      setSessionTier: () => Promise.resolve(),
      setSessionEffort: () => Promise.resolve(),
      setSessionMode: () => Promise.resolve(),
      cancelSteer: () => Promise.resolve(),
      rewindSession: () => Promise.resolve(),
      forkSession: () => Promise.resolve({ sessionId: 'forked' }),
      sessionAnchors: () => Promise.resolve([]),
      removeMemory: () => Promise.resolve({ removed: [], failed: [] }),
      runCommand: () => Promise.resolve(),
      commands: () => Promise.resolve({ commands: ['/status', '/compact'], descriptions: { status: 's', compact: 'c' }, supported: ['/status', '/compact'] }),
      ...over,
    }) as unknown as Connection;

  /** 挂载 Chat 并等待播种落定(输入启用),返回 sink 转投面(plain ref 对象——非组件内 useRef) */
  async function mountChat(opts: { conn?: Connection; onOpenFile?: (p: string) => void; onSeeded?: (s: SnapshotResponse) => void } = {}): Promise<{
    sinkRef: MutableRefObject<ChatSink | null>;
    unmount: () => void;
  }> {
    const sinkRef: MutableRefObject<ChatSink | null> = { current: null } as MutableRefObject<ChatSink | null>;
    const { unmount } = render(
      <Chat conn={opts.conn ?? chatConn()} sessionId="s1" connState="open" onBack={noop} sinkRef={sinkRef} onOpenFile={opts.onOpenFile} onSeeded={opts.onSeeded} />,
    );
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    return { sinkRef, unmount };
  }

  let ts = 0;
  const ev = (type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent => ({ type, text, payload, ts: ++ts });

  /** write tool-call 帧(batch-runner 实发形态:text=工具名,payload.input={path,content})+result 配对 */
  const writeCall = (path: string, content: string): SessionEvent =>
    ev('tool-call', 'write', { input: { path, content }, callId: 'c1', status: 'pending' });

  it('write 条目:折叠态一行(● write <path> ⎿ result);点击展开 DiffPanel 右列=input.content(fetchDiff 404 退单列)', async () => {
    const { sinkRef, unmount } = await mountChat();
    act(() => {
      sinkRef.current!.on(writeCall('src/a.ts', '新文件体'), 1);
      sinkRef.current!.on(ev('tool-result', 'written', { tool: 'write', callId: 'c1', status: 'completed' }), 2);
    });
    expect(toolRow('write src/a.ts')).toBeDefined(); // 折叠一行(图标化,●/⎿ 退役)
    expect(document.querySelector('.diff-panel')).toBeNull(); // 未展开无面板
    fireEvent.click(toolRow('write src/a.ts')!);
    // 加载期先示右列现内容(面板即刻在场),404 应答落定后退单列——形不变
    expect(document.querySelector('.diff-panel')).not.toBeNull();
    expect(document.querySelector('.diff-panel .diff-new')?.textContent).toBe('新文件体');
    await waitFor(() => expect(document.querySelectorAll('.diff-panel .diff-col')).toHaveLength(1)); // 404 退单列(现内容)
    expect(document.querySelector('.diff-panel .diff-new')?.textContent).toBe('新文件体');
    unmount();
  });

  it('G7 write 展开:fetchDiff 成功 → DiffPanel 双列(oldContent/newContent)+ 调用 (sessionId, callId)', async () => {
    const fetchDiff = vi.fn(() =>
      Promise.resolve({ path: '/r/src/a.ts', oldContent: '写前旧文', newContent: '磁盘现文件' } as DiffResp),
    );
    const { sinkRef, unmount } = await mountChat({ conn: chatConn({ fetchDiff }) });
    act(() => {
      sinkRef.current!.on(writeCall('src/a.ts', '调用入参内容'), 1);
      sinkRef.current!.on(ev('tool-result', 'written', { tool: 'write', callId: 'c1', status: 'completed' }), 2);
    });
    fireEvent.click(toolRow('write src/a.ts')!);
    await waitFor(() => expect(fetchDiff).toHaveBeenCalledWith('s1', 'c1'));
    await waitFor(() => {
      const cols = document.querySelectorAll('.diff-panel .diff-col');
      expect(cols).toHaveLength(2); // 双列:左 pre-image 右现文件
      expect(cols[0]!.textContent).toBe('写前旧文');
      expect(cols[1]!.textContent).toBe('磁盘现文件');
    });
    unmount();
  });

  it('write 展开:path 文本按钮 → onOpenFile(path)', async () => {
    const onOpenFile = vi.fn();
    const { sinkRef, unmount } = await mountChat({ onOpenFile });
    act(() => {
      sinkRef.current!.on(writeCall('src/b.ts', 'body'), 1);
      sinkRef.current!.on(ev('tool-result', 'written', { tool: 'write', callId: 'c1', status: 'completed' }), 2);
    });
    fireEvent.click(toolRow('write src/b.ts')!);
    fireEvent.click(screen.getByRole('button', { name: 'src/b.ts' }));
    expect(onOpenFile).toHaveBeenCalledWith('src/b.ts');
    unmount();
  });

  it('非 write 工具(read):展开 result 摘要,无 DiffPanel 无 path 按钮', async () => {
    const onOpenFile = vi.fn();
    const { sinkRef, unmount } = await mountChat({ onOpenFile });
    act(() => {
      sinkRef.current!.on(ev('tool-call', 'read', { input: { path: 'src/c.ts' }, callId: 'c2', status: 'pending' }), 1);
      sinkRef.current!.on(ev('tool-result', 'file content here', { tool: 'read', callId: 'c2', status: 'completed' }), 2);
    });
    fireEvent.click(toolRow('read src/c.ts')!);
    expect(screen.getByText('file content here')).toBeDefined(); // 展开示 result 摘要
    expect(document.querySelector('.diff-panel')).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();
    unmount();
  });

  it('G7 gen bump:unmount(seedGenRef++)后在途快照应答 then 早退——onSeeded 不被陈旧快照再调(backHome→重开防串)', async () => {
    const onSeeded = vi.fn();
    // 第二次 sessionSnapshot(reseed)应答悬挂可控:unmount 后才落定
    let releaseHeld: (s: SnapshotResponse & { lastSeq: number }) => void = () => {};
    const held = new Promise<SnapshotResponse & { lastSeq: number }>((res) => {
      releaseHeld = res;
    });
    let calls = 0;
    const conn = chatConn({ sessionSnapshot: vi.fn(() => (calls++ === 0 ? Promise.resolve(emptySnap()) : held)) });
    const { sinkRef, unmount } = await mountChat({ conn, onSeeded });
    expect(onSeeded).toHaveBeenCalledTimes(1); // 首播种正常回调
    act(() => {
      sinkRef.current!.reset(); // 重连/首连同路径:reseed → 第二次快照在途(held)
    });
    unmount(); // backHome 等价:Chat 卸毁,cleanup 里 seedGenRef.current++
    // 陈旧应答此刻落定:gen 已被 cleanup 抬走 → then 回调早退,onSeeded(污染面)不再被调
    await act(async () => {
      releaseHeld({ ...emptySnap(), messages: [{ seq: 9, ts: 1, kind: 'user', md: '> 陈旧会话内容' }] });
      await Promise.resolve();
    });
    expect(onSeeded).toHaveBeenCalledTimes(1);
  });

  it('G7 toolInputs reseed 清:reseed 后仅 result 帧补投的条目不配旧 input(展开退 result 摘要,无 DiffPanel)', async () => {
    // 第一代:write c9 落暂存(toolInputs[c9]=write input)+配对条目;reseed 后暂存清
    let calls = 0;
    const conn = chatConn({
      sessionSnapshot: vi.fn(() =>
        Promise.resolve(calls++ === 0 ? emptySnap() : { ...emptySnap(), lastSeq: 2 }),
      ),
    });
    const { sinkRef, unmount } = await mountChat({ conn });
    act(() => {
      sinkRef.current!.on(ev('tool-call', 'write', { input: { path: 'src/x.ts', content: '旧代内容' }, callId: 'c9', status: 'pending' }), 1);
      sinkRef.current!.on(ev('tool-result', 'written', { tool: 'write', callId: 'c9', status: 'completed' }), 2);
    });
    expect(toolRow('write src/x.ts')).toBeDefined();
    act(() => {
      sinkRef.current!.reset(); // reseed(第二快照 lastSeq 2):投影 + toolInputs 清
    });
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    // 种子窗后:仅 tool-result(callId c9)补投(seq 5 > lastSeq 2)——result-first 条目(verb …);
    // 若暂存未清,该条目会配上旧代 write input 而错误呈现 write DiffPanel
    act(() => {
      sinkRef.current!.on(ev('tool-result', 'late result line', { tool: 'write', callId: 'c9', status: 'completed' }), 5);
    });
    fireEvent.click(document.querySelector('.tool-summary')!);
    expect(screen.getByText('late result line')).toBeDefined(); // 展开 result 摘要(非 write 面板)
    expect(document.querySelector('.diff-panel')).toBeNull(); // 旧 input 未配对——无 DiffPanel
    unmount();
  });
});
