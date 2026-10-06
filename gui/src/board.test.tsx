import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Board } from './pages/Board';
import type { BoardTask, TaskBoardState } from './projection';
import type { Delegation } from './projection';
import { createConnection } from './connection';

/**
 * G5 Board 页组件测:List 行形态(id [status] title (needs →) @w + gated ⚠/行内 Approve/
 * Deny)、DAG svg(盒数/连线数/gated 描边钩子/done 透明度钩子)、视图切换、teammate 侧栏
 * busy 点、delegations 简列;连接面(boardReview URL/body、newSession mode body)以
 * fetch 桩钉口径(与 connection.test 同法,归属 Board 消费面)。
 */

const task = (id: string, over: Partial<BoardTask> = {}): BoardTask => ({
  id,
  title: `任务${id}`,
  spec: '',
  status: 'pending',
  dependsOn: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const boardOf = (tasks: BoardTask[], seq = tasks.length): TaskBoardState => ({
  tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  seq,
});
const del = (over: Partial<Delegation> = {}): Delegation => ({
  id: 'd1',
  kind: 'subagent',
  label: 'dev worker',
  status: 'running',
  startedAt: 1,
  ...over,
});

const noop = (): void => {};

describe('Board:List 视图', () => {
  it('任务行形态:t1 [pending] 任务t1 (needs t2) @w1;status 颜色钩子', () => {
    render(
      <Board
        board={boardOf([task('t1', { dependsOn: ['t2'], assignee: 'w1' }), task('t2')])}
        delegations={[]}
        team={[]}
        onReview={noop}
        onBack={noop}
      />,
    );
    const row = screen.getByText('t1 [pending] 任务t1 (needs t2) @w1');
    expect(row.className).toContain('task-status-pending'); // status 颜色钩
  });

  it('多依赖文字箭头:needs t2 → t3', () => {
    render(
      <Board
        board={boardOf([task('t1', { dependsOn: ['t2', 't3'] }), task('t2'), task('t3')])}
        delegations={[]}
        team={[]}
        onReview={noop}
        onBack={noop}
      />,
    );
    expect(screen.getByText('t1 [pending] 任务t1 (needs t2 → t3)')).toBeDefined();
  });

  it('gated 行:⚠ 高亮 + 行内 Approve/Deny → onReview(taskId, true/false);非 gated 行无按钮', () => {
    const reviews: Array<[string, boolean]> = [];
    render(
      <Board
        board={boardOf([task('t1', { gated: true }), task('t2')])}
        delegations={[]}
        team={[]}
        onReview={(taskId, approved) => reviews.push([taskId, approved])}
        onBack={noop}
      />,
    );
    expect(screen.getByText('t1 [pending] 任务t1 ⚠')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Approve t1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny t1' }));
    expect(reviews).toEqual([
      ['t1', true],
      ['t1', false],
    ]);
    expect(screen.queryByRole('button', { name: 'Approve t2' })).toBeNull();
  });

  it('空板:占位提示(List/DAG 两视图同防御)', () => {
    render(<Board board={boardOf([])} delegations={[]} team={[]} onReview={noop} onBack={noop} />);
    expect(screen.getByText(/任务板为空/)).toBeDefined();
  });
});

describe('Board:DAG 视图(svg)', () => {
  const diamond = boardOf([
    task('a'),
    task('b', { dependsOn: ['a'] }),
    task('c', { dependsOn: ['a'], gated: true }),
    task('d', { dependsOn: ['b', 'c'], status: 'done' }),
  ]);

  const openDag = (): HTMLElement => {
    const base = render(<Board board={diamond} delegations={[]} team={[]} onReview={noop} onBack={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'DAG' }));
    const svg = document.querySelector('svg.board-dag') as HTMLElement | null;
    expect(svg).not.toBeNull();
    return base.container;
  };

  it('盒数=任务数(a/b/c/d 四 g);连线数=dependsOn 现存边数(a→b,a→c,b→d,c→d 四线)', () => {
    const container = openDag();
    expect(container.querySelectorAll('g.task-box')).toHaveLength(4);
    expect(container.querySelectorAll('line.dag-edge')).toHaveLength(4);
  });

  it('gated 盒描边高亮钩子(gated class);done 盒降透明度钩子(done class)', () => {
    const container = openDag();
    expect(container.querySelector('g.task-box.gated')).not.toBeNull(); // c
    expect(container.querySelector('g.task-box.done')).not.toBeNull(); // d
  });

  it('svg 尺寸随布局:width=最大 x+180、height=最大 y+100', () => {
    const container = openDag();
    // 菱形布局:a(0,0) b(0,90) c(160,90) d(0,180)——max x=160、max y=180
    const svg = container.querySelector('svg.board-dag') as SVGSVGElement;
    expect(svg.getAttribute('width')).toBe(String(160 + 180));
    expect(svg.getAttribute('height')).toBe(String(180 + 100));
  });

  it('盒内文本:id + title', () => {
    const container = openDag();
    const g = container.querySelector('g[data-task="a"]') as HTMLElement | null;
    expect(g?.textContent).toContain('a');
    expect(g?.textContent).toContain('任务a');
  });
});

describe('Board:视图切换与顶栏', () => {
  it('缺省 List;DAG/List 按钮切换(aria-pressed);返回 Chat(onBack)', () => {
    let back = 0;
    render(<Board board={boardOf([task('t1')])} delegations={[]} team={[]} onReview={noop} onBack={() => (back += 1)} />);
    expect(document.querySelector('svg.board-dag')).toBeNull(); // 缺省 List
    expect((screen.getByRole('button', { name: 'List' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'DAG' }));
    expect(document.querySelector('svg.board-dag')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'DAG' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(document.querySelector('svg.board-dag')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /返回 Chat/ }));
    expect(back).toBe(1);
  });
});

describe('Board:teammate 侧栏与 delegations 简列', () => {
  it('侧栏行 name + busy 点(busy 色钩);delegations 行 label+status', () => {
    render(
      <Board
        board={boardOf([])}
        delegations={[del(), del({ id: 'd2', label: 'probe', status: 'done' })]}
        team={[
          { name: 'w1', busy: true },
          { name: 'w2', busy: false },
        ]}
        onReview={noop}
        onBack={noop}
      />,
    );
    const sidebar = screen.getByLabelText('team');
    expect(sidebar.textContent).toContain('w1');
    expect(sidebar.textContent).toContain('w2');
    expect(sidebar.querySelectorAll('.team-dot.busy')).toHaveLength(1); // busy 点色钩子
    const dels = screen.getByLabelText('delegations');
    expect(dels.textContent).toContain('dev worker');
    expect(dels.textContent).toContain('running');
    expect(dels.textContent).toContain('probe');
    expect(dels.textContent).toContain('done');
  });
});

/* ===== 连接面(boardReview/newSession mode)——fetch 桩钉 URL/method/body ===== */

interface RespLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
const ok = (json: unknown = {}): RespLike => ({ ok: true, status: 200, json: async () => json });

describe('Board 消费的连接面:boardReview 与 newSession mode(fetch 桩)', () => {
  const fetchLog: Array<{ url: string; init: RequestInit | undefined }> = [];
  let fetchQueue: RespLike[] = [];

  beforeEach(() => {
    fetchQueue = [];
    fetchLog.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchLog.push({ url, init });
        const r = fetchQueue.shift();
        if (r === undefined) throw new Error(`test: unexpected fetch ${url}`);
        return r;
      }),
    );
    vi.stubGlobal('WebSocket', class {
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close(): void {}
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('boardReview:POST /session/:id/board/review body {taskId,approved};路径编码;非 2xx 抛错含 status', async () => {
    fetchQueue.push(ok(), ok(), { ok: false, status: 400, json: async () => ({}) });
    const conn = createConnection({ baseUrl: 'http://127.0.0.1:7788', token: 'tok', onEvent: () => {}, onReset: () => {} });
    await conn.boardReview('s 1', 't1', true);
    await conn.boardReview('s1', 't2', false);
    expect(fetchLog.map((f) => f.url)).toEqual([
      'http://127.0.0.1:7788/session/s%201/board/review',
      'http://127.0.0.1:7788/session/s1/board/review',
    ]);
    expect(fetchLog[0]?.init?.method).toBe('POST');
    expect(fetchLog[0]?.init?.body).toBe(JSON.stringify({ taskId: 't1', approved: true }));
    expect(fetchLog[1]?.init?.body).toBe(JSON.stringify({ taskId: 't2', approved: false }));
    await expect(conn.boardReview('s1', 't3', true)).rejects.toThrow('/session/s1/board/review -> 400');
  });

  it('newSession mode 面:缺省不发 mode;manual/dontAsk 入 body', async () => {
    fetchQueue.push(ok({ sessionId: 's1' }), ok({ sessionId: 's2' }), ok({ sessionId: 's3' }));
    const conn = createConnection({ baseUrl: 'http://x', token: 't', onEvent: () => {}, onReset: () => {} });
    await conn.newSession('/w'); // 缺省:body 只 root
    await conn.newSession('/w', 'manual');
    await conn.newSession('/w', 'dontAsk');
    expect(fetchLog.map((f) => f.init?.body)).toEqual([
      JSON.stringify({ root: '/w' }),
      JSON.stringify({ root: '/w', mode: 'manual' }),
      JSON.stringify({ root: '/w', mode: 'dontAsk' }),
    ]);
  });
});
