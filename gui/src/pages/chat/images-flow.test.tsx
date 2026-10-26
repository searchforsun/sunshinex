import { describe, it, expect, vi, beforeEach } from 'vitest';
// mermaid/monaco stub(Chat.test 同款:jsdom 无渲染管线)
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => Promise.resolve({ svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' })),
  },
}));
vi.mock('monaco-editor', () => ({
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
}));
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  Editor: () => <div className="mock-monaco-editor" />,
  DiffEditor: () => <div className="mock-monaco-diff" />,
}));
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Chat } from '../Chat';
import { ImageLightbox } from '../../ImageLightbox';
import { ComposerPlusPanel } from '../../composer/ComposerPlusPanel';
import { ToolEntryView } from './ToolEntry';
import type { ChatEntry } from '../../chat-reducer';
import type { ChatSink } from './chat-types';
import type { Connection } from '../../connection';

/** 图片附件流(2026-10-26):附件区置首(+/文件选择器)→ composer 缩略图条 → 发送随 images 贯穿;
 *  模型不支持拦截;用户气泡缩略图(快照直映)+点击开 lightbox;lightbox 倍数显形与复制/下载动作面 */

const sinkRef = { current: null as ChatSink | null };
const PNG = 'data:image/png;base64,aGVsbG8=';

function connOf(opts?: { supportsImages?: boolean }): Connection {
  return {
    sessionSnapshot: () =>
      Promise.resolve({
        messages: [
          { seq: 1, ts: Date.now(), kind: 'user', md: '看这张图', images: [PNG] },
          { seq: 2, ts: Date.now(), kind: 'assistant', md: '好的' },
        ],
        status: 'idle',
        openRun: -1,
        openSeg: -1,
        board: { tasks: [] },
        delegations: [],
        team: [],
        pending: [],
        lastSeq: 0,
      }),
    sessionSubmit: vi.fn(() => Promise.resolve()),
    sessionSteer: vi.fn(() => Promise.resolve()),
    sessionInterrupt: vi.fn(() => Promise.resolve()),
    deleteSession: () => Promise.resolve(),
    fetchDiff: () => Promise.resolve({ oldContent: '', newContent: '' }),
    replyApproval: () => Promise.resolve(),
    replyAsk: () => Promise.resolve(),
    sessionModel: () =>
      Promise.resolve({
        current: opts?.supportsImages === false ? 'p/text-only' : undefined,
        explicitDefault: false,
        choices: opts?.supportsImages === false ? [{ id: 'p/text-only', model: 'text-only', supportsImages: false }] : [],
      }),
    setSessionModel: vi.fn(() => Promise.resolve()),
    setSessionMode: vi.fn(() => Promise.resolve()),
    cancelSteer: vi.fn(() => Promise.resolve()),
    runCommand: vi.fn(() => Promise.resolve()),
    commands: () => Promise.resolve({ commands: ['/status'], descriptions: { status: 's' }, supported: ['/status'] }),
    skillsGroups: () => Promise.resolve({ groups: [] }),
    tree: () => Promise.resolve({ entries: [] }),
    sessionContext: () => Promise.resolve({ parts: [], chainByAction: [], total: 0, window: 1_000_000, free: 1_000_000 }),
  } as unknown as Connection;
}

async function flushed(): Promise<void> {
  await act(async () => {});
}

/** 造图片文件(jsdom FileReader 直读路径:≤1.5MB 走 dataURL 原样) */
function imgFile(name = 'shot.png'): File {
  return new File(['fake-png-bytes'], name, { type: 'image/png' });
}

beforeEach(() => {
  localStorage.clear();
});

describe('PlusPanel 附件区(置首)', () => {
  it('附件区第一:「Images…」行触发隐藏 input;onChange 承接文件列表', () => {
    const onAttach = vi.fn();
    const conn = {
      commands: () => Promise.resolve({ commands: [], descriptions: {}, supported: [] }),
      skillsGroups: () => Promise.resolve({ groups: [] }),
      tree: () => Promise.resolve({ entries: [] }),
    };
    render(<ComposerPlusPanel conn={conn} onInsert={() => {}} onAttachImages={onAttach} />);
    // 附件区标题在命令区之前(面板第一个 section)
    const secs = document.querySelectorAll('.sx-plus-sec');
    expect(secs[0]!.textContent).toBe('Attach');
    const input = document.querySelector('.sx-plus-file-input') as HTMLInputElement;
    expect(input.accept).toContain('image/png');
    fireEvent.change(input, { target: { files: [imgFile()] } });
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect((onAttach.mock.calls[0]![0] as File[]).length).toBe(1);
    // 未配 onAttachImages(欢迎页可降级):附件区不渲染
    const { container } = render(<ComposerPlusPanel conn={conn} onInsert={() => {}} />);
    expect(container.querySelector('.sx-plus-file-input')).toBeNull();
  });
});

describe('Chat 图片流', () => {
  it('附件选择 → 缩略图条 → 发送:sessionSubmit 收到 images(dataURL),发送即清条', async () => {
    const conn = connOf();
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed();
    fireEvent.click(screen.getByRole('button', { name: 'add attachment' }));
    const input = document.querySelector('.sx-plus-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [imgFile()] } });
    await waitFor(() => expect(document.querySelector('.sx-img-strip img')).not.toBeNull());
    const ta = screen.getByLabelText('message input') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '看图说话' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(conn.sessionSubmit).toHaveBeenCalled());
    expect((conn.sessionSubmit as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toEqual([expect.stringMatching(/^data:image\/png;base64,/)]);
    expect((ta.value === '' || ta.value === '看图说话') && document.querySelector('.sx-img-strip img') === null).toBe(true);
  });

  it('模型声明不支持(supportsImages:false):附件被拦+提示条,发送不带图', async () => {
    const conn = connOf({ supportsImages: false });
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed();
    fireEvent.click(screen.getByRole('button', { name: 'add attachment' }));
    const input = document.querySelector('.sx-plus-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [imgFile()] } });
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(document.querySelector('.sx-img-strip')).toBeNull();
    const ta = screen.getByLabelText('message input') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '纯文本' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(conn.sessionSubmit).toHaveBeenCalled());
    expect((conn.sessionSubmit as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBeUndefined();
  });

  it('编辑卡:预填原条图片(可移除)+重发随行 images;纯图空文亦可发送', async () => {
    const conn = connOf();
    const r1 = render(<Chat conn={conn} sessionId="se1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    // 编辑卡预填原条图片缩略图;移除后发送不带 images
    expect(document.querySelectorAll('.user-edit-card .sx-img-thumb').length).toBe(1);
    fireEvent.click(document.querySelector('.user-edit-card .sx-img-remove')!);
    expect(document.querySelectorAll('.user-edit-card .sx-img-thumb').length).toBe(0);
    const ta = screen.getByLabelText('edit message') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '改后文本' } });
    fireEvent.click(screen.getByRole('button', { name: 'send edit' }));
    await waitFor(() => expect(conn.sessionSubmit).toHaveBeenCalled());
    expect((conn.sessionSubmit as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toBeUndefined();
    r1.unmount();
    // 不移除原样发送 → sessionSubmit 收到原 images
    const conn2 = connOf();
    const r2 = render(<Chat conn={conn2} sessionId="se2" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const ta2 = screen.getByLabelText('edit message') as HTMLTextAreaElement;
    fireEvent.change(ta2, { target: { value: '带图重发' } });
    fireEvent.click(screen.getByRole('button', { name: 'send edit' }));
    await waitFor(() => expect(conn2.sessionSubmit).toHaveBeenCalled());
    expect((conn2.sessionSubmit as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toEqual([PNG]);
    r2.unmount();
    // 纯图空文编辑:文本清空仅留图 → 亦可发送(图片即消息)
    const conn3 = connOf();
    render(<Chat conn={conn3} sessionId="se3" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const ta3 = screen.getByLabelText('edit message') as HTMLTextAreaElement;
    fireEvent.change(ta3, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'send edit' }));
    await waitFor(() => expect(conn3.sessionSubmit).toHaveBeenCalled());
    expect((conn3.sessionSubmit as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]).toBe('');
    expect((conn3.sessionSubmit as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toEqual([PNG]);
  });

  it('图片条独立于气泡外(2026-10-26 用户裁定:图与气泡分离)+点击开 lightbox(倍数显形/复制/下载动作面)', async () => {
    render(<Chat conn={connOf()} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed();
    const entry = document.querySelector('.entry-user')!;
    const strip = entry.querySelector('.user-img-strip')!;
    const bubble = entry.querySelector('.user-bubble')!;
    expect(strip.querySelector('img')).not.toBeNull();
    // 图片条在气泡外且先于气泡渲染(CollapsibleBubble 外层是 user-bubble-wrap);气泡不再含图
    expect(strip.nextElementSibling!.querySelector('.user-bubble')).toBe(bubble);
    expect(bubble.querySelector('.user-img-strip')).toBeNull();
    fireEvent.click(strip.querySelector('img')!);
    const lb = await waitFor(() => document.querySelector('.sx-lightbox')!);
    expect(lb.querySelector('.sx-lightbox-pct')?.textContent).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(lb.querySelector('.sx-lightbox-pct')?.textContent).toBe('125%');
    expect(lb.querySelector('a[aria-label="Download"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.querySelector('.sx-lightbox')).toBeNull();
  });
});

describe('ImageLightbox 单挂(缩放边界与倍数显形)', () => {
  it('放大至 800% 封顶;缩小至 25% 封底;下载锚带原 dataURL', () => {
    render(<ImageLightbox src={PNG} onClose={() => {}} />);
    const pct = (): string => document.querySelector('.sx-lightbox-pct')!.textContent!;
    expect(pct()).toBe('100%');
    for (let i = 0; i < 30; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(pct()).toBe('800%');
    for (let i = 0; i < 40; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(pct()).toBe('25%');
    const dl = document.querySelector('a[aria-label="Download"]') as HTMLAnchorElement;
    expect(dl.getAttribute('href')).toBe(PNG);
  });
});

describe('工具行结果图片(2026-10-26 插件体系图片通道:条目 images → 缩略行+lightbox)', () => {
  const toolEntry = (): ChatEntry => ({
    key: 'k2',
    kind: 'tool',
    md: '',
    name: 'mcp__cu__screenshot',
    images: [PNG],
    result: { text: 'shot', ok: true },
  });

  it('entry.images 非空:折叠行下缩略行直出;点击开 lightbox,关闭即清', async () => {
    render(<ToolEntryView entry={toolEntry()} conn={{} as unknown as Connection} sessionId="s1" />);
    const strip = document.querySelector('.tool-images')!;
    expect(strip.querySelectorAll('img.tool-image-thumb')).toHaveLength(1);
    expect(document.querySelector('.tool-images img')!.getAttribute('src')).toBe(PNG);
    // 点缩略图开浮层;行不展开(tool-body 不 open)——缩略行在折叠壳外直出
    fireEvent.click(document.querySelector('.tool-image-thumb')!);
    expect(await waitFor(() => document.querySelector('.sx-lightbox'))).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.querySelector('.sx-lightbox')).toBeNull();
  });

  it('无图条目不渲染缩略行(回归钉)', () => {
    const e = toolEntry();
    delete e.images;
    render(<ToolEntryView entry={e} conn={{} as unknown as Connection} sessionId="s1" />);
    expect(document.querySelector('.tool-images')).toBeNull();
  });
});
