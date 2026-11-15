import { describe, expect, it, vi, beforeEach } from 'vitest';
// mermaid/monaco stub(images-flow.test 同款:jsdom 无渲染管线,EntryViews 经 ../Chat 拉重依赖)
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
import { fireEvent, render } from '@testing-library/react';
import { RunEntryView } from './EntryViews';
import { setLanguage } from '../../i18n';

/** bg-wake 批F(spec §6):run 行唤醒前缀——只有任务名可点(bg:/板路由,stopPropagation 不触发折叠),
 *  「后台任务」「唤醒」恒静态,无名整行无点击元素;live/sealed 两态都拼前缀。
 *  语言约定:chat-reducer.test 同款 beforeEach 钉 en(防跨文件用例语言泄漏),断言走英文面。 */

beforeEach(() => setLanguage('en'));

const base = { seq: 3, ts: Date.now(), kind: 'run' as const, md: '', key: 'k3' };

describe('RunEntryView 唤醒前缀（bg-wake spec §6）', () => {
  it('有名：前缀「Woken by background task 构建前端」（蓝色任务名、无 {} 包裹、英文无尾部 wake 词）+ 既有 sealed 文案；点任务名发 bg 路由且不触发折叠（鼠标+键盘）', () => {
    const onToggle = vi.fn();
    const onOpenTask = vi.fn();
    const { getByText, container } = render(
      <RunEntryView
        entry={{ ...base, seconds: 12 }}
        wake={[{ id: 'x1', name: '构建前端' }]}
        onToggle={onToggle}
        onOpenTask={onOpenTask}
      />,
    );
    expect(container.textContent).toMatch(/Woken by background task 构建前端/); // 英文有名形态=task {名}（spec §6.3）
    expect(container.textContent).not.toContain('wake'); // 尾部 wake 词是中文直译残留，英文列没有它
    expect(getByText(/Woken by background task/)).toBeTruthy(); // 「后台任务」段恒纯文本(正则匹配拼接行)
    const name = getByText('构建前端');
    fireEvent.click(name);
    expect(onOpenTask).toHaveBeenCalledWith('bg:x1'); // bg 路由
    expect(container.textContent).not.toContain('{'); // 名字无 {} 包裹(2026-11-14 用户验收裁定)
    expect(onToggle).not.toHaveBeenCalled(); // stopPropagation 不触发折叠
    fireEvent.keyDown(name, { key: 'Enter' }); // 键盘同道:不冒泡触发折叠
    expect(onOpenTask).toHaveBeenLastCalledWith('bg:x1');
    expect(onToggle).not.toHaveBeenCalled();
        expect(container.querySelector('.entry-run.wake-start')).not.toBeNull(); // 轮次开头 30px 上距(fork-origin 同款口径)
expect(getByText(/Worked for/)).toBeTruthy(); // 既有 sealed 文案原样在场
  });

  it('板任务名点击走板路由', () => {
    const onOpenTask = vi.fn();
    const { getByText } = render(
      <RunEntryView entry={{ ...base, seconds: 3 }} wake={[{ id: 'l1', name: '修复登录', board: true, boardRef: 'task-t3' }]} onOpenTask={onOpenTask} />,
    );
    fireEvent.click(getByText('修复登录'));
    expect(onOpenTask).toHaveBeenCalledWith('task-t3');
  });

  it('无名：通用形态整行无点击元素；「后台任务」恒为纯文本', () => {
    const onOpenTask = vi.fn();
    const { getByText, queryByRole, container } = render(<RunEntryView entry={{ ...base, seconds: 5 }} wake={[{ id: 'x2' }]} onOpenTask={onOpenTask} />);
    expect(getByText(/Woken by background task/)).toBeTruthy();
    expect(queryByRole('button', { name: 'Woken by background task' })).toBeNull();
        expect(container.querySelector('.entry-run.wake-start')).not.toBeNull(); // 无名也是唤醒轮开头
expect(container.querySelector('.wake-name')).toBeNull(); // 无名=整行无点击元素
    fireEvent.click(getByText(/Woken by background task/));
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it('live 态：前缀 + 既有「运行中」拼接', () => {
    const { getByText } = render(<RunEntryView entry={{ ...base, streaming: true }} wake={[{ id: 'x1', name: '构建前端' }]} />);
    expect(getByText(/Woken by background task/)).toBeTruthy();
    expect(getByText('构建前端')).toBeTruthy();
    expect(getByText(/Working/)).toBeTruthy();
  });
});

describe('RunEntryView 定时唤醒前缀（2026-11-15 sunx P2 Task 3,fix round 2:文案迁显示层——scheduled 行有前缀,普通行零变化）', () => {
  it('scheduled:前缀「Scheduled wake」整行静态（无点击元素/无任务名段）+ 既有 sealed 文案拼接 + wake-start 轮距', () => {
    const onToggle = vi.fn();
    const { getByText, queryByRole, container } = render(
      <RunEntryView entry={{ ...base, seconds: 7 }} scheduled onToggle={onToggle} />,
    );
    expect(getByText(/Scheduled wake/)).toBeTruthy(); // 前缀在场（纯件零 i18n 钉后文案归宿=显示层）
    expect(getByText(/Worked for/)).toBeTruthy(); // 既有 sealed 文案原样拼接
    expect(queryByRole('button', { name: 'Scheduled wake' })).toBeNull(); // 整行静态无点击
    expect(container.querySelector('.wake-name')).toBeNull(); // 无任务名段
    expect(container.querySelector('.entry-run.wake-start')).not.toBeNull(); // 唤醒族轮开头同款轮距
    expect(onToggle).not.toHaveBeenCalled(); // 前缀静态不触发折叠
  });

  it('live 态:前缀 + 「Working」拼接', () => {
    const { getByText } = render(<RunEntryView entry={{ ...base, streaming: true }} scheduled />);
    expect(getByText(/Scheduled wake/)).toBeTruthy();
    expect(getByText(/Working/)).toBeTruthy();
  });

  it('zh 语言:「定时唤醒」(t() 双语,调用时求值)', () => {
    setLanguage('zh');
    const { getByText } = render(<RunEntryView entry={{ ...base, seconds: 2 }} scheduled />);
    expect(getByText('定时唤醒')).toBeTruthy();
    setLanguage('en'); // 还原（beforeEach 钉 en 防跨文件泄漏）
  });

  it('普通 run（无 wake 无 scheduled）:零前缀零变化（两态钉之对侧）', () => {
    const { container, queryByText, getByText } = render(<RunEntryView entry={{ ...base, seconds: 5 }} />);
    expect(container.querySelector('.wake-prefix')).toBeNull();
    expect(container.querySelector('.entry-run.wake-start')).toBeNull();
    expect(queryByText(/Scheduled wake/)).toBeNull();
    expect(queryByText(/Woken by background task/)).toBeNull();
    expect(getByText(/Worked for/)).toBeTruthy();
  });

  it('wake 与 scheduled 互斥:wake 在场时 scheduled 不双拼', () => {
    const { container, getByText } = render(
      <RunEntryView entry={{ ...base, seconds: 5 }} wake={[{ id: 'x1', name: '构建前端' }]} scheduled />,
    );
    expect(getByText(/Woken by background task/)).toBeTruthy();
    expect(container.textContent).not.toContain('Scheduled wake'); // 一轮只属一族
  });
});
