import { describe, it, expect, vi, beforeEach } from 'vitest';
// mermaid 成功 stub(G14.122 起 zoom 钮受渲染成败门控——成功态才可开 lightbox):
// initialize/render 落定回 svg,走 onStatus(true) 正链
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => Promise.resolve({ svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' })),
  },
}));
// monaco 真渲染需要浏览器布局——jsdom 挂 stub(与 App.test 同款;G14.41 write 行 diff 面板)
vi.mock('monaco-editor', () => ({
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
}));
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  Editor: (props: { value?: string; language?: string }) => (
    <div className="mock-monaco-editor" data-language={props.language}>
      {props.value}
    </div>
  ),
  DiffEditor: (props: { original?: string; modified?: string }) => (
    <div className="mock-monaco-diff" data-original={props.original} data-modified={props.modified} />
  ),
}));
// P1 render-count 计数缝:highlightCode 是 ToolEntry exec 行体内每渲染必调的纯函数
// (ToolEntry.tsx:535 inline JSX),且 highlight.ts 零循环依赖——vi.mock 在此可靠生效。
// 被调用 ⇒ 行函数体真执行;memo 命中(任一层 bail-out)⇒ 计数不增。
// (不 mock ToolEntry 本身:ToolEntry→Chat→MessageList→ToolEntry 循环依赖使该 mock 静默失效)
vi.mock('../highlight', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../highlight')>();
  let calls = 0;
  return {
    ...mod,
    highlightCode: (code: string, filename?: string): string => {
      calls += 1;
      return mod.highlightCode(code, filename);
    },
    __calls: (): number => calls,
    __reset: (): void => { calls = 0; },
  };
});
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setLanguage } from '../../src/i18n';
import * as highlightMock from '../highlight';
import { Chat, expandFileRefs, rankFileHits, renderMentionSpans, tokenDeleteRange } from './Chat';
import type { ReactElement, ReactNode } from 'react';
import { mermaidCacheClear } from '../Mermaid';
import type { ChatSink } from './Chat';
import type { Connection } from '../connection';
import type { SessionEvent } from '../../../src/types';

/** P1 计数缝访问器:mock 工厂返回的 __calls/__reset 不在真实模块类型上,运行时经命名空间取 */
const hlCounters = highlightMock as unknown as { __calls(): number; __reset(): void };

/** G9-B3b 会话流 Codex 形:用户右胶囊(+hover 复制)/跨日居中日期分隔(DOM 契约:
 *  .entry-user>.user-bubble+.user-actions>.user-action[aria-label=Copy];.chat-day-sep[role=separator]) */

const sinkRef = { current: null as ChatSink | null };
const DAY1 = new Date(2026, 0, 10, 10).getTime();
const DAY2 = new Date(2026, 0, 11, 10).getTime();

type Seed = { seq: number; ts?: number; kind: 'user' | 'assistant'; md: string };

function connOf(messages: Seed[], status: 'idle' | 'running' = 'idle'): Connection {
  return {
    sessionSnapshot: () =>
      // P10:status 读内核游标——running 快照带 openRun 指向首条(视图 status 派生自游标)
      Promise.resolve({ messages, status, openRun: status === 'running' ? (messages[0]?.seq ?? 1) : -1, openSeg: -1, board: { tasks: [] }, delegations: [], team: [], pending: [], lastSeq: 0 }),
    sessionSubmit: () => Promise.resolve(),
    sessionSteer: () => Promise.resolve(),
    sessionInterrupt: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    fetchDiff: () => Promise.resolve({ oldContent: '', newContent: '' }),
    replyApproval: () => Promise.resolve(),
    replyAsk: () => Promise.resolve(),
    sessionModel: () => Promise.resolve({ current: undefined, explicitDefault: false, choices: [] }),
    setSessionModel: vi.fn(() => Promise.resolve()),
    setSessionMode: vi.fn(() => Promise.resolve()),
    cancelSteer: vi.fn(() => Promise.resolve()),
    runCommand: vi.fn(() => Promise.resolve()),
    commands: () => Promise.resolve({ commands: ['/status', '/compact', '/plan'], descriptions: { status: 's', compact: 'c', plan: 'p' }, supported: ['/status', '/compact'] }),
    sessionContext: () => Promise.resolve({ parts: [{ id: 'stable', tokens: 429, count: 1 }, { id: 'chain', tokens: 26, count: 3 }], chainByAction: [], total: 6577, window: 1_000_000, free: 993_423 }),
  } as unknown as Connection;
}

function mountChat(messages: Seed[]): void {
  render(<Chat conn={connOf(messages)} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
}

/** 播种落定:冲微任务使 sessionSnapshot 应答处理完毕(seeding 门开,后继 fire 直投 reducer) */
async function flushed(): Promise<void> {
  await act(async () => {});
}
/** 投递本会话帧(seq 恒 1——页面不过滤 seq,连接层职责) */
function fire(e: SessionEvent): void {
  act(() => sinkRef.current!.on(e, 1));
}

/** G14.215 ghost 落定:归并渐收行的卸载定时器在 act 内耗散,后续断言不见 ghost 残留(动画窗 420ms+余量) */
async function ghostsSettled(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 520));
  });
}

describe('Chat 会话流 Codex 形(B3b)', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
  });

  it('用户条目渲染右胶囊:entry-user 容器 + user-bubble 气泡 + 复制钮', async () => {
    mountChat([{ seq: 1, ts: DAY1, kind: 'user', md: '你好' }]);
    expect((await screen.findAllByText('你好'))[0]).toBeTruthy(); // 标题回落同文——取首个(气泡)
    const entry = document.querySelector('.entry-user')!;
    expect(entry).toBeTruthy();
    expect(entry.querySelector('.user-bubble')).toBeTruthy();
    expect(entry.querySelector('button[aria-label="Copy"]')).toBeTruthy();
  });

  it('G14.156 tokenDeleteRange:token 内 Backspace/Delete 整删区间判定,明文不命中', () => {
    const text = '看一下 @src/a.ts:L30-L35 和 /plan 以及 @b';
    // 区间核算:@token=4..21,空格 21..24,/plan=24..29
    expect(tokenDeleteRange(text, 21, 'Backspace')).toEqual([4, 21]);   // 末位整删
    expect(tokenDeleteRange(text, 10, 'Backspace')).toEqual([4, 21]);   // 中间也整删
    expect(tokenDeleteRange(text, 4, 'Delete')).toEqual([4, 21]);       // 首位 Delete 整删
    expect(tokenDeleteRange(text, 2, 'Backspace')).toBeNull();          // 明文不命中
    expect(tokenDeleteRange(text, 26, 'Backspace')).toEqual([24, 29]);  // /plan 命令 token 同整删
    expect(tokenDeleteRange(text, 0, 'Delete')).toBeNull();             // 首位 Delete 无 token
  });

  it('G14.129 expandFileRefs:@相对路径 → [文件名](./相对) 标准格式;@文件名 经 resolve 解析,解析不到原样', () => {
    expect(expandFileRefs('看 @src/a.ts 和 @b', 'D:/ws/demo')).toBe('看 [a.ts](./src/a.ts) 和 @b');
    expect(expandFileRefs('看 @a.ts', 'D:/ws/demo', (n) => (n === 'a.ts' ? 'src/a.ts' : undefined))).toBe(
      '看 [a.ts](./src/a.ts)',
    ); // 选中记账/索引兜底解析
    expect(expandFileRefs('看 @missing.ts', 'D:/ws/demo', () => undefined)).toBe('看 @missing.ts');
    expect(expandFileRefs('无 root @src/a.ts 保持', undefined)).toBe('无 root @src/a.ts 保持');
    expect(expandFileRefs('看 @src/a.ts:L30-L35', 'D:/ws/demo')).toBe(
      '看 [a.ts L30-L35](./src/a.ts#L30-L35)',
    ); // G14.139 行锚:链接文本带行号,目标带 #L 锚
    expect(expandFileRefs('default @src/a.ts 保持', 'default')).toBe('default @src/a.ts 保持');
  });

  it('目录引用展开:@src/ 尾斜杠标记 → href 保尾斜杠(黄目录渲染/Files 目录移交);resolve 命中带尾斜杠目录项同效', () => {
    // 全相对路径 + 尾斜杠(拖目录/面板选目录的直写形态)
    expect(expandFileRefs('看 @gui/src/ 结构', 'D:/ws/demo')).toBe('看 [src](./gui/src/) 结构');
    // 短写 @src/:经 resolve(选中记账/索引目录项)解析——解析不到原样保留(与文件短写同口径)
    expect(expandFileRefs('看 @src/ 结构', 'D:/ws/demo', (n) => (n === 'src' ? 'gui/src/' : undefined))).toBe(
      '看 [src](./gui/src/) 结构',
    );
    expect(expandFileRefs('看 @missing/ 保持', 'D:/ws/demo', () => undefined)).toBe('看 @missing/ 保持');
    // 文件引用行为不变(回归锚:无尾斜杠即原样文件链接)
    expect(expandFileRefs('看 @src/a.ts', 'D:/ws/demo')).toBe('看 [a.ts](./src/a.ts)');
    // 手打无斜杠短写,resolve 命中带标记目录项(尾斜杠内部标记)——同样目录 href(显示/插入无斜杠)
    expect(expandFileRefs('看 @src 结构', 'D:/ws/demo', (n) => (n === 'src' ? 'gui/src/' : undefined))).toBe(
      '看 [src](./gui/src/) 结构',
    );
  });

  it('高亮层目录芯片:@短写经 lookup 命中带标记目录项 → FileIcon folder=true(黄目录);未命中按文件', () => {
    // 芯片结构:span.hn-file → children[0]=span.hn-file-ico → children=FileIcon 元素
    const folderOf = (node: ReactNode): boolean | undefined => {
      const hn = (node as ReactElement[]).find((el) => String(el?.props?.className ?? '').includes('hn-file')) as ReactElement;
      const icoWrap = (hn.props.children as ReactElement[])[0] as ReactElement;
      return ((icoWrap.props.children as ReactElement).props as { folder?: boolean }).folder;
    };
    expect(folderOf(renderMentionSpans('@src', (n) => (n === 'src' ? 'gui/src/' : undefined)))).toBe(true);
    expect(folderOf(renderMentionSpans('@a.ts'))).toBeUndefined();
  });

  it('G14.2xx rankFileHits:精确 basename 置顶 > 前缀 > 包含 > 子序列,同级保原序;cap 排序后再截', () => {
    // 用户实测回归锚:输 @harness 时 src/harness/ 必须置顶(回车即中),不得被
    // src/harness/tools/ 等远缘子序列命中挤出首屏
    const files = ['src/harness/context/x.ts', 'src/harness/tools/', 'src/harness/', 'src/tharness.ts', 'src/harness.ts'];
    expect(rankFileHits(files, 'harness')).toEqual([
      'src/harness/', // 精确 basename(目录尾斜杠剥后判)
      'src/harness.ts', // 前缀
      'src/tharness.ts', // basename 包含
      'src/harness/context/x.ts', // 子序列,同级保原序
      'src/harness/tools/',
    ]);
    // cap 在排序后截断:精确项不会被先到的远缘命中挤出面板
    expect(rankFileHits(['aaa/', 'aaa/b1', 'aaa/b2', 'zzz', 'zzz2'], 'aaa').slice(0, 2)).toEqual(['aaa/', 'aaa/b1']);
    // 空查询:原序前 cap
    expect(rankFileHits(['b', 'a'], '')).toEqual(['b', 'a']);
  });

  it('G14.124 md 原生超链接 → 文件引用渲染(icon+文件名),点击开侧栏;web 链接原样 <a>', async () => {
    const onOpenFile = vi.fn();
    render(
      <Chat
        conn={connOf([{ seq: 1, ts: DAY1, kind: 'assistant', md: '改 [DiffTab.tsx](gui/src/tabs/DiffTab.tsx) 与 [官网](https://example.com)' }])}
        sessionId="s1"
        connState="open"
        onBack={() => {}}
        sinkRef={sinkRef}
        onOpenFile={onOpenFile}
      />,
    );
    const link = await screen.findByRole('button', { name: 'DiffTab.tsx' });
    expect(link.className).toContain('file-link');
    expect(link.getAttribute('data-tip')).toBe('gui/src/tabs/DiffTab.tsx');
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith('gui/src/tabs/DiffTab.tsx');
    const web = screen.getByText('官网').closest('a');
    expect(web?.getAttribute('href')).toBe('https://example.com'); // web 链接不受影响
  });

  it('G14.124 气泡 md 链接(引用回显形态):file href 渲染为可点文件引用', async () => {
    const onOpenFile = vi.fn();
    render(
      <Chat
        conn={connOf([{ seq: 1, ts: DAY1, kind: 'user', md: '再看一下 [steer-verify.txt](C:/Users/x/sunshinex-default/steer-verify.txt)' }])}
        sessionId="s1"
        connState="open"
        onBack={() => {}}
        sinkRef={sinkRef}
        onOpenFile={onOpenFile}
      />,
    );
    const link = await screen.findByRole('button', { name: 'steer-verify.txt' });
    expect(link.className).toContain('file-link');
    expect(link.getAttribute('data-tip')).toBe('C:/Users/x/sunshinex-default/steer-verify.txt');
  });

  it('G14.125 气泡非标引用不做文件渲染:@token 退通用 code chip,只认标准 md 链接(G14.124)', async () => {
    const onOpenFile = vi.fn();
    render(
      <Chat
        conn={connOf([{ seq: 1, ts: DAY1, kind: 'user', md: '看一下 @changes-bar-probe.md 就好 /plan 别的' }])}
        sessionId="s1"
        connState="open"
        onBack={() => {}}
        sinkRef={sinkRef}
        onOpenFile={onOpenFile}
      />,
    );
    await screen.findAllByText(/changes-bar-probe\.md/); // 气泡 chip+标题回落同文(取在场即可)
    expect(document.querySelector('.user-bubble .file-link')).toBeNull(); // 无专属文件渲染
    expect(document.querySelectorAll('.user-bubble code').length).toBeGreaterThanOrEqual(2); // @token 与 /plan 均通用 chip
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('复制钮写入剪贴板(剥 > 前缀),成功示「已复制」', async () => {
    mountChat([{ seq: 1, ts: DAY1, kind: 'user', md: '你好' }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('你好');
    await waitFor(() => expect(document.querySelector('.entry-user .user-actions .sx-tip')?.getAttribute('data-tip')).toBe('Copied'));
  });

  it('跨日条目间渲染一条居中日期分隔;同日不渲染', async () => {
    const { unmount } = render(
      <Chat
        conn={connOf([
          { seq: 1, ts: DAY1, kind: 'user', md: 'a' },
          { seq: 2, ts: DAY2, kind: 'assistant', md: 'b' },
        ])}
        sessionId="s1"
        connState="open"
        onBack={() => {}}
        sinkRef={sinkRef}
      />,
    );
    // Codex 形:每个日组顶部一条(首组亦有)——两日两条
    const seps = await screen.findAllByRole('separator');
    expect(seps).toHaveLength(2);
    expect(seps.every((el) => el.classList.contains('chat-day-sep'))).toBe(true);
    unmount();
    mountChat([
      { seq: 1, ts: DAY1, kind: 'user', md: 'a' },
      { seq: 2, ts: DAY1, kind: 'assistant', md: 'b' },
    ]);
    await screen.findByText('b');
    expect(document.querySelectorAll('.chat-day-sep')).toHaveLength(1);
  });
});

describe('mermaid 围栏(G10-C3c)', () => {
  beforeEach(() => mermaidCacheClear()); // G14.2xx 渲染缓存是模块态——清空以复现 pending/现渲路径
  it('加载失败回落原文代码块(降级纪律,会话流零阻塞)', async () => {
    mountChat([{ seq: 2, ts: DAY1, kind: 'assistant', md: '图:\n\n```mermaid\ngraph TD; A-->B\n```' }]);
    expect(await screen.findByText(/graph TD; A-->B/, {}, { timeout: 5_000 })).toBeTruthy();
  });
});

describe('MermaidBlock(G11 §5.4)', () => {
  beforeEach(() => {
    mermaidCacheClear(); // G14.2xx 同上:前用例已缓存同源图,清空保 pending 路径
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
  });

  it('容器带放大/复制钮;放大开 lightbox,Esc 关闭;G14.117 +−之间百分比显形联动,方框钮复位;G14.122 浮层=克隆 SVG', async () => {    mountChat([{ seq: 2, ts: DAY1, kind: 'assistant', md: ['图:', '', '```mermaid', 'graph TD; A-->B', '```'].join('\n') }]);
    await screen.findByText(/graph TD; A-->/, {}, { timeout: 5_000 });
    await waitFor(() => expect(document.querySelector('.mermaid-svg svg')).not.toBeNull()); // G14.2xx 防抖后等渲染落地
    await waitFor(() => expect(screen.getByRole('button', { name: 'zoom mermaid' })).toBeDefined()); // 渲染成功才在场
    fireEvent.click(screen.getByRole('button', { name: 'zoom mermaid' }));
    expect(document.querySelector('.mermaid-lightbox')).not.toBeNull();
    expect(document.querySelector('.mermaid-lb-pan svg')).not.toBeNull(); // 克隆 SVG 在浮层
    expect(document.querySelector('.mermaid-lb-zoom')?.textContent).toBe('100%'); // 缺省 100%
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(document.querySelector('.mermaid-lb-zoom')?.textContent).toBe('120%'); // 步进联动
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(document.querySelector('.mermaid-lb-zoom')?.textContent).toBe('100%'); // 方框钮复位
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.mermaid-lightbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'copy mermaid' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('graph TD; A-->B');
  });
});

describe('composer pills 与排队 chips(G10-C4)', () => {
  it('权限 pill 四项菜单:plan 置顶可选(置灰解除,task 10——arm 语义:批准落工作区编辑,拒绝保持)+分隔线+三权限档;切计划/工作区编辑调 setSessionMode', async () => {
    const setSessionMode = vi.fn(() => Promise.resolve());
    const conn = connOf([{ seq: 1, ts: DAY1, kind: 'user', md: 'a' }]);
    (conn as unknown as Record<string, unknown>).setSessionMode = setSessionMode;
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    fireEvent.click(await screen.findByRole('button', { name: 'session mode' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(4); // 四项两段:plan + sep + 只读/工作区编辑/完全访问
    expect(document.querySelector('.mode-pop .mode-pop-sep')).not.toBeNull(); // 分组线沿既有样式类
    const plan = screen.getByRole('menuitem', { name: /Plan mode|计划模式/ });
    expect(plan.getAttribute('aria-disabled')).toBeNull(); // 置灰解除(阶段三 plan-arm 接通,spec §5.2)
    expect(plan.textContent).toMatch(/Plan first, execute on approval|先规划，批准后执行/); // desc 正式文案(「即将可用」退役)
    fireEvent.click(plan);
    expect(setSessionMode).toHaveBeenCalledWith('s1', 'plan'); // 单选即派发(批准后 daemon 落 acceptEdits 快照回填)
    fireEvent.click(screen.getByRole('button', { name: 'session mode' })); // 选中收口后重开菜单(旧置灰态点击不收口,故旧锚无需此步)
    fireEvent.click(screen.getByRole('menuitem', { name: /Workspace edits|工作区编辑/ })); // G14.98 双行(名称+解释)→可访问名含解释,正则匹配
    expect(setSessionMode).toHaveBeenCalledWith('s1', 'acceptEdits');
  });

  it('plan-approval 挂起:快照 pending 段重建计划确认卡(reseed 复现沿 approval 卡先例),批准回执 replyPlanApproval({approved:true}) 并移卡', async () => {
    const replyPlanApproval = vi.fn(() => Promise.resolve());
    const conn = connOf([]);
    (conn as unknown as Record<string, unknown>).replyPlanApproval = replyPlanApproval;
    (conn as unknown as Record<string, unknown>).sessionSnapshot = () =>
      Promise.resolve({
        messages: [],
        status: 'running',
        board: { tasks: [] },
        delegations: [],
        team: [],
        pending: [{ pid: 'p-plan-1', kind: 'plan-approval', req: { doc: '# 计划书', items: ['第一步', '第二步'] } }],
        lastSeq: 0,
      });
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    expect(await screen.findByText(/Plan approval|计划确认/)).toBeTruthy(); // 卡复现(快照挂起段重建)
    expect(screen.getByRole('heading', { level: 1, name: '计划书' })).toBeTruthy(); // 计划书 markdown 渲染
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['第一步', '第二步']); // 步骤只读清单
    fireEvent.click(screen.getByText(/Approve|批准/));
    await waitFor(() => expect(replyPlanApproval).toHaveBeenCalledWith('p-plan-1', { approved: true })); // 决策体走 plan-approval 通道
    await waitFor(() => expect(screen.queryByText(/Plan approval|计划确认/)).toBeNull()); // 回执落定移卡(dock 还 composer)
  });

  it('排队 chips:snapshot.queued 回显渲染,撤回钮调 cancelSteer(seq)', async () => {
    const cancelSteer = vi.fn(() => Promise.resolve());
    const conn = connOf([]);
    (conn as unknown as Record<string, unknown>).cancelSteer = cancelSteer;
    (conn as unknown as Record<string, unknown>).sessionSnapshot = () =>
      Promise.resolve({
        messages: [],
        status: 'running',
        board: { tasks: [] },
        delegations: [],
        team: [],
        pending: [],
        lastSeq: 0,
        queued: [
          { seq: 0, text: '排队一' },
          { seq: 1, text: '排队二' },
        ],
      });
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    expect(await screen.findByText('排队一')).toBeTruthy();
    expect(screen.getByText('排队二')).toBeTruthy();
    // G14.83:删除钮(垃圾桶)撤回队列条目
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    expect(cancelSteer).toHaveBeenCalledWith('s1', 0);
  });

  it('P5 queue 帧:变更帧实时回显 chips(替代轮询);不入转录投影(零条目);内联编辑钮调 editSteer(seq,text)', async () => {
    const editSteer = vi.fn(() => Promise.resolve());
    const conn = connOf([]);
    (conn as unknown as Record<string, unknown>).editSteer = editSteer;
    (conn as unknown as Record<string, unknown>).sessionSnapshot = () =>
      Promise.resolve({ messages: [], status: 'running', board: { tasks: [] }, delegations: [], team: [], pending: [], lastSeq: 0, queued: [{ seq: 0, text: '排队一' }] });
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed();
    expect(screen.getByText('排队一')).toBeTruthy();
    // queue 帧:全量列表权威回显(替换快照态)
    fire({ type: 'queue', ts: Date.now(), payload: { items: [{ seq: 0, text: '排队一改', front: false }, { seq: 1, text: '新条', front: false }] } });
    expect(await screen.findByText('排队一改')).toBeTruthy();
    expect(screen.getByText('新条')).toBeTruthy();
    expect(document.querySelector('.steer-fold')?.textContent).toContain('2');
    // 队列帧不进转录(零条目)
    expect(document.querySelectorAll('.entry-user, .entry-notice').length).toBe(0);
    // 内联编辑:Pencil 钮 → 行变输入框 → 改文回车 → editSteer(seq,text)
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit inline' })[0]);
    const input = screen.getByLabelText('Edit queued message') as HTMLInputElement;
    expect(input.value).toBe('排队一改');
    fireEvent.change(input, { target: { value: '改后文本' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(editSteer).toHaveBeenCalledWith('s1', 0, '改后文本');
  });

  it('P4.1 种子 tool 条:entry 字段直映——折叠行带目标(读取+路径),不再退裸 md', async () => {
    const seed = {
      seq: 1, ts: DAY1, kind: 'tool', md: '',
      callId: 'c1', name: 'read', input: { path: 'docs/Arch-Plan.md' },
      result: { text: '{\n  "k": 1\n}\n', ok: true },
    } as unknown as Seed;
    mountChat([seed]);
    await flushed();
    const row = document.querySelector('.tool-summary')?.textContent ?? '';
    expect(row).toContain('read'); // 折叠行动词(en 测试位;zh=读取)
    expect(row).toContain('Arch-Plan.md'); // 目标路径(P11 字段单源:entry.input 直映,md 记号不回归)
  });

  it('P11 种子条三态渲染:running 单条即成组(头流光计数+成员行路径同行),done 折叠行=动词+路径(字段单源)', async () => {
    const base = { seq: 1, ts: DAY1, kind: 'tool', md: '', callId: 'c1', name: 'read', input: { path: 'docs/Arch-Plan.md' } };
    const first = render(<Chat conn={connOf([{ ...base, status: 'running' } as unknown as Seed])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed();
    // 运行中 1 条即成组(2026-10-22 裁定):头=流光计数,成员行=流光标签+路径同行
    const head = document.querySelector('.tool-group-head')!;
    expect(head.querySelector('.exec-running-text')?.textContent).toContain('Queried files ×1');
    const member = document.querySelector('.tool-group-members .tool-summary')!;
    expect(member.textContent).toContain('Reading file');
    expect(member.textContent).toContain('Arch-Plan.md');
    first.unmount();
    // done 终态(status 缺省=终态):折叠行=动词+路径——executing 读 status(非 md 占位判定),
    // 字段单源(md 退役后旧占位判定恒执行中,此断言钉死直映)
    mountChat([{ ...base, result: { text: 'ok', ok: true } } as unknown as Seed]);
    await flushed();
    const row = document.querySelector('.tool-summary')?.textContent ?? '';
    expect(row).not.toContain('Reading file'); // 不再恒执行中
    expect(row).toContain('read'); // 动词(entry.name 直映)
    expect(row).toContain('Arch-Plan.md'); // 路径(entry.input 直映)
  });
});

describe('run 状态行(G11 §1)', () => {
  it('model-start 后 .entry-run.live 显示 Working;done 封段后 .entry-run.sealed 显示 Worked for', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    expect(document.querySelector('.entry-run.live')?.textContent).toContain('Working');
    fire({ type: 'token', text: '答', ts: Date.now() });
    fire({ type: 'done', text: '答', ts: Date.now() + 34_000 });
    expect(document.querySelector('.entry-run.sealed')?.textContent).toContain('Worked for 34s');
  });

  it('live 行只示时长(G14.11:tokens 迁工具行尾)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'usage', payload: { turnTotal: 8400 }, ts: Date.now() });
    const live = document.querySelector('.entry-run.live')?.textContent ?? '';
    expect(live).not.toContain('tokens'); // tokens 不在状态行
    expect(live).not.toContain('8.4k');
  });
});


  it('read 执行中:流光「正在读取」+路径同行(用户裁定);结果回后回落 名称+目录', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'read', ts: Date.now(), payload: { callId: 'cr', input: { path: 'src/a.ts' } } });
    let row = document.querySelector('.tool-summary')!;
    expect(row.textContent).toMatch(/Reading file|正在读取/);
    expect(row.querySelector('.exec-ripple-icon')).toBeNull(); // G14.88 纯流光文字(图标+波纹退役)
    expect(row.textContent).toContain('src/'); // 路径同行可见(2026-10-22 用户裁定)
    fire({ type: 'tool-result', text: 'content', ts: Date.now(), payload: { callId: 'cr' } });
    row = document.querySelector('.tool-summary')!;
    expect(row.textContent).toContain('a.ts src/'); // 完成后回落 名称+目录
  });

describe('工具行展开分型(G14:exec=$ 命令+输出,无 Input/Output 分节标)', () => {
  it('exec 展开:$ 命令行(highlight)+输出全文(entry.result 全文直映)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'c1', input: { command: 'ls -la' } } });
    fire({ type: 'tool-result', text: 'file1\nfile2', ts: Date.now(), payload: { callId: 'c1' } });
    fireEvent.click(document.querySelector('.tool-summary')!);
    const exec = document.querySelector('.tool-exec');
    expect(exec).not.toBeNull();
    // G14.50:命令+输出同块(pre.tool-io-pre 单区;$ 行 bash 高亮)
    expect(exec?.querySelector('.tool-io-pre .exec-prompt')?.textContent).toContain('$');
    expect(exec?.querySelector('.tool-io-pre code')?.innerHTML).toContain('hljs'); // bash 高亮在场
    expect(exec?.querySelector('.tool-io-pre')?.textContent).toContain('ls -la');
    expect(exec?.querySelector('.tool-io-pre')?.textContent).toContain('file2');
  });

  it('result 先到 call 后到(乱序)同样配对全文(read 分型折叠行点开=文件,展开面经 .tool-body)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-result', text: 'out1\nout2', ts: Date.now(), payload: { callId: 'c9' } });
    fire({ type: 'tool-call', text: 'glob', ts: Date.now(), payload: { callId: 'c9', input: { pattern: '**/*' } } });
    fireEvent.click(document.querySelector('.tool-summary')!);
    expect(document.querySelector('.tool-io-pre')?.textContent).toContain('out2');
  });
});

describe('思考行(G11 §3)', () => {
  it('折叠预览示末个非空行;展开有 open 类与内滚容器', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'reasoning', text: '第一行\n第二行', ts: Date.now() });
    expect(document.querySelector('.thinking-preview')).toBeNull(); // G14.24:末行预览退役
    expect(document.querySelector('.think-body')).not.toBeNull();
    fireEvent.click(document.querySelector('.thinking-summary')!);
    expect(document.querySelector('.entry-thinking.open')).not.toBeNull();
    expect(document.querySelector('.thinking-scroll')).not.toBeNull();
    expect(document.querySelector('.thinking-detail')?.textContent).toContain('第一行');
  });

  it('Brain 图标在场', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'reasoning', text: '想', ts: Date.now() });
    expect(document.querySelector('.entry-thinking .thinking-summary svg')).not.toBeNull();
  });
});

describe('系统行图标(G11 §4)', () => {
  it('notice 通用=Info/agent 消息=MessageSquare,error=AlertCircle——均 .entry-icon 前置;delegation 状态行零渲染(G14.213)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'notice', text: 'hello', ts: Date.now() });
    expect(document.querySelector('.entry-notice .entry-icon svg')).not.toBeNull();
    expect(document.querySelector('.entry-notice')?.textContent).toContain('hello');
    fire({ type: 'delegation-started', payload: { label: 'dev', delegationId: 'd1' }, ts: Date.now() });
    expect(document.querySelectorAll('.entry-notice .entry-icon').length).toBe(1); // 委派状态行不入主流
    fire({ type: 'agent-message', payload: { from: 'boss', to: 'dev', text: 'hi' }, ts: Date.now() });
    expect(document.querySelectorAll('.entry-notice .entry-icon').length).toBe(2);
    fire({ type: 'error', text: 'boom', ts: Date.now() });
    expect(document.querySelector('.entry-error .entry-icon svg')).not.toBeNull();
  });
});

describe('代码块 CodeBlock(G11 §5.2)', () => {
  it('围栏代码卡:语言标+hljs 高亮+复制写剪贴板', async () => {
    mountChat([{ seq: 1, ts: DAY1, kind: 'assistant', md: ['```ts', 'const a = 1;', '```'].join('\n') }]);
    await waitFor(() => expect(document.querySelector('.code-block')).not.toBeNull());
    expect(document.querySelector('.code-lang')?.textContent).toBe('ts');
    expect(document.querySelector('.code-block code .hljs-keyword')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'copy code' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const a = 1;');
  });
});

describe('表格容器(G11 §5.3)', () => {
  it('md 表格包进 .table-wrap 横滚容器', async () => {
    const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    mountChat([{ seq: 1, ts: DAY1, kind: 'assistant', md }]);
    await waitFor(() => expect(document.querySelector('.table-wrap table')).not.toBeNull());
  });
});

describe('run 尾部操作条(G11 §6)', () => {
  it('末条正文下挂条:复制/fork 钮与 steps/tokens/时间', async () => {
    const onFork = vi.fn();
    render(<Chat conn={connOf([])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} onFork={onFork} />);
    await flushed();
    const now = Date.now();
    fire({ type: 'model-start', ts: now });
    fire({ type: 'token', text: '答', ts: now });
    fire({ type: 'done', text: '答', ts: now, payload: { steps: 12, tokensUsed: 8400 } });
    const footer = document.querySelector('.run-footer');
    expect(footer?.textContent).toContain('12 steps');
    expect(footer?.textContent).toContain('8.4k tokens');
    fireEvent.click(screen.getByRole('button', { name: 'fork session' }));
    expect(onFork).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'copy reply' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('答');
  });

  it('run 仍在跑(流尾 streaming)不挂条', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'token', text: '写一半', ts: Date.now() });
    expect(document.querySelector('.run-footer')).toBeNull();
  });
});

describe('用户气泡编辑卡(G11 §7)', () => {
  it('编辑:预填原文;发送=新消息(sessionSubmit+新回显条);Esc 取消回气泡', async () => {
    const sessionSubmit = vi.fn(() => Promise.resolve());
    const conn = connOf([{ seq: 1, ts: DAY1, kind: 'user', md: '你好' }]);
    (conn as unknown as Record<string, unknown>).sessionSubmit = sessionSubmit;
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await screen.findAllByText('你好'); // 标题回落同文——取首个
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'edit message' }) as HTMLTextAreaElement;
    expect(box.value).toBe('你好');
    fireEvent.change(box, { target: { value: '你好,再来一次' } });
    fireEvent.click(screen.getByRole('button', { name: 'send edit' }));
    expect(sessionSubmit).toHaveBeenCalledWith('s1', '你好,再来一次');
    await screen.findAllByText('你好,再来一次');
    // 发送后流内已有两条 user 气泡(原条+新回显条),各带 Edit 钮——getByRole 多元素会抛,取首条
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'edit message' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'edit message' })).toBeNull();
  });
});

describe('exec 执行中/完成双态(G14.13)', () => {
  it('执行中(result 未回):流光文字「正在执行」+命令同行(2026-10-22 用户裁定)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'cx', input: { command: 'npm test' } } });
    const row = document.querySelector('.tool-summary')!;
    expect(row.textContent).toMatch(/Running|正在执行/); // 双语(测试默认 en)
    expect(row.querySelector('.exec-ripple-icon')).toBeNull(); // G14.88 图标+波纹退役
    expect(row.textContent).toContain('npm test'); // 命令同行可见(用户裁定)
  });

  it('完成后:exec+完整命令(可点展开 $ 命令+输出)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'cx', input: { command: 'npm test' } } });
    fire({ type: 'tool-result', text: '3 tests passed', ts: Date.now(), payload: { callId: 'cx' } });
    const row = document.querySelector('.tool-summary')!;
    expect(row.textContent).toContain('exec');
    expect(row.textContent).toContain('npm test');
    expect(row.querySelector('.exec-ripple-icon')).toBeNull(); // 波纹退场
  });
});

describe('G14.18 上下文圆环', () => {
  it('模型 pill 左侧渲染圆环;hover 弹层示上下文占用/轮次步数/tokens/缓存命中', async () => {
    mountChat([]);
    await flushed();
    const ring = document.querySelector('.ctx-ring')!;
    expect(ring).not.toBeNull();
    // 挂载即拉 sessionContext:bar 命中率面 = total/window
    await waitFor(() => {
      expect(ring.querySelector('.ctx-ring-bar')!.getAttribute('stroke-dasharray')).not.toBe('0 43.982300884955774');
    });
    fireEvent.mouseEnter(ring);
    const pop = document.querySelector('.ctx-pop')!;
    // G14.77 k/m 单位化;G14.97 百分比一位小数+分区横线;构成含具体 token
    expect(pop.textContent).toContain('6.6k / 1m · 0.7%');
    expect(pop.textContent).toContain('429 · 6.5%'); // 构成项=token 数+百分比并存
    expect(pop.querySelectorAll('.ctx-pop-sep').length).toBe(2); // 上下文/轮次/缓存三分区
    expect(pop.textContent).toContain('Turns / Steps');
    expect(pop.textContent).toContain('System');
    expect(pop.textContent).toContain('%'); // 细项相对占比
    expect(pop.textContent).toContain('Chain');
    expect(pop.textContent).toContain('· 3'); // 条数缀
    expect(pop.textContent).toMatch(/缓存命中率|Cache hit rate/);
    expect(pop.textContent).not.toContain('Model'); // 模型行去除(pill 在侧,冗余)
    fireEvent.mouseLeave(ring);
    await waitFor(() => expect(document.querySelector('.ctx-pop')).toBeNull());
  });
});

describe('会话流尾部窗口(D48)', () => {
  it('长会话:窗口外条目折叠为「显示更早」头(计数正确),点击步进回放且全部回放后头消失', async () => {
    const many = Array.from({ length: 320 }, (_, i) => ({ seq: i + 1, ts: DAY1, kind: 'user', md: `m${i + 1}` }));
    mountChat(many as unknown as Seed[]);
    await flushed();
    expect(document.querySelectorAll('.entry-user')).toHaveLength(300); // 窗口内全量(D48)
    const earlier = document.querySelector('.chat-earlier')!;
    expect(earlier.textContent).toContain('20'); // 窗口外 20 条
    fireEvent.click(earlier); // 渐进回放:步进 +300 ≥ 20 → 全部回放
    await flushed();
    expect(document.querySelectorAll('.entry-user')).toHaveLength(320);
    expect(document.querySelector('.chat-earlier')).toBeNull(); // 全部回放后头消失
  });
});



describe('G14.31 轮折叠与辅助对话全新视图', () => {
  it('Worked 行点击折叠/展开该轮工具行;chevron 元素恒在(2026-10-24 裁定:完成即自动折叠——初始收合态)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'c1', input: { command: 'ls' } } });
    fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'c1' } });
    fire({ type: 'done', text: 'fin', ts: Date.now(), payload: { steps: 1, tokensUsed: 10 } });
    const runRow = document.querySelector('.entry-run.sealed')!;
    expect(runRow.getAttribute('aria-expanded')).toBe('false'); // done 即自动折叠
    expect(runRow.querySelector('.run-chev')).not.toBeNull();
    // G14.73:工具行保持挂载,包进收起的 seg-collapse(visibility hidden,平滑过渡)
    const collapsedSeg = document.querySelector('.seg-collapse:not(.open)');
    expect(collapsedSeg).not.toBeNull();
    expect(collapsedSeg?.querySelector('.entry-tool')).not.toBeNull();
    fireEvent.click(runRow); // 展开
    expect(runRow.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.seg-collapse.open .entry-tool')).not.toBeNull(); // 再点展开
    fireEvent.click(runRow); // 再收合
    expect(document.querySelector('.seg-collapse:not(.open)')).not.toBeNull();
  });

  it('G14.166 spawn 折叠行带子智能体名(label 优先,回退 agent_id;无名只出动词)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'spawn', ts: Date.now(), payload: { callId: 's1', input: { prompt: 'x', label: '架构分析' } } });
    fire({ type: 'tool-call', text: 'spawn', ts: Date.now(), payload: { callId: 's2', input: { prompt: 'x', agent_id: 'reviewer' } } });
    fire({ type: 'tool-call', text: 'spawn', ts: Date.now(), payload: { callId: 's3', input: { prompt: 'x' } } });
    const rows = [...document.querySelectorAll('.entry-tool')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('架构分析'); // label 同源(时间线卡/委派标签)
    expect(rows[1]!.textContent).toContain('reviewer'); // agent_id 兜底
    expect(rows[2]!.textContent).not.toMatch(/spawn\s+\S/); // 无名:只出动词,不编名
  });

  it('2026-10-24 create_teammate 折叠行带队友名(蓝色链接同 spawn,点击开 agent 页;运行态「正在创建队友 X」)', async () => {
    const onOpenAgent = vi.fn();
    render(<Chat conn={connOf([])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} onOpenAgent={onOpenAgent} />);
    await flushed();
    fire({ type: 'tool-call', text: 'create_teammate', ts: Date.now(), payload: { callId: 'tm1', input: { name: '分析-内核架构', prompt: 'x' } } });
    fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'tm1' } });
    fire({ type: 'tool-call', text: 'create_teammate', ts: Date.now(), payload: { callId: 'tm2', input: { prompt: 'x' } } });
    const rows = [...document.querySelectorAll('.entry-tool')];
    expect(rows).toHaveLength(2);
    const link = rows[0]!.querySelector('.tool-agent-link');
    expect(link).not.toBeNull(); // 同 spawn 的名称链接(tool-agent-link=accent 蓝可点)
    expect(link!.textContent).toContain('分析-内核架构');
    fireEvent.click(link!);
    expect(onOpenAgent).toHaveBeenCalledWith('分析-内核架构', '分析-内核架构', 'x');
    expect(rows[1]!.textContent).toMatch(/创建队友|Creating teammate/); // 无名:只出动词
  });

  it('G14.167 task_wait 折叠行带等待任务名(G14.172 转录自建映射:台账长 id 剥尾/剥前缀命中 create_task 标题;null=全部后台任务)', async () => {
    // 历史/重启场景板投影为空——任务名从转录里的 create_task 回执重建(task tN created → 标题)
    // P11 T7/T8:标题直读 entry.input 字段;任务 id 提取读 result 回执文本(tool md 恒空——夹具 md:'' 钉字段单源)
    mountChat([
      { seq: 1, kind: 'tool', name: 'create_task', input: { title: '分析：TUI 交互面', spec: 'x', dependsOn: null, assignee: null, gated: null, executor: null }, result: { text: 'task t2 created; dispatch is automatic', ok: true }, md: '' },
      { seq: 2, kind: 'tool', name: 'create_task', input: { title: '分析：GUI 交互面', spec: 'y', dependsOn: null, assignee: null, gated: null, executor: null }, result: { text: 'task t3 created; dispatch is automatic', ok: true }, md: '' },
    ] as never);
    await flushed();
    fire({ type: 'tool-call', text: 'task_wait', ts: Date.now(), payload: { callId: 'w1', input: { taskIds: ['t2', 't3'], timeoutSeconds: null } } });
    fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'w1' } });
    fire({ type: 'tool-call', text: 'task_wait', ts: Date.now(), payload: { callId: 'w2', input: { taskIds: ['task-t2-20261015T153105Z-da2n'], timeoutSeconds: null } } });
    fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'w2' } });
    fire({ type: 'tool-call', text: 'task_wait', ts: Date.now(), payload: { callId: 'w3', input: { taskIds: null, timeoutSeconds: 30 } } });
    fire({ type: 'tool-result', text: 'done', ts: Date.now(), payload: { callId: 'w3' } });
    const rows = [...document.querySelectorAll('.entry-tool')].filter((x) => {
      const t = x.textContent ?? '';
      return t.includes('等待') || t.includes('task_wait');
    });
    expect(rows[0]!.textContent).toContain('分析：TUI 交互面, 分析：GUI 交互面'); // 板 id 直查映射
    expect(rows[1]!.textContent).toContain('分析：TUI 交互面'); // 台账长 id 剥尾+剥 task- 前缀命中
    expect(rows[1]!.textContent).not.toContain('task-t2-20261015T153105Z'); // 不显全 id
    expect(rows[2]!.textContent).toMatch(/全部后台任务|all background tasks/); // null 语义本地化
  });

  it('G14.214 task_* 折叠行带任务名(review/gate/cancel/assign/set_dependency 经 taskNameOf;task_stop 完成态取回执 label;set_dependency 双名箭头)', async () => {
    mountChat([
      // P11 T7/T8:标题直读 entry.input 字段;任务 id 提取读 result 回执文本(tool md 恒空——夹具 md:'' 钉字段单源)
      { seq: 1, kind: 'tool', name: 'create_task', input: { title: '架构评审', spec: 'x', dependsOn: null, assignee: null, gated: null, executor: null }, result: { text: 'task t1 created; dispatch is automatic', ok: true }, md: '' },
      { seq: 2, kind: 'tool', name: 'create_task', input: { title: '用例补齐', spec: 'y', dependsOn: null, assignee: null, gated: null, executor: null }, result: { text: 'task t2 created; dispatch is automatic', ok: true }, md: '' },
    ] as never);
    await flushed();
    fire({ type: 'tool-call', text: 'review_task', ts: Date.now(), payload: { callId: 'r1', input: { taskId: 't1', approved: true, note: null } } });
    fire({ type: 'tool-result', text: 'review recorded', ts: Date.now(), payload: { callId: 'r1' } });
    fire({ type: 'tool-call', text: 'task_stop', ts: Date.now(), payload: { callId: 'st1', input: { taskId: 'exec-20261017T101010Z-ab12' } } });
    fire({ type: 'tool-result', text: 'task exec-20261017T101010Z-ab12 stopped (架构分析)', ts: Date.now(), payload: { callId: 'st1' } });
    fire({ type: 'tool-call', text: 'set_dependency', ts: Date.now(), payload: { callId: 'd1', input: { taskId: 't2', dependsOn: 't1' } } });
    fire({ type: 'tool-result', text: 'dependency added', ts: Date.now(), payload: { callId: 'd1' } });
    const rows = [...document.querySelectorAll('.entry-tool')].filter((x) => /review_task|task_stop|set_dependency/.test(x.textContent ?? ''));
    expect(rows).toHaveLength(3);
    // 断言钉折叠壳(.tool-summary)——entry 全量 textContent 含隐藏展开体(原始结果行自带 id,不属折叠行展示面)
    const sum = (i: number): string => rows[i]!.querySelector('.tool-summary')?.textContent ?? '';
    expect(sum(0)).toContain('架构评审'); // 板任务名跟行(转录映射)
    expect(sum(0)).not.toContain('t1'); // 不显裸 id
    expect(sum(1)).toContain('架构分析'); // 后台 id 走回执 label 兜底(非 board 面)
    expect(sum(1)).not.toContain('exec-20261017'); // 不显台账长 id
    expect(sum(2)).toContain('用例补齐'); // set_dependency 双名:任务 ← 依赖目标
    expect(sum(2)).toContain('←');
    expect(sum(2)).toContain('架构评审');
  });

  it('G14.215 相邻同类已完成工具行>1 折为聚合头;点击展开成员平级铺开(原生工具行);计数 1 不聚合', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'read', ts: Date.now(), payload: { callId: 'r1', input: { path: 'a.ts' } } });
    fire({ type: 'tool-result', text: 'aaa', ts: Date.now(), payload: { callId: 'r1' } });
    expect(document.querySelector('.tool-group-head')).toBeNull(); // 计数 1:单行保持
    expect(document.querySelectorAll('.seg-inner > .entry-tool')).toHaveLength(1);
    fire({ type: 'tool-call', text: 'read', ts: Date.now(), payload: { callId: 'r2', input: { path: 'b.ts' } } });
    fire({ type: 'tool-result', text: 'bbb', ts: Date.now(), payload: { callId: 'r2' } });
    const head = document.querySelector('.tool-group-head')!;
    expect(head.textContent).toMatch(/Queried files ×2|查询了 2 次文件/); // 聚合头计数文案
    const members = document.querySelector('.tool-group-members')!;
    expect(members.classList.contains('open')).toBe(false); // 缺省收起
    expect(members.querySelectorAll('.entry-tool')).toHaveLength(2); // 成员挂载但 CSS 收起
    fireEvent.click(head);
    const open = document.querySelector('.tool-group-members.open');
    expect(open).not.toBeNull(); // 点击展开
    expect(open!.querySelectorAll('.entry-tool')).toHaveLength(2); // 成员平级铺开
    expect(open!.querySelector('.entry-tool .tool-summary')).not.toBeNull(); // 成员=原生工具行(折叠壳保持)
    await ghostsSettled();
  });

  it('G14.215 运行中直进组(计数实时增+头流光;2026-10-22 裁定取消「执行行→归并」动作);ghost 只承载完成单行归并', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'e1', input: { command: 'ls' } } });
    fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'e1' } });
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'e2', input: { command: 'pwd' } } });
    fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'e2' } });
    expect(document.querySelector('.tool-group-head')!.textContent).toMatch(/Ran commands ×2|执行了 2 次命令/);
    await ghostsSettled(); // 成组归并 ghost(e1 standalone→member)到点卸载
    expect(document.querySelector('.tool-ghost')).toBeNull();
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'e3', input: { command: 'echo hi' } } });
    // 运行中直进组:计数 ×3 实时增+头流光,无独立行无 ghost(成员行流光标签+命令同行)
    expect(document.querySelector('.tool-group-head')!.textContent).toMatch(/Ran commands ×3|执行了 3 次命令/);
    expect(document.querySelector('.tool-group-head')!.querySelector('.exec-running-text')).not.toBeNull();
    expect(document.querySelectorAll('.tool-group-members .entry-tool')).toHaveLength(3);
    expect(document.querySelectorAll('.seg-inner > .entry-tool')).toHaveLength(0);
    expect(document.querySelector('.tool-ghost')).toBeNull(); // 直进组不经归并动画
    fire({ type: 'tool-result', text: 'hi', ts: Date.now(), payload: { callId: 'e3' } });
    // 完成:计数 ×3 恒定,流光退场
    expect(document.querySelector('.tool-group-head')!.textContent).toMatch(/Ran commands ×3|执行了 3 次命令/);
    expect(document.querySelector('.tool-group-head')!.querySelector('.exec-running-text')).toBeNull();
    expect(document.querySelectorAll('.tool-group-members .entry-tool')).toHaveLength(3);
    expect(document.querySelectorAll('.seg-inner > .entry-tool')).toHaveLength(0);
  });
  it('滚动到顶自动回放(批2):scroll 事件硬顶触发步进,无需点击', async () => {
    const many = Array.from({ length: 320 }, (_, i) => ({ seq: i + 1, ts: DAY1, kind: 'user', md: `auto${i + 1}` }));
    mountChat(many as unknown as Seed[]);
    await flushed();
    expect(document.querySelectorAll('.entry-user')).toHaveLength(300);
    fireEvent.scroll(document.querySelector('.chat')!); // 硬顶 scrollTop=0 触发
    await flushed();
    expect(document.querySelectorAll('.entry-user')).toHaveLength(320);
    expect(document.querySelector('.chat-earlier')).toBeNull();
  });

  it('G14.2xx 流式期间滚轮上翻立即脱离贴底跟随(wheel 意图直判,80px 窗口不再吞滚轮)', async () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 2000 });
    try {
      mountChat([{ seq: 1, ts: DAY1, kind: 'user', md: '你好' }]);
      await flushed();
      const el = document.querySelector('.chat') as HTMLElement;
      // 回归锚:80px 窗口内(距底 50)未上翻时贴底跟随在场——重渲归底拉回
      el.scrollTop = 1450;
      fire({ type: 'token', text: '答1', ts: Date.now() });
      await flushed();
      expect(el.scrollTop).toBe(2000);
      // 滚轮上翻意图:立即放手——后续流式重渲不再拉回(scrollTop 保持用户位置)
      el.scrollTop = 1450;
      fireEvent.wheel(el, { deltaY: -100 });
      fire({ type: 'token', text: '答2', ts: Date.now() });
      await flushed();
      expect(el.scrollTop).toBe(1450);
    } finally {
      delete proto.clientHeight;
      delete proto.scrollHeight;
    }
  });

  it('G14.2xx 流式行结构块实时晋升:表格分隔行落定即渲染 <table>,行到行显;散文尾块保持纯文本', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'token', text: '前置段一。\n\n| 名 | 值 |\n| --- | --- |\n', ts: Date.now() });
    await flushed();
    // 表格骨架实时可见(不再等整块流完才现形)
    expect(document.querySelector('.entry-assistant table')).not.toBeNull();
    fire({ type: 'token', text: '| a | 1 |\n', ts: Date.now() });
    await flushed();
    expect(document.querySelectorAll('.entry-assistant tbody tr')).toHaveLength(1);
    // 散文尾块(未完成段落)保持纯文本直出——不逐行拆段、无半截结构翻转
    fire({ type: 'token', text: '\n\n这是一段还没写完', ts: Date.now() });
    await flushed();
    expect(document.querySelector('.entry-assistant .entry-stream-tail')?.textContent).toBe('这是一段还没写完');
  });

  it('G14.215 禁止重排:非同类行切断分组,组只吃相邻同类(布局顺序=出牌顺序)', async () => {
    mountChat([]);
    await flushed();
    const fireRead = (id: string, p: string): void => {
      fire({ type: 'tool-call', text: 'read', ts: Date.now(), payload: { callId: id, input: { path: p } } });
      fire({ type: 'tool-result', text: 'x', ts: Date.now(), payload: { callId: id } });
    };
    fireRead('r1', 'a.ts');
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'e1', input: { command: 'ls' } } });
    fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'e1' } });
    fireRead('r2', 'b.ts');
    fireRead('r3', 'c.ts');
    await ghostsSettled();
    const kids = [...document.querySelectorAll('.seg-inner > *')];
    expect(kids[0]!.classList.contains('entry-tool')).toBe(true); // read 单行(计数 1)
    expect(kids[1]!.classList.contains('entry-tool')).toBe(true); // exec 独立行(不被吞)
    expect(kids[2]!.classList.contains('tool-group')).toBe(true); // 相邻 read×2 成组
    expect(kids[2]!.querySelectorAll('.tool-group-members .entry-tool')).toHaveLength(2);
    expect(document.querySelectorAll('.tool-group-head')).toHaveLength(1); // 全段仅一组
  });

  it('G14.168 create_task 折叠行带任务名;zh 态动词本地化(en 态原字面;未登记工具回退原名)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'create_task', ts: Date.now(), payload: { callId: 'ct1', input: { title: '架构分析', spec: 'x', dependsOn: null, assignee: null, gated: null, executor: null } } });
    fire({ type: 'tool-result', text: 'created', ts: Date.now(), payload: { callId: 'ct1' } });
    let row = [...document.querySelectorAll('.entry-tool')].at(-1)!;
    expect(row.textContent).toContain('create_task'); // en 态原字面
    expect(row.textContent).toContain('架构分析'); // 任务名跟行
    // zh 态:已渲染行不回溯,新入行即中文化
    setLanguage('zh');
    try {
      fire({ type: 'tool-call', text: 'create_task', ts: Date.now(), payload: { callId: 'ct2', input: { title: '测试构建', spec: 'y', dependsOn: null, assignee: null, gated: null, executor: null } } });
      fire({ type: 'tool-result', text: 'created', ts: Date.now(), payload: { callId: 'ct2' } });
      row = [...document.querySelectorAll('.entry-tool')].at(-1)!;
      expect(row.textContent).toContain('创建任务'); // G14.216 命名口径(替代「建单」两字压缩)
      expect(row.textContent).toContain('测试构建');
      // 未登记工具(MCP 面)回退原名不硬翻
      fire({ type: 'tool-call', text: 'mcp_foo_bar', ts: Date.now(), payload: { callId: 'm1', input: {} } });
      fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'm1' } });
      row = [...document.querySelectorAll('.entry-tool')].at(-1)!;
    expect(row.textContent).toContain('mcp_foo_bar');
    } finally {
      setLanguage('en');
    }
  });

  it('G14.171 spawn 行子智能体名=蓝色链接,点击上抛 onOpenAgent(label, title)', async () => {
    const onOpenAgent = vi.fn();
    const first = render(<Chat conn={connOf([])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} onOpenAgent={onOpenAgent} />);
    await flushed();
    fire({ type: 'tool-call', text: 'spawn', ts: Date.now(), payload: { callId: 'sp1', input: { prompt: 'x', label: '分析：架构与运行时装配' } } });
    fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'sp1' } });
    const link = document.querySelector('.tool-agent-link');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('分析：架构与运行时装配');
    fireEvent.click(link!);
    expect(onOpenAgent).toHaveBeenCalledWith('分析：架构与运行时装配', '分析：架构与运行时装配', 'x'); // G14.175 第三参=spawn prompt
    first.unmount();
    // 无 onOpenAgent(测试桩缺省):回落纯文本不渲染链接
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'spawn', ts: Date.now(), payload: { callId: 'sp2', input: { prompt: 'x', label: '分析' } } });
    fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'sp2' } });
    expect(document.querySelector('.tool-agent-link')).toBeNull();
  });

  it('freshView:种子历史不落屏(辅助对话全新视图)', async () => {
    render(
      <Chat
        conn={connOf([
          { seq: 1, kind: 'user', md: '旧问题' },
          { seq: 2, kind: 'assistant', md: '旧回答' },
        ])}
        sessionId="s1"
        connState="open"
        onBack={() => {}}
        sinkRef={sinkRef}
        freshView
      />,
    );
    await flushed();
    expect(document.querySelectorAll('.chat .entry')).toHaveLength(0);
  });
});

describe('G14.41 write 行 diffstat 保留', () => {
  it('write 行:路径省略时 +N -M 仍在行尾(宽度保留,不随省略消失)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'write', ts: Date.now(), payload: { callId: 'w1', input: { path: 'D:/very/long/path/sunshine-repo-path.md', content: 'x' } } });
    fire({ type: 'tool-result', text: 'written +1 -0', ts: Date.now(), payload: { callId: 'w1' } });
    expect(document.querySelector('.tool-stat-add')?.textContent).toContain('+1');
    expect(document.querySelector('.tool-stat-del')?.textContent).toContain('-0');
    // 路径省略(ellipsis 类在场)不影响 stat 渲染
    expect(document.querySelector('.tool-file-base')?.className).toContain('tool-file-base');
  });
});


describe('G14.177 顶栏动态计数按钮', () => {
  it('运行中+待办未完成>0 → 显「N 待办」按钮,点击 onOpenTab(tasks);全完成(0)不渲染;G14.213 轮次收束即隐(未完结也隐)', async () => {
    const onOpenTab = vi.fn();
    const seeds = [
      { seq: 1, kind: 'tool', md: '', name: 'todo_write', input: { todos: [{ text: '已完成项', status: 'completed' }, { text: '进行中项', status: 'in_progress' }, { text: '等待项', status: 'pending' }] }, result: { text: 'ok', ok: true } },
    ] as never;
    const first = render(<Chat conn={connOf(seeds, 'running')} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} onOpenTab={onOpenTab} />);
    await flushed();
    const btn = document.querySelector('.chat-dyn-btn');
    expect(btn?.textContent).toMatch(/2 (todos|待办)/); // 测试语言态双语 // 未完成=in_progress+pending
    fireEvent.click(btn!);
    expect(onOpenTab).toHaveBeenCalledWith('tasks');
    // 全完成:末批 0 未完成 → 按钮隐(不占位)
    first.unmount();
    const done = [
      { seq: 1, kind: 'tool', md: '', name: 'todo_write', input: { todos: [{ text: '已完成项', status: 'completed' }] }, result: { text: 'ok', ok: true } },
    ] as never;
    render(<Chat conn={connOf(done, 'running')} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} onOpenTab={onOpenTab} />);
    await flushed();
    expect(document.querySelector('.chat-dyn-btn')).toBeNull();
    // G14.213 轮次收束(idle)即隐:待办未完结也隐
    first.unmount();
    render(<Chat conn={connOf(seeds, 'idle')} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} onOpenTab={onOpenTab} />);
    await flushed();
    expect(document.querySelector('.chat-dyn-btn')).toBeNull();
  });
});

describe('G14.181 用户气泡限高折叠', () => {
  it('超高默认折叠+底部浮钮,点击展开/收起;短气泡不受影响', async () => {
    const longMd = '很长的用户输入。'.repeat(120);
    // jsdom 无布局:钉 scrollHeight=500 触发量测(>168+8)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 500 });
    try {
      const first = render(<Chat conn={connOf([{ seq: 1, kind: 'user', md: longMd } as never])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
      await flushed();
      expect(document.querySelector('.user-bubble-clamped')).not.toBeNull(); // 默认折叠
      expect(document.querySelector('.user-bubble-toggle-row')).not.toBeNull(); // 气泡下侧展开钮行(G14.202)
      expect(document.querySelector('.user-bubble-float')).toBeNull(); // 复制钮归 user-actions 行(浮钮组退役,G14.202)
      fireEvent.click(screen.getByLabelText('Expand'));
      expect(document.querySelector('.user-bubble-clamped')).toBeNull(); // 展开
      expect(document.querySelector('.user-bubble-open')).not.toBeNull(); // G14.206e 展开态气泡底部留位(浮钮内侧不遮末行)
      fireEvent.click(screen.getByLabelText('Collapse'));
      expect(document.querySelector('.user-bubble-clamped')).not.toBeNull(); // 再收起
      expect(document.querySelector('.user-bubble-open')).toBeNull(); // 收起后留位撤销
      first.unmount();
    } finally {
      delete (HTMLElement.prototype as unknown as { scrollHeight?: unknown }).scrollHeight;
    }
    // 短气泡:无折叠无浮钮
    render(<Chat conn={connOf([{ seq: 1, kind: 'user', md: '继续' } as never])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed();
    expect(document.querySelector('.user-bubble-clamped')).toBeNull();
    expect(document.querySelector('.user-bubble-toggle')).toBeNull();
  });
});

describe('顶栏 ⋯ 会话操作菜单(2026-10-22)', () => {
  it('⋯ 钮弹菜单:归档会话项调 archiveSession(true) 且徽标换面;已归档时项变取消归档', async () => {
    const archiveSession = vi.fn(() => Promise.resolve());
    const snapOf = (archived: boolean): unknown => ({
      messages: [],
      status: 'idle',
      openRun: -1,
      openSeg: -1,
      board: { tasks: [] },
      delegations: [],
      team: [],
      pending: [],
      lastSeq: 0,
      archived,
    });
    const appPins = vi.fn(async () => ({ pins: [] }));
    const saveAppPins = vi.fn(async () => undefined);
    // —— 未归档(快照 archived:false):⋯ 钮 → 菜单「Archive session」→ archiveSession(id,true) + 徽标换面 ——
    const conn = connOf([]);
    (conn as unknown as Record<string, unknown>).archiveSession = archiveSession;
    (conn as unknown as Record<string, unknown>).sessionSnapshot = () => Promise.resolve(snapOf(false));
    (conn as unknown as Record<string, unknown>).appPins = appPins;
    (conn as unknown as Record<string, unknown>).saveAppPins = saveAppPins;
    const first = render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed(); // 播种落定(archived 播种已应用,确认击不发播种竞态)
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    expect((screen.getByRole('menuitem', { name: 'Pin session' }) as HTMLButtonElement).disabled).toBe(false); // 未归档:置顶可调节
    fireEvent.click(screen.getByText('Archive session'));
    fireEvent.click(screen.getByText('Confirm archive')); // 二次弹窗确认(2026-10-23 用户裁定)
    expect(archiveSession).toHaveBeenCalledWith('s1', true);
    expect(await screen.findByText('Archived')).toBeTruthy(); // 本地 archived 同步 → 徽标即刻换面
    first.unmount();
    // —— 已归档(快照 archived:true):徽标在;菜单项变「Unarchive session」→ archiveSession(id,false) ——
    const conn2 = connOf([]);
    (conn2 as unknown as Record<string, unknown>).archiveSession = archiveSession;
    (conn2 as unknown as Record<string, unknown>).sessionSnapshot = () => Promise.resolve(snapOf(true));
    (conn2 as unknown as Record<string, unknown>).appPins = appPins;
    (conn2 as unknown as Record<string, unknown>).saveAppPins = saveAppPins;
    render(<Chat conn={conn2} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    expect(await screen.findByText('Archived')).toBeTruthy();
    expect(document.querySelector('.sx-archived-badge')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    // 已归档冻结置顶态(2026-10-22 用户裁定):Pin session 项禁用,取消归档后才可调节
    expect((screen.getByRole('menuitem', { name: 'Pin session' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Unarchive session'));
    expect(archiveSession).toHaveBeenCalledWith('s1', false);
  });

  it('置顶即已读(2026-10-23 用户裁定):已读戳与钉档同刻写入,钉组不再亮未读', async () => {
    const conn = connOf([]);
    (conn as unknown as Record<string, unknown>).appPins = vi.fn(async () => ({ pins: [] }));
    (conn as unknown as Record<string, unknown>).saveAppPins = vi.fn(async () => undefined);
    const saveAppSeen = vi.fn(async () => undefined);
    (conn as unknown as Record<string, unknown>).saveAppSeen = saveAppSeen;
    render(<Chat conn={conn} sessionId="s1" journalId="j1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await flushed();
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByText('Pin session'));
    await flushed();
    await flushed(); // 置顶链多代微任务(pins PUT → seen PUT)
    const seen = JSON.parse(window.localStorage.getItem('sunshinex.seen-sessions') ?? '{}') as Record<string, number>;
    expect(typeof seen.j1).toBe('number'); // 已读戳已压到钉档时刻
    expect(saveAppSeen).toHaveBeenCalledTimes(1); // 落底层双写
  });
});

describe('P1 行级 memo render-count(Task 3):token 突发/交错帧已落位 tool 行零重渲染', () => {
  it('token 突发期间已落位 tool 行零重渲染', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'tool-call', text: 'read', ts: Date.now(), payload: { callId: 'c1', input: { path: 'src/a.ts' } } });
    fire({ type: 'tool-result', text: 'content', ts: Date.now(), payload: { callId: 'c1' } });
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'c2', input: { command: 'ls' } } });
    fire({ type: 'tool-result', text: 'file1', ts: Date.now(), payload: { callId: 'c2' } });
    await flushed();
    expect(document.querySelectorAll('.tool-summary').length).toBe(2); // 两行已落位(exec 行=计数缝载体)
    hlCounters.__reset();
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        fire({ type: 'token', text: `答案第${i}段。`, ts: Date.now() });
      });
    }
    expect(hlCounters.__calls()).toBe(0); // memo 全程 bail-out——exec 行体内的 highlightCode 零调用
  });

  it('流式中折叠 run 后续 token 帧不击穿隐藏 tool 行 memo(交错帧)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'c1', input: { command: 'ls' } } });
    fire({ type: 'tool-result', text: 'file1', ts: Date.now(), payload: { callId: 'c1' } });
    fire({ type: 'token', text: '前文。', ts: Date.now() });
    await act(async () => {
      fire({ type: 'done', ts: Date.now(), payload: { steps: 2 } });
    });
    await flushed();
    await flushed(); // sealed 自动折叠(useAutoCollapseRuns)落定
    expect(document.querySelector('.tool-summary')).not.toBeNull(); // 隐藏行仍挂载(G14.31)
    hlCounters.__reset();
    fire({ type: 'model-start', ts: Date.now() }); // 新成员帧:骨架重算但折叠组身份不变
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        fire({ type: 'token', text: `次轮${i}。`, ts: Date.now() });
      });
    }
    expect(hlCounters.__calls()).toBe(0); // 折叠隐藏的 exec 行不因后续帧重渲染
  });
});
