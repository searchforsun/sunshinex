import { describe, test, expect, vi } from 'vitest';
// 语言钉 en(2026-11-11):本文件起**真 daemon**,App 挂载即拉 GET /settings——language 槽读
// process.env(SUNSHINEX_LANGUAGE),缺省未设时 GUI 模块缺省 zh(G14.104 产品缺省)与断言面
// 的英文文案('Files rewound' 等)互相踩;且 daemon 读真实用户全局 settings.json(非密闭),
// 用户设置页切过语言即漂。env 先于 daemon 装配钉死 en,断言面稳定
process.env.SUNSHINEX_LANGUAGE = 'en';
vi.mock('monaco-editor', () => ({
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
}));
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  Editor: () => null,
  DiffEditor: () => null,
}));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
// @ts-expect-error dist 发布形态(tsc 不发声明,同 e2e.test.ts)
import { GuiDaemon } from '../../dist/serve/daemon';
// @ts-expect-error dist 发布形态(tsc 不发声明,同 e2e.test.ts)
import { ScriptedAdapter } from '../../dist/model/adapter';
import { App } from './App';

const write = (p: string, content: string): string => JSON.stringify({ tool: 'write', input: { path: p, content } });
const done = (reply: string): string => JSON.stringify({ done: true, reply });

function userTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.entry-user .user-md-plain')].map((n) => n.textContent ?? '');
}

/** 模型响应留出真实间隔:提交回执须先于 run 收束到达(Chat 的等待待态只认 run-open 之后的条目) */
class PacedAdapter {
  readonly provider = 'paced-e2e';
  private readonly inner: { chat(req: unknown): Promise<unknown> };
  constructor(replies: string[]) {
    this.inner = new ScriptedAdapter(replies);
  }
  async chat(req: unknown): Promise<unknown> {
    await new Promise((r) => setTimeout(r, 150));
    return this.inner.chat(req);
  }
}

describe('编辑发送全链路:真 daemon + App(2026-11-05)', () => {
  // 真 daemon 全链重型用例:满载并发(64 文件并行 worker+各自 daemon)下耗时不可控,retry 兜底偶发超时
  test('二次确认 → 回退会话和文件 → 正文/文件/页签回到该点 → 编辑文本重发,列表只留一条会话', { retry: 2, timeout: 90_000 }, async () => {
    vi.stubGlobal('WebSocket', NodeWebSocket);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-e2e-rewind-'));
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
    const prevLanguage = process.env.SUNSHINEX_LANGUAGE;
    process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
    process.env.SUNSHINEX_LANGUAGE = 'en';
    // 机器级指针档隔离(2026-11-09:app-state 面活读 HOME,不隔离则 lastRoot 写进真实家目录——e2e.test 同修)
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const daemon = new GuiDaemon({ model: new PacedAdapter([write('a.txt', 'v1'), done('答一'), write('a.txt', 'v2'), write('b.txt', 'new'), done('答二'), done('答三')]) });
    const s = await daemon.start({ port: 0 });
    try {
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${s.port}`);
      // localStorage 开屏清档(2026-11-13):retry 复用同一 jsdom origin——欢迎页选择持久化
      // (sx-welcome:project)跨 retry 存活,上一把的同 basename 项目('root')会让 line-73 的
      // 「项目条显 root」就绪信号在 adoptWorkspace 落定前假真,提交落在已删的旧根上
      localStorage.clear();
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 });
      Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' }));
      await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 15_000 });
      const goal = screen.getByLabelText('welcome goal');
      fireEvent.change(goal, { target: { value: '问一' } });
      fireEvent.keyDown(goal, { key: 'Enter' });
      await waitFor(() => expect(container.textContent).toContain('答一'), { timeout: 15_000 });
      await waitFor(() => expect(container.querySelector('.run-live-line')).toBeNull(), { timeout: 15_000 });
      await waitFor(() => expect(container.querySelector('button[aria-label="send"]')).not.toBeNull(), { timeout: 15_000 });

      const input = screen.getByLabelText('message input');
      fireEvent.change(input, { target: { value: '问二' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => { if (!container.textContent!.includes('答二')) throw new Error('未到答二: ' + container.querySelector('.sx-main')?.textContent?.slice(0, 400) + ' input=' + (input as HTMLTextAreaElement).value); }, { timeout: 15_000 });
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('v2');
      expect(fs.existsSync(path.join(root, 'b.txt'))).toBe(true);
      await waitFor(() => expect(container.querySelector('.run-live-line')).toBeNull(), { timeout: 15_000 });

      // 被丢弃轮打开的 Diff 页签:回退后应随时间线消失
      const writeRow = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').includes('b.txt'));
      fireEvent.click(writeRow!);
      await waitFor(() => expect(container.querySelector('.tool-path[aria-label="b.txt"]')).not.toBeNull(), { timeout: 15_000 });
      fireEvent.click(container.querySelector('.tool-path[aria-label="b.txt"]')!);
      await waitFor(() => expect([...container.querySelectorAll('.sx-tab')].some((t) => (t.textContent ?? '').includes('b.txt'))).toBe(true), { timeout: 15_000 });

      fireEvent.click(screen.getAllByRole('button', { name: 'Edit' }).at(-1)!);
      fireEvent.change(screen.getByRole('textbox', { name: 'edit message' }), { target: { value: '改后的问二' } });
      fireEvent.click(screen.getByRole('button', { name: 'send edit' }));

      // 确认前什么都没发生
      const dialog = await screen.findByRole('dialog', undefined, { timeout: 15_000 });
      await waitFor(() => expect(dialog.textContent).toContain('b.txt'), { timeout: 15_000 });
      expect(dialog.textContent).toContain('a.txt');
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('v2');

      fireEvent.click(screen.getByRole('button', { name: 'Rewind session and files' }));
      await waitFor(() => expect(container.textContent).toContain('答三'), { timeout: 15_000 });

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(userTexts(container)).toEqual(['问一', '改后的问二']);
      expect(container.textContent).not.toContain('答二');
      expect(container.textContent).toContain('Files rewound');
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('v1');
      expect(fs.existsSync(path.join(root, 'b.txt'))).toBe(false);

      expect([...container.querySelectorAll('.sx-tab')].some((t) => (t.textContent ?? '').includes('b.txt'))).toBe(false);

      const res = await fetch(`http://127.0.0.1:${s.port}/sessions?root=${encodeURIComponent(root)}`);
      const rows = (await res.json()) as Array<{ id: string; title?: string; firstUser?: string }>;
      expect(rows).toHaveLength(1);
    } finally {
      await s.close();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
      else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
      if (prevLanguage === undefined) delete process.env.SUNSHINEX_LANGUAGE;
      else process.env.SUNSHINEX_LANGUAGE = prevLanguage;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
